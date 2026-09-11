/* ============================================================================
   Northwest Town Car Service — messages  (revenue-core step 5: SMS + email)
   ----------------------------------------------------------------------------
   Pure and dependency-free. Every customer-facing message lives here as one
   template, and `plan(trigger, ctx)` decides which messages a CRM event should
   produce — channel, when, and the merge vars — without sending anything.

   send.js takes that plan and delivers it. sequences.js drives the day 0/1/3/7
   quote follow-up. index.html is the blueprint.

     NWTCComms.plan(trigger, ctx)   -> [ {id, channel, to, sendAt, vars} ]
     NWTCComms.render(id, vars)     -> { subject?, text }
     NWTCComms.quietHoursShift(iso) -> iso pushed out of 20:00–08:00 PT

   CHANNEL POLICY (launch runbook, decision 5):
     transactional (confirmations, reminders, receipts)  -> SMS + email
     quote follow-up day 0 / day 1                        -> SMS
     quote follow-up day 3 / day 7                        -> email
   Marketing/win-back is a separate opt-in list, not handled here.
   ========================================================================== */
(function (global) {
  'use strict';

  var BRAND = 'Northwest Town Car Service';
  var PHONE = '(206) 596-5504';
  var PHONE_E164 = '+12065965504';
  var FROM_EMAIL = 'book@northwesttowncarservice.com';
  var SIGN = '— ' + BRAND + ', ' + PHONE;
  var STOP_LINE = 'Reply STOP to opt out.';

  var QUIET_START = 20;   // 20:00 PT
  var QUIET_END = 8;      // 08:00 PT
  var TZ_OFFSET_MIN = -420; // PT is UTC-7 (PDT). Recompute if you need year-round DST accuracy.

  /* ---------------------------------------------------------------- templates
     text(vars) -> string.  subject(vars) -> string (email only).
     Keep SMS bodies under ~320 chars (2 segments). No links the customer can't
     act on; every link is one the CRM row actually holds. */
  var T = {

    /* ---- acknowledgements (fired on Lead created) ---- */
    'ack.reservation.sms': {
      channels: ['sms'],
      text: function (v) {
        return 'Thanks ' + first(v.name) + " — we've got your reservation " + v.reference +
          ' for ' + v.dateShort + '. Dispatch confirms the driver and sends your deposit link shortly. ' + SIGN;
      }
    },
    'ack.reservation.email': {
      channels: ['email'],
      subject: function (v) { return 'Reservation ' + v.reference + ' received — ' + v.serviceLabel; },
      text: function (v) {
        return [
          'Hi ' + first(v.name) + ',',
          '',
          "We've received your reservation. Here's what you asked for:",
          '',
          block(v),
          '',
          v.priceText ? ('Quoted total: ' + v.priceText + ' (held ' + (v.holdHours || 72) + ' hours).') : '',
          '',
          'Next: dispatch confirms the vehicle and driver, then emails and texts you a secure link for the deposit. No card is needed until then.',
          '',
          'Questions? Just reply, or call ' + PHONE + '.',
          '',
          SIGN
        ].filter(function (l) { return l !== undefined; }).join('\n');
      }
    },
    'ack.quote.sms': {
      channels: ['sms'],
      text: function (v) {
        return 'Hi ' + first(v.name) + ", thanks for the request (" + v.reference + '). ' +
          (v.instant
            ? 'Your quote: ' + v.priceText + '. Reply YES to reserve, or call ' + PHONE + '. '
            : "We're pricing it now and will send a written quote within the hour. ") + SIGN;
      }
    },
    'ack.quote.email': {
      channels: ['email'],
      subject: function (v) { return (v.instant ? 'Your quote' : 'Your quote request') + ' — ' + v.reference; },
      text: function (v) {
        return [
          'Hi ' + first(v.name) + ',',
          '',
          v.instant
            ? 'Here is your quote for ' + v.serviceLabel + ':'
            : "Thanks for your request. Here's what we have; a written quote follows within the hour.",
          '',
          block(v),
          '',
          v.instant && v.priceText ? ('Total: ' + v.priceText + '  (valid ' + (v.holdHours || 72) + ' h)') : '',
          v.instant ? 'Reply to this email or text YES to ' + PHONE + ' to reserve.' : '',
          '',
          SIGN
        ].filter(function (l) { return l !== undefined; }).join('\n');
      }
    },
    'ack.corporate.email': {
      channels: ['email'],
      subject: function () { return 'Your corporate account request — ' + BRAND; },
      text: function (v) {
        return [
          'Hi ' + first(v.name) + ',',
          '',
          'Thanks for your interest in a corporate account for ' + (v.company || 'your team') + '.',
          'A specialist will call you at ' + v.phone + ' within one business day to set up rates, billing, and logins for your bookers.',
          '',
          SIGN
        ].join('\n');
      }
    },

    /* ---- deposit (fired when /deposit-link returns a URL) ---- */
    'deposit.request.sms': {
      channels: ['sms'],
      text: function (v) {
        return BRAND + ': your ride ' + v.reference + ' on ' + v.dateShort + ' is confirmed pending a ' +
          v.depositText + ' deposit' + (v.appliesToFare ? ' (applied to your fare)' : '') +
          '. Pay securely: ' + v.checkoutUrl + '  ' + STOP_LINE;
      }
    },
    'deposit.request.email': {
      channels: ['email'],
      subject: function (v) { return 'Confirm your ride — deposit for ' + v.reference; },
      text: function (v) {
        return [
          'Hi ' + first(v.name) + ',',
          '',
          'Your ride is confirmed pending the deposit:',
          '',
          block(v),
          '',
          'Deposit: ' + v.depositText + (v.appliesToFare ? '  (credited against your fare)' : ''),
          v.balanceText ? ('Balance after the trip: ' + v.balanceText) : '',
          'Refundable up to ' + (v.refundHours || 24) + ' h before pickup.',
          '',
          'Pay securely (card entered on Stripe, never on our site):',
          v.checkoutUrl,
          '',
          SIGN
        ].filter(function (l) { return l !== undefined; }).join('\n');
      }
    },
    /* ---- cash bookings (fired when /deposit-link resolves to cash) ---- */
    'cash.confirmed.sms': {
      channels: ['sms'],
      text: function (v) {
        return BRAND + ': ' + v.reference + ' is confirmed for ' + v.dateShort +
          '. Please have ' + v.cashText + ' in cash ready for your driver at the end of the trip. ' + SIGN;
      }
    },
    'cash.confirmed.email': {
      channels: ['email'],
      subject: function (v) { return 'Booked — ' + v.reference + ' (paying cash)'; },
      text: function (v) {
        return [
          'Hi ' + first(v.name) + ',',
          '',
          'Your ride is confirmed. You chose to pay the driver in cash:',
          '',
          block(v),
          '',
          'Amount due to the driver: ' + v.cashText + ', in cash, at the end of the trip.',
          "We'll send your driver's name, phone, and vehicle 24 hours before pickup.",
          '',
          'Prefer to pay by card instead? Just reply and we\'ll send a secure link.',
          '',
          SIGN
        ].join('\n');
      }
    },

    'deposit.received.sms': {
      channels: ['sms'],
      text: function (v) {
        return 'Payment received — ' + v.reference + ' is fully booked for ' + v.dateShort +
          '. Driver and vehicle details 24 h before pickup. ' + SIGN;
      }
    },
    'deposit.received.email': {
      channels: ['email'],
      subject: function (v) { return 'Booked — ' + v.reference + ' (' + v.dateShort + ')'; },
      text: function (v) {
        return [
          'Hi ' + first(v.name) + ',',
          '',
          'Your deposit is in and ' + v.reference + ' is confirmed.',
          '',
          block(v),
          '',
          v.balanceText ? ('Balance due after the trip: ' + v.balanceText + '.') : '',
          "We'll send your driver's name, phone, and vehicle 24 hours before pickup.",
          '',
          SIGN
        ].filter(function (l) { return l !== undefined; }).join('\n');
      }
    },

    /* ---- reminder (fired 24 h before pickup, once Trip has a driver) ---- */
    'reminder.sms': {
      channels: ['sms'],
      text: function (v) {
        return BRAND + ' tomorrow: ' + v.timeShort + ' pickup at ' + v.pickupShort + '. ' +
          'Your chauffeur ' + v.driverName + ' (' + v.driverPhone + ') in a ' + v.vehicleText + '. ' +
          (v.flight ? 'Tracking ' + v.flight + '. ' : '') +
          (v.cashText ? 'Please have ' + v.cashText + ' cash ready for the driver. ' : '') + SIGN;
      }
    },
    'reminder.email': {
      channels: ['email'],
      subject: function (v) { return 'Your ride tomorrow — ' + v.timeShort + ' — ' + v.reference; },
      text: function (v) {
        return [
          'Hi ' + first(v.name) + ',',
          '',
          'A reminder for tomorrow:',
          '',
          block(v),
          '',
          'Chauffeur: ' + v.driverName + ', ' + v.driverPhone,
          'Vehicle:   ' + v.vehicleText,
          v.flight ? ('Flight:    ' + v.flight + ' (we track it — no need to adjust for delays)') : '',
          v.cashText ? ('Payment:   ' + v.cashText + ' in cash to the driver at the end of the trip') : '',
          '',
          'Meeting point: ' + (v.meetNote || 'your chauffeur will text on arrival.'),
          '',
          SIGN
        ].filter(function (l) { return l !== undefined; }).join('\n');
      }
    },

    /* ---- after the trip ---- */
    'trip.thanks.sms': {
      channels: ['sms'],
      text: function (v) {
        return 'Thanks for riding with ' + BRAND + ' today, ' + first(v.name) + '. ' +
          (v.balanceText ? ('Your balance of ' + v.balanceText + ' will be charged to the card on file. ') : '') +
          'We hope to drive you again. ' + SIGN;
      }
    },
    'review.request.sms': {
      channels: ['sms'],
      text: function (v) {
        return 'Hi ' + first(v.name) + ', how was your ride with ' + BRAND + '? ' +
          'If we did well, a quick review helps a lot: ' + v.reviewUrl + '  ' + STOP_LINE;
      }
    },
    'review.request.email': {
      channels: ['email'],
      subject: function () { return 'How was your ride?'; },
      text: function (v) {
        return [
          'Hi ' + first(v.name) + ',',
          '',
          'Thanks again for choosing ' + BRAND + '. If the trip met the bar, would you leave a short review? It genuinely helps a small local business.',
          '',
          v.reviewUrl,
          '',
          "If anything fell short, reply here instead — it comes straight to the owner.",
          '',
          SIGN
        ].join('\n');
      }
    },

    /* ---- quote follow-up sequence (sequences.js) ---- */
    'followup.d0.sms': {
      channels: ['sms'],
      text: function (v) {
        return 'Hi ' + first(v.name) + ', your ' + BRAND + ' quote for ' + v.serviceLabel +
          ' is ' + v.priceText + ', good through ' + v.validShort + '. Reply YES to lock it in. ' + SIGN;
      }
    },
    'followup.d1.sms': {
      channels: ['sms'],
      text: function (v) {
        return 'Still need a car for ' + v.dateShort + '? Your quote (' + v.priceText + ') is held until ' +
          v.validShort + '. Reply YES or call ' + PHONE + '. ' + SIGN;
      }
    },
    'followup.d3.email': {
      channels: ['email'],
      subject: function (v) { return 'Your quote for ' + v.dateShort + ' — held until ' + v.validShort; },
      text: function (v) {
        return [
          'Hi ' + first(v.name) + ',',
          '',
          "Just making sure this didn't get buried. Your quote:",
          '',
          block(v),
          'Total: ' + v.priceText + '  (held until ' + v.validShort + ')',
          '',
          'Reply to reserve, or call ' + PHONE + '. If plans changed, a one-line reply tells us to stop following up.',
          '',
          SIGN
        ].join('\n');
      }
    },
    'followup.d7.email': {
      channels: ['email'],
      subject: function () { return 'Last note about your quote'; },
      text: function (v) {
        return [
          'Hi ' + first(v.name) + ',',
          '',
          "This is the last time we'll email about this one. If you still need the ride on " + v.dateShort +
            ', we can honor ' + v.priceText + ' — just reply. Otherwise no worries, and we hope to help another time.',
          '',
          SIGN
        ].join('\n');
      }
    },

    /* ---- payment trouble (escalates to human after 2nd failure) ---- */
    'payment.failed.sms': {
      channels: ['sms'],
      text: function (v) {
        return BRAND + ': the deposit for ' + v.reference + " didn't go through. Try again here: " +
          v.checkoutUrl + '  We hold the booking 24 h. ' + SIGN;
      }
    }
  };

  /* --------------------------------------------------------------- plan() */
  var TRIGGERS = {
    'lead.created.reservation': ['ack.reservation.sms', 'ack.reservation.email'],
    'lead.created.quote':       ['ack.quote.sms', 'ack.quote.email'],
    'lead.created.corporate':   ['ack.corporate.email'],
    'deposit.link.created':     ['deposit.request.sms', 'deposit.request.email'],
    'booking.cash.confirmed':   ['cash.confirmed.sms', 'cash.confirmed.email'],
    'deposit.paid':             ['deposit.received.sms', 'deposit.received.email'],
    'trip.reminder':            ['reminder.sms', 'reminder.email'],
    'trip.completed':           ['trip.thanks.sms'],
    'review.requested':         ['review.request.sms', 'review.request.email'],
    'payment.failed':           ['payment.failed.sms']
  };

  /**
   * @param {string} trigger  key of TRIGGERS
   * @param {object} ctx
   *   {
   *     vars,                  merge vars for the templates
   *     contact: { phone, email, smsConsent, emailConsent, optedOut },
   *     sendAt,                ISO; default now. Reminders pass pickup-24h.
   *     only                   optional ['sms'|'email'] to restrict channels
   *   }
   * @returns {Array} messages ready for send.js
   */
  function plan(trigger, ctx) {
    ctx = ctx || {};
    var ids = TRIGGERS[trigger] || [];
    var c = ctx.contact || {};
    var when = ctx.sendAt || new Date().toISOString();
    var out = [];

    ids.forEach(function (id) {
      var tpl = T[id];
      if (!tpl) return;
      var channel = tpl.channels[0];
      if (ctx.only && ctx.only.indexOf(channel) === -1) return;

      if (channel === 'sms') {
        if (!c.phone || c.optedOut || c.smsConsent === false) return;
        out.push({
          id: id, channel: 'sms', to: c.phone,
          sendAt: quietHoursShift(when),
          vars: ctx.vars || {},
          dedupeKey: (ctx.vars && ctx.vars.reference || '') + ':' + id
        });
      } else if (channel === 'email') {
        if (!c.email) return;
        out.push({
          id: id, channel: 'email', to: c.email, from: FROM_EMAIL,
          sendAt: when,                                   // email ignores quiet hours
          vars: ctx.vars || {},
          dedupeKey: (ctx.vars && ctx.vars.reference || '') + ':' + id
        });
      }
    });
    return out;
  }

  function render(id, vars) {
    var tpl = T[id];
    if (!tpl) throw new Error('unknown template ' + id);
    vars = vars || {};
    var r = { text: tpl.text(vars) };
    if (tpl.subject) r.subject = tpl.subject(vars);
    if (tpl.channels[0] === 'sms') r.segments = Math.ceil(r.text.length / 153) || 1;
    return r;
  }

  /* push a timestamp out of quiet hours (to 08:00 PT) */
  function quietHoursShift(iso) {
    var d = new Date(iso || Date.now());
    var ptHour = ((d.getUTCHours() * 60 + d.getUTCMinutes() + TZ_OFFSET_MIN) / 60 + 24) % 24;
    if (ptHour >= QUIET_END && ptHour < QUIET_START) return d.toISOString();
    // move to next 08:05 PT
    var shift = new Date(d);
    if (ptHour >= QUIET_START) shift.setUTCDate(shift.getUTCDate() + 1);
    var targetUTCmin = (QUIET_END * 60 + 5) - TZ_OFFSET_MIN;
    shift.setUTCHours(Math.floor(targetUTCmin / 60) % 24, targetUTCmin % 60, 0, 0);
    return shift.toISOString();
  }

  /* helpers */
  function first(name) { return String(name || '').trim().split(/\s+/)[0] || 'there'; }
  function block(v) {
    return [
      'Service:    ' + (v.serviceLabel || ''),
      'Route:      ' + (v.routeText || ''),
      'When:       ' + (v.dateShort || '') + (v.timeShort ? ' at ' + v.timeShort : ''),
      v.passengers ? ('Passengers: ' + v.passengers) : undefined,
      v.vehicleText ? ('Vehicle:    ' + v.vehicleText) : undefined,
      'Reference:  ' + (v.reference || '')
    ].filter(function (l) { return l !== undefined; }).join('\n');
  }

  var api = {
    plan: plan, render: render, quietHoursShift: quietHoursShift,
    TEMPLATES: T, TRIGGERS: TRIGGERS,
    constants: { BRAND: BRAND, PHONE: PHONE, PHONE_E164: PHONE_E164, FROM_EMAIL: FROM_EMAIL }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NWTCComms = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
