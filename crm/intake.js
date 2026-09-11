/* ============================================================================
   Northwest Town Car Service — CRM intake
   ----------------------------------------------------------------------------
   Turns one funnel submission into a set of CRM upserts. Platform-agnostic:
   it returns plain "upsert operations" that a Make / Zapier code step, an
   Airtable script, or a serverless function applies to whatever CRM you use.

   It does NOT talk to any CRM itself — you provide `findCustomer` (and the
   caller applies the returned ops). This keeps the dedup + status logic in one
   tested place regardless of platform.

   INPUT: the `payload` object POSTed by homepage-redesign/booking-funnel/index.html:
     {
       reference: "NWTC-260902-4821",
       kind: "reservation" | "quote-request" | "corporate-lead",
       submittedAt: ISO string,
       values: { service, zone|.., pickup, dropoff, pPickup, pDropoff, hours,
                 hourlyStart, date, time, returnDate, returnTime, passengers,
                 bags, vehicle, flight, stops, childSeats, meetGreet, notes,
                 name, phone, email, company, volume, corpUse, title, consent },
       quote: { method, finalAmount, lineItems } | "corporate",
       source: URL string,
       gclid:  optional — the Google Ads click id, if the site persisted it
               across the session and handed it to the funnel (see the ads plan
               §7). Falls back to parsing gclid/wbraid/gbraid out of `source`.
     }

   OUTPUT: { ops: [ {table, matchOn, fields, op} ], summary }
     op          "upsert" (match then update-or-create) | "create"
     matchOn     field the applier should dedupe on (e.g. {Phone: "12065550148"})
     fields      the record body
   Apply ops in array order — later ops reference earlier records by the
   dedupe key, so Customer comes before Lead comes before Booking.
   ========================================================================== */
(function (global) {
  'use strict';

  var QUOTE_EXPIRES_HOURS = 72;

  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function normPhone(s) {
    var d = digits(s);
    if (d.length === 10) d = '1' + d;          // assume US
    return d;
  }
  function first(v) { return Array.isArray(v) ? v[0] : v; }
  function pick(v, dflt) { return v == null || v === '' ? dflt : v; }
  function addHours(iso, h) {
    var t = new Date(iso || Date.now());
    return new Date(t.getTime() + h * 3600e3).toISOString();
  }

  /* Source / campaign / ad click id from the funnel's `source` URL (utm_*, gclid).
     A caller can also pass an explicit gclid on the payload — that wins, since the
     site should persist it across the session and hand it to the funnel. */
  function parseSource(url, explicitGclid) {
    var out = { source: 'website', medium: 'organic', campaign: '', term: '', gclid: '' };
    try {
      var u = new URL(url);
      var p = u.searchParams;
      if (p.get('utm_source')) out.source = p.get('utm_source');
      if (p.get('utm_medium')) out.medium = p.get('utm_medium');
      if (p.get('utm_campaign')) out.campaign = p.get('utm_campaign');
      if (p.get('utm_term')) out.term = p.get('utm_term');
      out.gclid = explicitGclid || p.get('gclid') || p.get('wbraid') || p.get('gbraid') || '';
      if (!p.get('utm_source') && out.gclid) { out.source = 'google'; out.medium = 'cpc'; }
      if (!p.get('utm_source') && u.hostname) out.landing = u.hostname + u.pathname;
    } catch (e) {
      out.gclid = explicitGclid || '';
    }
    return out;
  }

  function routeText(v) {
    if (v.service === 'Hourly / as-directed') return (pick(v.hourlyStart, '?')) + ' — ' + pick(v.hours, '?') + ' hrs';
    if (/Airport/.test(v.service || '')) return pick(v.pickup, '?') + ' → ' + pick(v.dropoff, '?');
    return pick(v.pPickup, v.pickup || '?') + ' → ' + pick(v.pDropoff, v.dropoff || '?');
  }

  /**
   * @param {object} payload  funnel submission (see header)
   * @param {object} [opts]
   * @param {function} [opts.findCustomer]  (phone, email) => existingCustomer|null
   *                                        used only to decide create vs. update wording;
   *                                        the applier still dedupes on matchOn.
   * @param {string}   [opts.now]           ISO timestamp override (tests)
   */
  function funnelPayloadToCRM(payload, opts) {
    opts = opts || {};
    var now = opts.now || new Date().toISOString();
    var v = payload.values || {};
    var kind = payload.kind || 'quote-request';
    var q = payload.quote && payload.quote !== 'corporate' ? payload.quote : null;
    // Prefer the analytics module's resolved attribution (first/last-touch aware)
    // when the funnel sent it; fall back to parsing the landing URL.
    var src = payload.attribution && payload.attribution.source
      ? {
          source: payload.attribution.source,
          medium: payload.attribution.medium || '',
          campaign: payload.attribution.campaign || '',
          term: payload.attribution.term || '',
          gclid: payload.attribution.gclid || payload.gclid || '',
          landing: payload.attribution.landingPage || ''
        }
      : parseSource(payload.source, payload.gclid);
    var phoneKey = normPhone(v.phone);
    var email = (v.email || '').trim().toLowerCase();

    var ops = [];

    /* ---------- 1. Customer (dedupe on phone, fallback email) ---------- */
    var customerMatch = phoneKey ? { Phone: phoneKey } : { Email: email };
    ops.push({
      table: 'Customers',
      op: 'upsert',
      matchOn: customerMatch,
      fields: {
        Name: v.name || '',
        Phone: phoneKey,
        Email: email,
        'Home Area': v.zone && v.zone !== 'other' ? v.zone : '',
        'Marketing Opt-in': v.consent === 'yes',
        'Last Contact': now
        // First Trip / Last Trip / Trip Count / Lifetime Value are rollups — don't set here
      }
    });

    /* ---------- 2. Corporate Account (corporate leads only) ---------- */
    var corpMatch = null;
    if (kind === 'corporate-lead') {
      corpMatch = { Company: (v.company || '').trim() };
      ops.push({
        table: 'Corporate Accounts',
        op: 'upsert',
        matchOn: corpMatch,
        fields: {
          Company: (v.company || '').trim(),
          'Billing Contact': v.name || '',
          'Contact Phone': phoneKey,
          'Contact Email': email,
          'Contact Role': v.title || '',
          Stage: 'Prospect',
          'Monthly Volume': v.volume || '',
          'Primary Use': v.corpUse || '',
          'Discount Tier': 'standard',
          Source: src.source
        }
      });
    }

    /* ---------- 3. Lead (idempotent on funnel Reference) ---------- */
    var status, quoteMethod;
    if (kind === 'reservation') { status = 'Booked'; quoteMethod = q ? q.method : 'flat'; }
    else if (kind === 'corporate-lead') { status = 'New'; quoteMethod = 'corporate'; }
    else { // quote-request
      quoteMethod = q ? q.method : 'manual-quote';
      status = (quoteMethod === 'flat' || quoteMethod === 'hourly') ? 'Quote Sent' : 'New';
    }

    ops.push({
      table: 'Leads',
      op: 'upsert',
      matchOn: { Reference: payload.reference },
      fields: {
        Reference: payload.reference,
        Created: payload.submittedAt || now,
        Name: v.name || '',
        Phone: phoneKey,
        Email: email,
        Service: v.service || '',
        'Service Area': v.zone === 'other' ? 'Other WA area' : (v.zone || ''),
        Route: routeText(v),
        Pickup: v.pickup || v.pPickup || v.hourlyStart || '',
        'Drop-off': v.dropoff || v.pDropoff || '',
        Date: v.date || '',
        Time: v.time || '',
        Passengers: toInt(v.passengers),
        Vehicle: v.vehicle || '',
        'Flight #': v.flight || '',
        'Quote Method': quoteMethod,
        'Quoted Amount': q ? q.finalAmount : null,
        'Quote Expires': q && !q.needsManualQuote && q.finalAmount != null ? addHours(payload.submittedAt || now, QUOTE_EXPIRES_HOURS) : null,
        Status: status,
        Source: src.source,
        Medium: src.medium,
        Campaign: src.campaign,
        Term: src.term || '',
        GCLID: src.gclid || '',
        'Landing Page': src.landing || '',
        'Next Follow-up': status === 'Quote Sent' ? addHours(payload.submittedAt || now, 3) : null,
        Notes: v.notes || '',
        Consent: v.consent === 'yes',
        'Payment Preference': v.paymentPreference === 'cash' ? 'cash' : 'card',
        'Raw Payload': safeJson(payload),
        _linkCustomer: customerMatch,          // applier resolves link from the matched Customer
        _linkCorporate: corpMatch || undefined
      }
    });

    /* ---------- 4. Quote record (priced or manual) ---------- */
    if (kind !== 'corporate-lead') {
      ops.push({
        table: 'Quotes',
        op: 'upsert',
        matchOn: { Reference: payload.reference },
        fields: {
          Reference: payload.reference,
          Method: quoteMethod,
          Total: q ? q.finalAmount : null,
          'Line Items': q ? safeJson(q.lineItems) : '',
          Status: kind === 'reservation' ? 'Accepted'
                : quoteMethod === 'manual-quote' ? 'Draft' : 'Sent',
          'Sent At': quoteMethod === 'manual-quote' ? null : (payload.submittedAt || now),
          'Valid Until': q && q.finalAmount != null ? addHours(payload.submittedAt || now, QUOTE_EXPIRES_HOURS) : null,
          _linkLead: { Reference: payload.reference }
        }
      });
    }

    /* ---------- 5. Booking (reservations only) ---------- */
    if (kind === 'reservation') {
      ops.push({
        table: 'Bookings',
        op: 'upsert',
        matchOn: { Reference: payload.reference },
        fields: {
          Reference: payload.reference,
          Service: v.service || '',
          Pickup: v.pickup || v.pPickup || v.hourlyStart || '',
          'Drop-off': v.dropoff || v.pDropoff || '',
          Stops: toInt(v.stops),
          'Child Seats': toInt(v.childSeats),
          Date: v.date || '',
          Time: v.time || '',
          'Return Date': v.returnDate || '',
          'Return Time': v.returnTime || '',
          Passengers: toInt(v.passengers),
          Bags: toInt(v.bags),
          'Vehicle Class': v.vehicle || '',
          'Flight #': v.flight || '',
          Price: q ? q.finalAmount : null,
          'Deposit Paid': 0,
          'Payment Preference': v.paymentPreference === 'cash' ? 'cash' : 'card',
          Status: 'Reserved',
          'Special Requests': v.notes || '',
          'Pricing Breakdown': q ? safeJson(q.lineItems) : '',
          _linkCustomer: customerMatch,
          _linkTrip: null
        }
      });
    }

    /* ---------- 6. Activity log ---------- */
    ops.push({
      table: 'Activity Log',
      op: 'create',
      fields: {
        Timestamp: now,
        'Record Type': 'Lead',
        'Record Ref': payload.reference,
        Event: 'intake:' + kind,
        Detail: quoteMethod + (q && q.finalAmount != null ? ' $' + q.finalAmount : '') + ' from ' + src.source,
        Actor: 'system'
      }
    });

    return {
      ops: ops,
      summary: {
        reference: payload.reference,
        kind: kind,
        leadStatus: status,
        quoteMethod: quoteMethod,
        amount: q ? q.finalAmount : null,
        customerKey: customerMatch,
        createsBooking: kind === 'reservation',
        source: src.source
      }
    };
  }

  function toInt(x) { var n = parseInt(x, 10); return isNaN(n) ? null : n; }
  function safeJson(o) { try { return JSON.stringify(o); } catch (e) { return ''; } }

  var api = { funnelPayloadToCRM: funnelPayloadToCRM, normPhone: normPhone, parseSource: parseSource };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NWTCIntake = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
