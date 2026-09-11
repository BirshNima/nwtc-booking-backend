/* ============================================================================
   Northwest Town Car Service — deposit + checkout module  (step 4: booking/payment)
   ----------------------------------------------------------------------------
   Pure and dependency-free, same as pricing-engine.js. Two jobs:

     1. depositPlan(booking, table)      -> how much deposit, and its refund rule
     2. checkoutSessionParams(...)       -> the exact object you hand to
                                            stripe.checkout.sessions.create()

   It never calls Stripe and never touches the network. The server module
   (server.js) creates the Session; this file decides *what* to create so the
   policy lives in one tested place and the numbers come from the pricing table
   (pricing-table.json -> "deposit"), not from code.

   THE RULE (also in system-architecture and the launch runbook):
   a deposit link is generated only AFTER a human confirms the ride. Nothing
   here runs from the public funnel. See server.js /deposit-link.
   ========================================================================== */
(function (global) {
  'use strict';

  var CENTS = 100;

  function round2(n) { return Math.round(n * 100) / 100; }
  function toCents(dollars) { return Math.round(Number(dollars) * CENTS); }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }

  /**
   * Decide the deposit for a confirmed booking.
   *
   * @param {object} booking
   *   {
   *     reference: "NWTC-260903-4821",
   *     kind: "reservation" | "quote-request" | "corporate-lead",
   *     quoteMethod: "flat" | "hourly" | "manual-quote" | "corporate",
   *     fareAmount: number | null,   // the accepted quote total, dollars
   *     depositOverride: number | null  // dispatch-set, dollars — wins if present
   *   }
   * @param {object} table  pricing-table.json (uses table.deposit)
   * @returns {object}
   *   {
   *     due: boolean,           // false for corporate / on-account
   *     amount: number,         // dollars, rounded, >= table.deposit.minAmount
   *     amountCents: number,
   *     basis: "flat" | "percent" | "override" | "none",
   *     appliesToFare: boolean, // deposit is credited against the fare
   *     refundableUntilHoursBefore: number,
   *     balanceDue: number | null,   // fare - deposit, if fare known
   *     reason: string          // human-readable, goes in the Payment note
   *   }
   */
  function depositPlan(booking, table) {
    booking = booking || {};
    var d = (table && table.deposit) || {};
    var minAmount = isNum(d.minAmount) ? d.minAmount : 25;
    var refundHrs = isNum(d.refundableUntilHoursBefore) ? d.refundableUntilHoursBefore : 24;
    var fare = isNum(booking.fareAmount) ? booking.fareAmount : null;

    // Corporate / on-account: never a deposit.
    if (booking.kind === 'corporate-lead' || booking.quoteMethod === 'corporate') {
      return dry('none', 0, false, refundHrs, fare, 'Corporate account — billed per rate agreement, no deposit.');
    }

    // Dispatch override always wins (a special arrangement, a partial waiver…).
    if (isNum(booking.depositOverride)) {
      var amt = Math.max(round2(booking.depositOverride), 0);
      return dry('override', amt, true, refundHrs, fare,
        'Deposit set by dispatch: $' + amt.toFixed(2) + '.');
    }

    // Cash: the customer pays the driver the full fare in cash at the end of the
    // trip. No online deposit is taken. `blocked` means the booking should wait
    // for dispatch approval (fare over the cash limit, or a new customer) rather
    // than auto-confirm. A card hold, when wanted, is a normal deposit link with
    // paymentMethod left as 'card' — not modelled here.
    if (booking.paymentMethod === 'cash') {
      var cash = d.cash || {};
      var r = cash.restrictions || {};
      var overLimit = isNum(r.maxFare) && fare != null && fare > r.maxFare;
      var blocked = cash.allowed === false || overLimit ||
        (r.flagNewCustomers === true && booking.newCustomer === true);
      var out = dry('cash', 0, false, refundHrs, fare,
        blocked
          ? ('Cash requested' + (overLimit ? ' but the $' + fare.toFixed(2) + ' fare is over the $' + r.maxFare + ' cash limit' : booking.newCustomer ? ' by a first-time customer' : ' but cash is disabled') + ' — hold for dispatch approval.')
          : ('Cash to the driver — $' + (fare != null ? fare.toFixed(2) : 'the quoted fare') + ' due in full at the end of the trip. No card deposit.'));
      out.paymentMethod = 'cash';
      out.blocked = !!blocked;
      out.cashDue = fare != null ? round2(fare) : null;
      out.balanceDue = out.cashDue;
      return out;
    }

    // Instant-price rides (airport flat, hourly) -> flat deposit.
    var instant = booking.quoteMethod === 'flat' || booking.quoteMethod === 'hourly';
    var policy = instant ? (d.instantPrice || { type: 'flat', amount: 50 })
                         : (d.customQuote || { type: 'percent', pct: 25 });

    var amount, basis;
    if (policy.type === 'flat') {
      amount = isNum(policy.amount) ? policy.amount : 50;
      basis = 'flat';
    } else if (policy.type === 'percent') {
      if (fare == null) {
        // Percent policy but no known fare yet — fall back to the flat instant amount
        // so a link can still be sent; dispatch can override.
        amount = isNum((d.instantPrice || {}).amount) ? d.instantPrice.amount : 50;
        basis = 'flat';
      } else {
        amount = fare * (Number(policy.pct) / 100);
        basis = 'percent';
      }
    } else { // "none" or unknown
      return dry('none', 0, false, refundHrs, fare, 'No deposit required for this booking.');
    }

    amount = Math.max(round2(amount), minAmount);
    // Never ask for more than the fare itself.
    if (fare != null && amount > fare) amount = round2(fare);

    var appliesToFare = policy.appliesToFare !== false;
    var reason = (basis === 'percent'
      ? Number(policy.pct) + '% of the $' + fare.toFixed(2) + ' fare'
      : '$' + amount.toFixed(2) + ' flat deposit')
      + (appliesToFare ? ', credited against the fare.' : '.');

    return dry(basis, amount, appliesToFare, refundHrs, fare, reason);
  }

  function dry(basis, amount, appliesToFare, refundHrs, fare, reason) {
    amount = round2(amount);
    return {
      due: amount > 0,
      amount: amount,
      amountCents: toCents(amount),
      basis: basis,
      appliesToFare: appliesToFare,
      refundableUntilHoursBefore: refundHrs,
      balanceDue: (fare != null && appliesToFare) ? round2(Math.max(fare - amount, 0))
                : (fare != null ? round2(fare) : null),
      reason: reason
    };
  }

  /**
   * Build the params for stripe.checkout.sessions.create().
   * The server passes the returned object straight through; nothing here is
   * Stripe-version-specific beyond the documented Checkout shape.
   *
   * @param {object} booking   as above, plus:
   *   { customerEmail, customerName, serviceLabel, pickupText, dateText }
   * @param {object} plan      the result of depositPlan()
   * @param {object} cfg
   *   {
   *     successUrl, cancelUrl,      // required; {CHECKOUT_SESSION_ID} is substituted by Stripe
   *     statementDescriptor,        // <= 22 chars, e.g. "NW TOWN CAR DEPOSIT"
   *     expiresMinutes,             // Checkout Session lifetime (default 720 = 12h, Stripe max 24h from now via expires_at)
   *     currency                    // default "usd"
   *   }
   * @returns {object|null}  null when no deposit is due
   */
  function checkoutSessionParams(booking, plan, cfg) {
    if (!plan || !plan.due) return null;
    cfg = cfg || {};
    var currency = (cfg.currency || 'usd').toLowerCase();
    var ref = booking.reference;
    var name = 'Ride deposit — ' + (booking.serviceLabel || 'Northwest Town Car Service');
    var descLines = [
      ref,
      booking.pickupText || '',
      booking.dateText || '',
      plan.appliesToFare ? 'Applied to your fare. Balance due after the trip.' : ''
    ].filter(Boolean).join(' · ');

    var params = {
      mode: 'payment',
      // idempotency is passed as a request option by the server, not in the body,
      // but we echo the key we expect it to use:
      _idempotencyKey: 'deposit_' + ref,
      client_reference_id: ref,
      customer_email: booking.customerEmail || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: currency,
          unit_amount: plan.amountCents,
          product_data: {
            name: name,
            description: descLines.slice(0, 240)
          }
        }
      }],
      payment_intent_data: {
        description: 'Deposit ' + ref,
        statement_descriptor_suffix: (cfg.statementDescriptor || 'DEPOSIT').slice(0, 22),
        metadata: metaFor(booking, plan)
      },
      metadata: metaFor(booking, plan),
      success_url: cfg.successUrl,
      cancel_url: cfg.cancelUrl,
      expires_at: expiresAt(cfg.expiresMinutes),
      // We are NOT saving the card. Card-on-file for corporate is a separate flow.
      payment_method_types: ['card'],
      submit_type: 'pay',
      locale: 'en'
    };
    return prune(params);
  }

  function metaFor(booking, plan) {
    return {
      reference: booking.reference,
      kind: booking.kind || 'reservation',
      quote_method: booking.quoteMethod || '',
      deposit_basis: plan.basis,
      deposit_amount: String(plan.amount),
      fare_amount: booking.fareAmount != null ? String(booking.fareAmount) : '',
      balance_due: plan.balanceDue != null ? String(plan.balanceDue) : '',
      refundable_until_hours_before: String(plan.refundableUntilHoursBefore),
      applies_to_fare: plan.appliesToFare ? 'yes' : 'no'
    };
  }

  function expiresAt(minutes) {
    var m = isNum(minutes) ? minutes : 720;            // 12h default
    m = Math.max(30, Math.min(m, 24 * 60 - 5));        // Stripe: 30min .. <24h from now
    return Math.floor(Date.now() / 1000) + m * 60;
  }

  /** Is a booking still inside its refund window? Used by the refund gate. */
  function isRefundable(pickupISO, plan, nowISO) {
    if (!plan || !isNum(plan.refundableUntilHoursBefore)) return false;
    var pickup = new Date(pickupISO).getTime();
    var now = new Date(nowISO || Date.now()).getTime();
    if (isNaN(pickup)) return false;
    return (pickup - now) >= plan.refundableUntilHoursBefore * 3600e3;
  }

  function prune(o) {
    if (Array.isArray(o)) return o.map(prune);
    if (o && typeof o === 'object') {
      var out = {};
      Object.keys(o).forEach(function (k) {
        if (o[k] === undefined) return;
        out[k] = prune(o[k]);
      });
      return out;
    }
    return o;
  }

  var api = {
    depositPlan: depositPlan,
    checkoutSessionParams: checkoutSessionParams,
    isRefundable: isRefundable,
    toCents: toCents
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NWTCPayments = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
