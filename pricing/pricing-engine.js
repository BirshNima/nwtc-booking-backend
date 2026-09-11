/* ============================================================================
   Northwest Town Car Service — pricing engine v1
   ----------------------------------------------------------------------------
   Pure, dependency-free. The SAME function runs in the browser (to show a
   price) and on the server (to validate it). The server is authoritative:
   never trust a price sent by the client — recompute it with verifyQuote().

   Usage:
     const q = NWTCPricing.quote(request, table);      // -> itemized breakdown
     const v = NWTCPricing.verifyQuote(clientTotal, request, table);

   `request` fields (all optional unless noted):
     service        'airport' | 'hourly' | 'point-to-point' | 'cruise'
                    | 'wedding' | 'event' | 'crew'                     (required)
     direction      'from-airport' | 'to-airport'    (airport trips)
     zone           service-area name, must match table.airportFlatRates.zones
     isAirportLeg   true for a point-to-point/cruise trip that has a SEA leg
     vehicleClass   key of table.vehicleClasses                       (required)
     hours          number (hourly service)
     stops          integer  additional stops
     childSeats     integer
     waitMinutes    integer  total expected wait
     gratuityPct    number   customer's choice (only honored if the table allows)
     passThroughEstimate  { parking: n, tolls: n }   non-binding estimate
     account        { corporateTier, contractRate, fixedGratuityPct }
                    -- MUST be populated server-side from the authenticated
                       account, never from client input
     adminOverrideAmount  number  -- a dispatch-set special quote; server-only

   Returns an object with: method ('flat'|'hourly'|'manual-quote'),
   lineItems[], baseRate, addOns, waiting, discount, fees, tax, gratuity,
   passThrough, finalAmount, needsManualQuote, notes[].
   ========================================================================== */
(function (global) {
  'use strict';

  function round(n) { return Math.round(Number(n) || 0); }
  function money(n) { return Math.max(0, round(n)); }
  function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

  function tierFor(table, vehicleClass) {
    var vc = table.vehicleClasses && table.vehicleClasses[vehicleClass];
    return vc ? vc.airportTier || null : null;
  }

  function flatRate(table, zone, tier) {
    var z = table.airportFlatRates && table.airportFlatRates.zones[zone];
    return z && z[tier] != null ? z[tier] : null;
  }

  function describeRoute(req) {
    if (req.service === 'hourly') return 'Hourly / as-directed';
    if (req.service === 'airport') {
      return req.direction === 'to-airport'
        ? (req.zone || '?') + ' → SEA'
        : 'SEA → ' + (req.zone || '?');
    }
    if (req.pickup || req.dropoff) return (req.pickup || '?') + ' → ' + (req.dropoff || '?');
    return cap(req.service || 'trip');
  }

  function method(req, table) {
    var svc = req.service;
    var manual = table.manualQuoteServices || [];
    if (manual.indexOf(svc) !== -1) return 'manual-quote';
    if (svc === 'hourly') {
      return (table.hourly.rates[req.vehicleClass]) ? 'hourly' : 'manual-quote';
    }
    var wantsFlat = svc === 'airport' || ((svc === 'point-to-point' || svc === 'cruise') && req.isAirportLeg);
    if (wantsFlat) {
      var tier = tierFor(table, req.vehicleClass);
      if (tier && flatRate(table, req.zone, tier) != null) return 'flat';
      return 'manual-quote';
    }
    return 'manual-quote';
  }

  function manualReason(req, table) {
    var svc = req.service;
    if ((table.manualQuoteServices || []).indexOf(svc) !== -1)
      return cap(svc) + ' bookings are priced individually. Dispatch will send a full quote.';
    if (svc === 'airport' || req.isAirportLeg) {
      if (!tierFor(table, req.vehicleClass))
        return 'Vans and Sprinters to or from the airport are priced by manual quote.';
      return 'No flat rate is set for "' + (req.zone || 'that area') + '". Dispatch will quote it.';
    }
    return 'This route does not have a flat rate. Choose hourly service or request a quote.';
  }

  function quote(req, table) {
    req = req || {};
    var m = method(req, table);
    var out = {
      version: table.version,
      currency: table.currency || 'USD',
      method: m,
      vehicleClass: req.vehicleClass || null,
      vehicleLabel: (table.vehicleClasses[req.vehicleClass] || {}).label || req.vehicleClass || null,
      route: describeRoute(req),
      lineItems: [],
      baseRate: 0, addOns: 0, waiting: 0, discount: 0,
      fees: 0, tax: 0, gratuity: 0, passThrough: 0,
      finalAmount: null,
      quoteExpiresHours: (table.rules && table.rules.quoteExpiresHours) || 72,
      needsManualQuote: m === 'manual-quote',
      notes: []
    };
    if (m === 'manual-quote') {
      out.notes.push(manualReason(req, table));
      return out;
    }

    var isAirport = req.service === 'airport' || !!req.isAirportLeg;
    var acct = req.account || null;
    var hasOverride = req.adminOverrideAmount != null;
    var hasContract = !!(acct && acct.contractRate != null);

    // ---------- base rate ----------
    var base = 0, baseLabel = '';
    if (hasOverride) {
      base = money(req.adminOverrideAmount);
      baseLabel = 'Agreed rate (dispatch)';
      out.notes.push('Administrator special quote applied — corporate discounts do not stack on top.');
    } else if (hasContract) {
      base = money(acct.contractRate);
      baseLabel = 'Contract rate';
    } else if (m === 'flat') {
      var tier = tierFor(table, req.vehicleClass);
      base = flatRate(table, req.zone, tier);
      baseLabel = out.route + ' — flat ' + tier + ' rate';
    } else { // hourly
      var hr = table.hourly.rates[req.vehicleClass];
      var asked = Number(req.hours) || hr.minHours;
      var billed = Math.max(asked, hr.minHours);
      base = billed * hr.hourly;
      baseLabel = out.vehicleLabel + ' — ' + billed + ' hrs @ $' + hr.hourly + '/hr'
        + (billed > asked ? ' (' + hr.minHours + '-hr minimum)' : '');
      out._billedHours = billed;
    }
    base = money(base);
    out.baseRate = base;
    out.lineItems.push({ code: 'base', label: baseLabel, amount: base });

    // ---------- add-ons ----------
    var addOns = 0;
    var stops = Math.max(0, parseInt(req.stops || 0, 10));
    if (stops > 0) {
      var each = table.addOns.additionalStop.amount;
      var c = money(stops * each);
      addOns += c;
      out.lineItems.push({ code: 'stops', label: stops + ' additional stop' + (stops > 1 ? 's' : '') + ' @ $' + each, amount: c });
    }
    var seats = Math.max(0, parseInt(req.childSeats || 0, 10));
    if (seats > 0) {
      var se = table.addOns.childSeat.amount;
      var cs = money(seats * se);
      addOns += cs;
      out.lineItems.push({ code: 'child-seat', label: seats + ' child seat' + (seats > 1 ? 's' : '') + ' @ $' + se, amount: cs });
    }
    out.addOns = addOns;

    // ---------- waiting ----------
    var wait = 0;
    var wm = Math.max(0, parseInt(req.waitMinutes || 0, 10));
    if (wm > 0) {
      var free = isAirport ? table.waiting.airportFreeMinutes : table.waiting.nonAirportFreeMinutes;
      var billable = Math.max(0, wm - free);
      if (billable > 0) {
        wait = money(billable * table.waiting.extraWaitPerMinute);
        out.lineItems.push({
          code: 'waiting',
          label: billable + ' min extra wait @ $' + Number(table.waiting.extraWaitPerMinute).toFixed(2) + '/min (' + free + ' min included)',
          amount: wait
        });
      }
    }
    out.waiting = wait;

    var serviceSubtotal = base + addOns + wait;

    // ---------- discount (account-controlled, never stacked) ----------
    var discount = 0;
    if (!hasOverride && !hasContract && acct && acct.corporateTier) {
      var tc = table.corporateTiers[acct.corporateTier];
      if (tc && tc.discountPct) {
        discount = -money(serviceSubtotal * tc.discountPct / 100);
        out.lineItems.push({ code: 'discount', label: tc.label + ' account — ' + tc.discountPct + '% off', amount: discount });
      }
    }
    out.discount = discount;
    var discounted = serviceSubtotal + discount;

    // ---------- fees ----------
    var fees = 0;
    var fuelPct = (table.fees && table.fees.fuelSurchargePct) || 0;
    if (fuelPct) { var fs = money(discounted * fuelPct / 100); fees += fs; out.lineItems.push({ code: 'fuel', label: 'Fuel surcharge ' + fuelPct + '%', amount: fs }); }
    var bf = (table.fees && table.fees.bookingFee) || 0;
    if (bf) { bf = money(bf); fees += bf; out.lineItems.push({ code: 'booking-fee', label: 'Booking fee', amount: bf }); }
    out.fees = fees;

    // ---------- tax ----------
    var tax = 0;
    var taxPct = (table.tax && table.tax.pct) || 0;
    if (taxPct) {
      tax = money((discounted + fees) * taxPct / 100);
      out.lineItems.push({ code: 'tax', label: (table.tax.label || 'Tax') + ' ' + taxPct + '%', amount: tax });
    }
    out.tax = tax;

    // ---------- gratuity ----------
    var gPct = table.gratuity.defaultPct;
    if (acct && acct.fixedGratuityPct != null) gPct = acct.fixedGratuityPct;
    else if (table.gratuity.editableByCustomer && req.gratuityPct != null) gPct = Number(req.gratuityPct);
    gPct = Math.max(0, Number(gPct) || 0);
    var gratuity = money(discounted * gPct / 100);
    if (gratuity > 0 || table.gratuity.includedInQuote) {
      out.lineItems.push({ code: 'gratuity', label: 'Gratuity ' + gPct + '%', amount: gratuity });
    }
    out.gratuity = gratuity;

    // ---------- pass-through (estimate only) ----------
    var pt = 0;
    if (req.passThroughEstimate) {
      Object.keys(req.passThroughEstimate).forEach(function (k) {
        var v = money(req.passThroughEstimate[k]);
        if (v > 0) {
          pt += v;
          out.lineItems.push({ code: 'passthrough', label: cap(k) + ' (estimate — billed at cost)', amount: v });
        }
      });
    }
    out.passThrough = pt;

    out.finalAmount = base + addOns + wait + discount + fees + tax + gratuity + pt;
    return out;
  }

  /* Server-side guard: does the client's total match a fresh calculation? */
  function verifyQuote(clientFinalAmount, req, table, tolerance) {
    tolerance = tolerance == null ? 0.01 : tolerance;
    var server = quote(req, table);
    var client = Number(clientFinalAmount);
    var valid = server.finalAmount != null && Math.abs(server.finalAmount - client) <= tolerance;
    return {
      valid: valid,
      method: server.method,
      serverAmount: server.finalAmount,
      clientAmount: client,
      delta: server.finalAmount == null ? null : +(server.finalAmount - client).toFixed(2),
      breakdown: server
    };
  }

  /* Convenience for building a price grid / SEO tables from the source of truth */
  function airportMatrix(table) {
    var zones = table.airportFlatRates.zones;
    return Object.keys(zones).map(function (name) {
      return { zone: name, sedan: zones[name].sedan, suv: zones[name].suv };
    });
  }

  var api = { quote: quote, verifyQuote: verifyQuote, airportMatrix: airportMatrix, _round: round };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NWTCPricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
