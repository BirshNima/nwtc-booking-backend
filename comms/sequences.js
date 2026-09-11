/* ============================================================================
   Northwest Town Car Service — quote follow-up sequence  (step 5)
   ----------------------------------------------------------------------------
   Pure state machine. Given a Lead's current state and what has already been
   sent, `nextAction()` returns the one thing to do now — or a stop reason.
   A cron (or Make scenario) runs `nextAction` over every open Lead each hour
   and hands any returned message to send.js.

     NWTCSequence.nextAction(lead, now?)  ->
        { action: 'send', step, templateId, dueAt }
      | { action: 'wait', until }
      | { action: 'stop', reason }
      | { action: 'handoff', reason }        // needs a person (manual-quote)

   SCHEDULE (CRM spec, automation 3):  day 0h · +1d · +3d · +7d
   CHANNELS (runbook decision 5):      d0 SMS · d1 SMS · d3 email · d7 email
   ========================================================================== */
(function (global) {
  'use strict';

  var STEPS = [
    { step: 0, offsetH: 0,   templateId: 'followup.d0.sms',   channel: 'sms'   },
    { step: 1, offsetH: 24,  templateId: 'followup.d1.sms',   channel: 'sms'   },
    { step: 2, offsetH: 72,  templateId: 'followup.d3.email', channel: 'email' },
    { step: 3, offsetH: 168, templateId: 'followup.d7.email', channel: 'email' }
  ];

  var HOUR = 3600e3;

  /* Lead statuses that end the sequence, and why. */
  var STOP_STATUSES = {
    'Booked': 'converted',
    'Won': 'converted',
    'Lost': 'already lost',
    'Cancelled': 'cancelled'
  };

  /**
   * @param {object} lead
   *   {
   *     reference,
   *     status,                 CRM Lead Status
   *     quoteMethod,            'flat' | 'hourly' | 'manual-quote' | 'corporate'
   *     quoteSentAt,            ISO — the clock the offsets count from
   *     quoteValidUntil,        ISO
   *     customerReplied,        bool — any inbound message on this ref
   *     optedOut,               bool
   *     sentSteps,              number[] — follow-up steps already delivered
   *     pickupAt,               ISO — the trip date; don't chase past it
   *   }
   * @param {string} [now] ISO
   */
  function nextAction(lead, now) {
    lead = lead || {};
    var t = new Date(now || Date.now()).getTime();
    var sent = lead.sentSteps || [];

    if (lead.quoteMethod === 'corporate') return stop('corporate — handled by the sales pipeline');
    if (lead.quoteMethod === 'manual-quote' && !lead.quoteSentAt)
      return { action: 'handoff', reason: 'dispatch must price and send this quote first' };

    if (lead.optedOut) return stop('opted out');
    if (lead.customerReplied) return stop('customer replied — a person takes it from here');
    if (STOP_STATUSES[lead.status]) return stop(STOP_STATUSES[lead.status]);

    var base = lead.quoteSentAt ? new Date(lead.quoteSentAt).getTime() : t;
    var pickup = lead.pickupAt ? new Date(lead.pickupAt).getTime() : Infinity;

    for (var i = 0; i < STEPS.length; i++) {
      var s = STEPS[i];
      if (sent.indexOf(s.step) !== -1) continue;
      var dueAt = base + s.offsetH * HOUR;

      // Don't send a follow-up after the trip would have happened.
      if (dueAt > pickup) return stop('pickup date passed');

      if (t < dueAt) return { action: 'wait', until: new Date(dueAt).toISOString() };

      return {
        action: 'send',
        step: s.step,
        templateId: s.templateId,
        channel: s.channel,
        dueAt: new Date(dueAt).toISOString()
      };
    }

    // all four sent, still no reply
    return {
      action: 'stop',
      reason: 'no reply after 4 touches',
      markLead: { Status: 'Lost', 'Lost Reason': 'No reply' }
    };
  }

  function stop(reason) { return { action: 'stop', reason: reason }; }

  /** Convenience for the cron: fold nextAction into a send.js-ready message. */
  function toMessage(lead, action, vars, contact) {
    if (!action || action.action !== 'send') return null;
    return {
      trigger: 'followup',
      templateId: action.templateId,
      channel: action.channel,
      to: action.channel === 'sms' ? contact.phone : contact.email,
      vars: vars,
      dedupeKey: lead.reference + ':' + action.templateId,
      onSent: { appendStep: action.step }
    };
  }

  var api = { nextAction: nextAction, toMessage: toMessage, STEPS: STEPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NWTCSequence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
