/* ============================================================================
   Northwest Town Car Service — booking + payment server  (revenue-core step 4)
   ----------------------------------------------------------------------------
   Three endpoints. Framework-agnostic core (handleIntake / handleDepositLink /
   handleStripeWebhook); thin adapters at the bottom for Netlify Functions,
   Cloudflare Workers, and Vercel/Express.

     POST /intake         PUBLIC. The funnel posts its payload here.
                          Re-prices server-side, writes the Lead/Quote/Booking,
                          alerts dispatch. NO money is moved. A reservation
                          lands as "Reserved / Deposit Pending".

     POST /deposit-link   PRIVATE (bearer DISPATCH_API_TOKEN). Dispatch calls
                          this AFTER confirming the ride. Creates the Stripe
                          Checkout Session and writes the link onto the Booking.
                          This is the human-approval gate for taking money.

     POST /stripe-webhook Stripe calls this. Verifies the signature, then:
                            checkout.session.completed  -> Payment Succeeded,
                                                           Deposit Paid, Booking
                                                           "Deposit Paid"
                            checkout.session.expired /
                            payment_intent.payment_failed -> Payment Failed,
                                                           retry once then alert

   Requires: Node 18+ (global fetch), `stripe` package, the sibling modules
   pricing-engine.js / deposit.js / crm-airtable.js and the intake transform
   from ../crm/intake.js.  Env vars: see config.example.env.
   ============================================================================ */
'use strict';

const Stripe = require('stripe');
const PRICING = require('../pricing/pricing-engine.js');       // NWTCPricing
const PAY = require('./deposit.js');                           // NWTCPayments
const INTAKE = require('../crm/intake.js');                    // NWTCIntake
const crm = require('./crm-airtable.js');
const table = require('../pricing/pricing-table.json');

// Fetch-based HTTP client: works unchanged on Node 18+ AND on edge runtimes
// (Cloudflare Workers) that have no `http`/`https` module. Stripe's default
// client needs Node's http module, which Workers don't provide.
const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
const SITE = process.env.SITE_ORIGIN || 'https://northwesttowncarservice.com';
const DISPATCH_TOKEN = process.env.DISPATCH_API_TOKEN;
const PRICE_TOLERANCE = Number(process.env.PRICE_TOLERANCE || 0.01);

/* ------------------------------------------------------------------ helpers */
const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const bad = (msg, status = 400) => json(status, { ok: false, error: msg });

/* Fire a comms plan (step 5). Lazy-required so payments still run if comms
   isn't deployed yet. Never throws into the request. */
let _comms = null;
async function deliverComms(trigger, ctx) {
  try {
    if (!_comms) _comms = { msg: require('../comms/messages.js'), send: require('../comms/send.js') };
    await _comms.send.deliverAll(_comms.msg.plan(trigger, ctx));
  } catch (e) {
    console.error('[comms] deliver failed:', e.message);
  }
}

async function notifyDispatch(subject, lines) {
  // Wire to your sender (Postmark/SES/Twilio). Kept as one call so the rest of
  // the file is provider-agnostic. Must not throw the request.
  const to = process.env.DISPATCH_EMAIL;
  const hook = process.env.DISPATCH_WEBHOOK_URL; // e.g. a Make/Zapier catch hook, or Slack
  const text = `${subject}\n\n${lines.join('\n')}`;
  try {
    if (hook) {
      await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, text, to }),
      });
    } else {
      console.warn('[dispatch] no DISPATCH_WEBHOOK_URL set — alert not sent:', subject);
    }
  } catch (e) {
    console.error('[dispatch] alert failed:', e.message);
  }
}

/* ============================================================================
   1. POST /intake   — public
   ========================================================================== */
async function handleIntake(rawBody) {
  let payload;
  try { payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody; }
  catch { return bad('invalid JSON'); }

  if (!payload || !payload.reference || !payload.kind || !payload.values) {
    return bad('missing reference/kind/values');
  }

  // ---- server-side re-price. The client price is display-only. ----
  const q = payload.quote;
  let verified = null;
  if (q && q !== 'corporate' && q.finalAmount != null) {
    const req = buildPricingRequest(payload.values);           // account stays null here
    const v = PRICING.verifyQuote(q.finalAmount, req, table, PRICE_TOLERANCE);
    verified = v;
    if (!v.valid) {
      // Do NOT reject the lead — capture it, but flag for dispatch and drop the
      // client amount so nothing downstream trusts it.
      await crm.logActivity({
        ref: payload.reference,
        recordType: 'Lead',
        event: 'intake:price-mismatch',
        detail: `client $${v.clientAmount} vs server $${v.serverAmount} (Δ ${v.delta})`,
        actor: 'system',
      }).catch(() => {});
      payload.quote = { method: v.method, finalAmount: v.serverAmount, lineItems: (v.breakdown || {}).lineItems || [], priceMismatch: true };
    } else {
      payload.quote = { ...q, method: v.method, finalAmount: v.serverAmount };
    }
  }

  // ---- transform + apply to CRM (idempotent on Reference) ----
  const { ops, summary } = INTAKE.funnelPayloadToCRM(payload, { now: new Date().toISOString() });
  let applied;
  try {
    applied = await crm.applyOps(ops);
  } catch (e) {
    console.error('[intake] CRM apply failed:', e.message);
    await notifyDispatch(`INTAKE FAILED to reach CRM — ${payload.reference}`, [
      `kind: ${payload.kind}`, `name: ${payload.values.name}`, `phone: ${payload.values.phone}`,
      `error: ${e.message}`, ``, `Raw payload:`, JSON.stringify(payload, null, 2),
    ]);
    return json(202, { ok: true, reference: payload.reference, queued: true,
      note: 'received; CRM write is being retried' });
  }

  // ---- alert dispatch ----
  const v = payload.values;
  const money = summary.amount != null ? `$${summary.amount}` : (summary.quoteMethod === 'corporate' ? 'account' : 'manual quote');
  await notifyDispatch(
    `${labelKind(payload.kind)} — ${payload.reference} — ${v.service || ''} — ${v.name || ''}`,
    [
      `Reference   ${payload.reference}`,
      `Type        ${payload.kind}${payload.quote && payload.quote.priceMismatch ? '  ⚠ PRICE MISMATCH — verify before confirming' : ''}`,
      `Service     ${v.service || ''}`,
      `Route       ${routeText(v)}`,
      `When        ${v.date || '?'} ${v.time || ''}${v.returnDate ? `  (return ${v.returnDate} ${v.returnTime || ''})` : ''}`,
      `Passengers  ${v.passengers || '?'}   Bags ${v.bags || '?'}   Vehicle ${v.vehicle || 'let us choose'}`,
      `Amount      ${money}${verified && !verified.valid ? `  (client said $${verified.clientAmount})` : ''}`,
      `Contact     ${v.name || ''} · ${v.phone || ''} · ${v.email || ''}`,
      `Payment     ${v.paymentPreference === 'cash' ? 'CASH to driver (customer chose)' : 'card'}`,
      v.flight ? `Flight      ${v.flight}` : '',
      v.notes ? `Notes       ${v.notes}` : '',
      ``,
      summary.createsBooking
        ? (v.paymentPreference === 'cash'
            ? `NEXT: confirm driver + vehicle, then POST /deposit-link {"reference":"${payload.reference}","paymentMethod":"cash"} — no card link, records the cash due.`
            : `NEXT: confirm driver + vehicle, then POST /deposit-link {"reference":"${payload.reference}"} to send the deposit.`)
        : `NEXT: price this and send a written quote. No deposit until they accept.`,
    ].filter(Boolean)
  );

  return json(200, {
    ok: true,
    reference: payload.reference,
    kind: payload.kind,
    status: summary.leadStatus,
    amount: summary.amount,
    priceVerified: verified ? verified.valid : null,
    records: applied.length,
  });
}

/* ============================================================================
   2. POST /deposit-link   — private, dispatch only  (THE APPROVAL GATE)
   ========================================================================== */
async function handleDepositLink(rawBody, headers) {
  const auth = (headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!DISPATCH_TOKEN || auth !== DISPATCH_TOKEN) return bad('unauthorized', 401);

  let req;
  try { req = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody; }
  catch { return bad('invalid JSON'); }
  const reference = req && req.reference;
  if (!reference) return bad('reference required');

  const bRec = await crm.getBooking(reference);
  if (!bRec) return bad(`no Booking ${reference}`, 404);
  const bf = bRec.fields;

  // Gate: the booking must be human-confirmed first.
  const status = bf.Status || '';
  const okToCharge = ['Reserved', 'Confirmed'].includes(status) && bf['Driver Assigned'] !== false;
  if (!okToCharge && !req.force) {
    return bad(`Booking status is "${status}" — confirm the ride (or pass {"force":true}) before sending a deposit link.`, 409);
  }
  if (bf['Deposit Paid'] > 0) {
    return json(200, { ok: true, reference, alreadyPaid: true, depositPaid: bf['Deposit Paid'] });
  }

  const leadRec = await crm.getLead(reference).catch(() => null);
  const quoteMethod = (leadRec && leadRec.fields['Quote Method'])
    || (bf['Quote Method']) || 'flat';

  // Payment method: explicit on the request wins, else the customer's funnel
  // preference stored on the Booking/Lead, else card.
  const paymentMethod = (req.paymentMethod
    || bf['Payment Preference']
    || (leadRec && leadRec.fields['Payment Preference'])
    || 'card').toLowerCase();
  const newCustomer = bf['Customer Trip Count'] != null
    ? Number(bf['Customer Trip Count']) === 0
    : (leadRec ? leadRec.fields['New Customer'] === true : false);

  const booking = {
    reference,
    kind: 'reservation',
    quoteMethod,
    paymentMethod,
    newCustomer,
    fareAmount: num(bf.Price),
    depositOverride: num(req.depositOverride),
    serviceLabel: bf.Service || 'Northwest Town Car Service',
    pickupText: [bf.Pickup, bf['Drop-off']].filter(Boolean).join(' → '),
    dateText: [bf.Date, bf.Time].filter(Boolean).join(' '),
    customerEmail: bf['Customer Email'] || (leadRec && leadRec.fields.Email) || req.email,
    customerName: bf['Customer Name'] || (leadRec && leadRec.fields.Name) || '',
  };

  const plan = PAY.depositPlan(booking, table);

  // ---- Cash: no Stripe. Record the expected cash, confirm (or hold), notify. ----
  if (plan.basis === 'cash') {
    const held = plan.blocked && !req.force;
    await crm.patchBooking(reference, {
      'Payment Method': 'Cash',
      'Deposit Amount': 0,
      'Balance': plan.cashDue,
      'Cash Due': plan.cashDue,
      'Deposit Note': plan.reason,
      Status: held ? 'Needs Approval' : 'Confirmed',
    });
    await crm.recordPayment({
      reference, amount: plan.cashDue || 0, type: 'Balance', status: 'Pending',
      dedupeRef: `${reference}:cash-expected`, method: 'cash', note: plan.reason,
    });
    await crm.logActivity({
      ref: reference, event: held ? 'cash:held-for-approval' : 'cash:confirmed',
      detail: plan.reason, actor: 'dispatch',
    });
    if (held) {
      await notifyDispatch(`Cash booking needs approval — ${reference}`, [
        plan.reason, `Approve with POST /deposit-link {"reference":"${reference}","paymentMethod":"cash","force":true}`,
        `or send a card deposit link instead (omit paymentMethod).`,
      ]);
    } else {
      // customer-facing "pay the driver" confirmation
      await deliverComms('booking.cash.confirmed', {
        reference,
        contact: { phone: bf['Customer Phone'] || (leadRec && leadRec.fields.Phone), email: booking.customerEmail },
        vars: {
          name: booking.customerName, reference,
          serviceLabel: booking.serviceLabel, routeText: booking.pickupText,
          dateShort: bf.Date || '', timeShort: bf.Time || '',
          cashText: plan.cashDue != null ? `$${plan.cashDue}` : 'the quoted fare',
        },
      });
    }
    return json(200, {
      ok: true, reference, paymentMethod: 'cash',
      depositDue: false, held, cashDue: plan.cashDue, reason: plan.reason,
    });
  }

  if (!plan.due) {
    await crm.patchBooking(reference, { Status: 'Confirmed', 'Deposit Note': plan.reason });
    return json(200, { ok: true, reference, depositDue: false, reason: plan.reason });
  }

  const params = PAY.checkoutSessionParams(booking, plan, {
    successUrl: `${SITE}/booking/confirmed?ref=${encodeURIComponent(reference)}&s={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${SITE}/booking/deposit?ref=${encodeURIComponent(reference)}`,
    statementDescriptor: 'NW TOWN CAR DEP',
    expiresMinutes: Number(process.env.CHECKOUT_EXPIRES_MINUTES || 1440),
  });

  const idemKey = params._idempotencyKey;
  delete params._idempotencyKey;

  let session;
  try {
    session = await stripe.checkout.sessions.create(params, { idempotencyKey: idemKey });
  } catch (e) {
    console.error('[deposit-link] Stripe error:', e.message);
    return bad(`Stripe: ${e.message}`, 502);
  }

  await crm.patchBooking(reference, {
    'Deposit Amount': plan.amount,
    'Balance': plan.balanceDue,
    'Deposit Link': session.url,
    'Deposit Session Id': session.id,
    'Deposit Note': plan.reason,
    'Deposit Link Sent': new Date().toISOString(),
    Status: 'Confirmed',
  });
  await crm.recordPayment({
    reference, amount: plan.amount, type: 'Deposit', status: 'Pending',
    dedupeRef: session.id, method: 'card', note: plan.reason,
  });
  await crm.logActivity({
    ref: reference, event: 'deposit:link-created',
    detail: `$${plan.amount} (${plan.basis}) — session ${session.id}`, actor: 'dispatch',
  });

  return json(200, {
    ok: true,
    reference,
    depositDue: true,
    amount: plan.amount,
    balanceDue: plan.balanceDue,
    refundableUntilHoursBefore: plan.refundableUntilHoursBefore,
    checkoutUrl: session.url,        // put this in the confirmation SMS/email
    sessionId: session.id,
    expiresAt: session.expires_at,
  });
}

/* ============================================================================
   2b. POST /record-cash-payment   — private, dispatch/driver
   ----------------------------------------------------------------------------
   After a cash trip: mark what the driver actually collected. Same bearer token
   as /deposit-link. Body: { reference, amount?, type?, gratuity? }
     amount   defaults to the Booking's Cash Due
     type     'Balance' (default) | 'Deposit' | 'Gratuity'
   ========================================================================== */
async function handleRecordCash(rawBody, headers) {
  const auth = (headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!DISPATCH_TOKEN || auth !== DISPATCH_TOKEN) return bad('unauthorized', 401);

  let req;
  try { req = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody; }
  catch { return bad('invalid JSON'); }
  const reference = req && req.reference;
  if (!reference) return bad('reference required');

  const bRec = await crm.getBooking(reference);
  if (!bRec) return bad(`no Booking ${reference}`, 404);
  const bf = bRec.fields;

  const type = req.type || 'Balance';
  const amount = num(req.amount) != null ? num(req.amount)
    : num(bf['Cash Due']) != null ? num(bf['Cash Due'])
    : num(bf.Price);
  if (amount == null) return bad('no amount and no Cash Due / Price on the booking');

  const gratuity = num(req.gratuity) || 0;
  const collected = round2(amount + gratuity);

  await crm.recordPayment({
    reference, amount: collected, type, status: 'Succeeded',
    dedupeRef: `${reference}:cash-collected`, method: 'cash',
    note: `Cash collected by the driver${gratuity ? ` (incl. $${gratuity} gratuity)` : ''}`,
  });
  const prior = num(bf['Fare Collected']) || 0;
  await crm.patchBooking(reference, {
    'Payment Method': 'Cash',
    'Fare Collected': round2(prior + collected),
    'Fare Collected At': new Date().toISOString(),
    Status: 'Completed',
  });
  await crm.logActivity({
    ref: reference, event: 'cash:collected', actor: 'driver',
    detail: `$${collected} ${type.toLowerCase()}`,
  });
  return json(200, { ok: true, reference, collected, method: 'cash', status: 'Succeeded' });
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/* ============================================================================
   3. POST /stripe-webhook
   ========================================================================== */
async function handleStripeWebhook(rawBody, headers) {
  const sig = headers['stripe-signature'] || headers['Stripe-Signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return bad(`signature verification failed: ${e.message}`, 400);
  }

  // idempotency — Stripe retries
  if (await crm.eventSeen(event.id)) return json(200, { ok: true, duplicate: true });

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await onDepositPaid(event.data.object);
        break;
      case 'checkout.session.expired':
        await onDepositExpired(event.data.object);
        break;
      case 'payment_intent.payment_failed':
        await onPaymentFailed(event.data.object);
        break;
      case 'charge.refunded':
        await onRefund(event.data.object);
        break;
      default:
        // ignore the rest
        break;
    }
    await crm.markEvent(event.id);
  } catch (e) {
    console.error(`[webhook] ${event.type} failed:`, e.message);
    // 500 -> Stripe retries with backoff
    return bad(`handler error: ${e.message}`, 500);
  }
  return json(200, { ok: true, type: event.type });
}

async function onDepositPaid(session) {
  const reference = session.client_reference_id || (session.metadata || {}).reference;
  if (!reference) return;
  const paid = (session.amount_total || 0) / 100;
  const meta = session.metadata || {};

  await crm.recordPayment({
    reference, amount: paid, type: 'Deposit', status: 'Succeeded',
    dedupeRef: session.id,
    method: 'card',
    note: `Deposit paid via Stripe Checkout (${session.payment_intent || 'pi?'})`,
  });
  await crm.patchBooking(reference, {
    'Deposit Paid': paid,
    'Balance': meta.balance_due ? Number(meta.balance_due) : undefined,
    Status: 'Deposit Paid',
    'Deposit Paid At': new Date().toISOString(),
  });
  await crm.logActivity({
    ref: reference, event: 'deposit:paid',
    detail: `$${paid} — ${session.customer_details ? session.customer_details.email : ''}`,
    actor: 'stripe',
  });
  await notifyDispatch(`Deposit paid — ${reference} — $${paid}`, [
    `The ride is now fully confirmed.`,
    `Balance due after the trip: ${meta.balance_due ? '$' + meta.balance_due : 'see booking'}.`,
    `Send the customer their driver + vehicle details per the normal 24h reminder.`,
  ]);
}

async function onDepositExpired(session) {
  const reference = session.client_reference_id || (session.metadata || {}).reference;
  if (!reference) return;
  await crm.recordPayment({
    reference, amount: 0, type: 'Deposit', status: 'Failed',
    dedupeRef: session.id, note: 'Checkout session expired unpaid',
  });
  await crm.logActivity({ ref: reference, event: 'deposit:expired', detail: session.id, actor: 'stripe' });
  await notifyDispatch(`Deposit link expired unpaid — ${reference}`, [
    `The customer did not pay within the window.`,
    `Decide: resend a link (POST /deposit-link again), call them, or release the slot.`,
  ]);
}

async function onPaymentFailed(pi) {
  const reference = (pi.metadata || {}).reference;
  if (!reference) return;
  const attempts = Number((pi.metadata || {}).nwtc_attempts || 0) + 1;
  await crm.recordPayment({
    reference, amount: (pi.amount || 0) / 100, type: 'Deposit', status: 'Failed',
    dedupeRef: pi.id + ':' + attempts,
    note: `Charge failed: ${pi.last_payment_error ? pi.last_payment_error.message : 'unknown'}`,
  });
  await crm.logActivity({ ref: reference, event: 'deposit:failed', detail: `attempt ${attempts}`, actor: 'stripe' });
  if (attempts >= 2) {
    await crm.patchBooking(reference, { Status: 'Payment Held' }).catch(() => {});
    await notifyDispatch(`Deposit failed twice — ${reference} — held 24h`, [
      `Two failed attempts. Booking set to "Payment Held".`,
      `Send a card-update link or call the customer. Auto-release in 24h if unresolved.`,
    ]);
  }
}

async function onRefund(charge) {
  const reference = (charge.metadata || {}).reference
    || (charge.payment_intent && (await stripe.paymentIntents.retrieve(charge.payment_intent)).metadata.reference);
  if (!reference) return;
  const refunded = (charge.amount_refunded || 0) / 100;
  await crm.recordPayment({
    reference, amount: refunded, type: 'Refund', status: 'Refunded',
    dedupeRef: charge.id + ':refund',
    note: `Refund processed via Stripe`,
  });
  await crm.patchBooking(reference, { 'Deposit Paid': 0, Status: 'Cancelled' }).catch(() => {});
  await crm.logActivity({ ref: reference, event: 'deposit:refunded', detail: `$${refunded}`, actor: 'stripe' });
}

/* ------------------------------------------------------- pricing request map
   Mirrors homepage-redesign/booking-funnel/index.html pricingRequest(d)/resolveVehicleClass(d).
   Keep in sync with the funnel. account stays null server-side unless the
   request is tied to an authenticated corporate account.
   ------------------------------------------------------------------------- */
function buildPricingRequest(v) {
  const svc = v.service || '';
  let service = 'point-to-point', direction;
  if (/Airport/i.test(svc)) {
    service = 'airport';
    // funnel labels: "Airport pickup (from SEA)" vs "Airport drop-off (to SEA)"
    direction = /drop-?off|to SEA|to-airport|departure/i.test(svc) ? 'to-airport' : 'from-airport';
  } else if (/Hourly|as-directed/i.test(svc)) service = 'hourly';
  else if (/Cruise/i.test(svc)) service = 'cruise';
  else if (/Wedding/i.test(svc)) service = 'wedding';
  else if (/Event|Night/i.test(svc)) service = 'event';

  return {
    service,
    direction,
    zone: v.zone && v.zone !== 'other' ? v.zone : undefined,
    isAirportLeg: /Airport|Cruise/i.test(svc),
    vehicleClass: resolveVehicleClass(v),
    hours: num(v.hours),
    stops: int(v.stops),
    childSeats: int(v.childSeats),
    waitMinutes: 0,
    gratuityPct: num(v.gratuityPct),
    account: null,
  };
}
function resolveVehicleClass(v) {
  const map = {
    'Executive Sedan': 'executive-sedan',
    'Premium SUV': 'premium-suv',
    'Sprinter Van': 'sprinter',
    'Sprinter': 'sprinter',
  };
  if (v.vehicle && map[v.vehicle]) return map[v.vehicle];
  const pax = int(v.passengers) || 1;
  if (pax <= 3) return 'executive-sedan';
  if (pax <= 6) return 'premium-suv';
  return 'sprinter';
}

const num = (x) => (x === '' || x == null || isNaN(Number(x)) ? null : Number(x));
const int = (x) => { const n = parseInt(x, 10); return isNaN(n) ? null : n; };
const labelKind = (k) => ({ reservation: 'Reservation', 'quote-request': 'Quote request', 'corporate-lead': 'Corporate lead' }[k] || k);
function routeText(v) {
  if (/Hourly/i.test(v.service || '')) return `${v.hourlyStart || '?'} — ${v.hours || '?'} hrs`;
  if (/Airport/i.test(v.service || '')) return `${v.pickup || '?'} → ${v.dropoff || '?'}`;
  return `${v.pPickup || v.pickup || '?'} → ${v.pDropoff || v.dropoff || '?'}`;
}

/* ============================================================================
   Adapters
   ========================================================================== */

// ---- Netlify Functions (netlify/functions/{intake,deposit-link,stripe-webhook}.js)
//      re-export the matching handler:  exports.handler = netlify(handleIntake)
function netlify(fn, { rawBodyFor } = {}) {
  return async (event) => {
    const headers = lower(event.headers || {});
    const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : event.body;
    const raw = rawBodyFor === 'stripe' ? body : (body ? body.toString('utf8') : '');
    const r = await fn(raw, headers);
    return { statusCode: r.status, headers: r.headers, body: r.body };
  };
}

// ---- Cloudflare Workers
//      export default { fetch: worker(routes) }
function worker() {
  return {
    async fetch(request, env) {
      Object.assign(process.env, env); // Workers pass secrets via env
      const url = new URL(request.url);
      const headers = lower(Object.fromEntries(request.headers));
      const raw = await request.text();
      let r;
      if (url.pathname.endsWith('/intake') && request.method === 'POST') r = await handleIntake(raw);
      else if (url.pathname.endsWith('/deposit-link') && request.method === 'POST') r = await handleDepositLink(raw, headers);
      else if (url.pathname.endsWith('/record-cash-payment') && request.method === 'POST') r = await handleRecordCash(raw, headers);
      else if (url.pathname.endsWith('/stripe-webhook') && request.method === 'POST') r = await handleStripeWebhook(raw, headers);
      else r = bad('not found', 404);
      return new Response(r.body, { status: r.status, headers: r.headers });
    },
  };
}

// ---- Express / Vercel
//      app.post('/intake', express.text({type:'*/*'}), expressRoute(handleIntake))
//      app.post('/stripe-webhook', express.raw({type:'application/json'}), expressRoute(handleStripeWebhook))
function expressRoute(fn) {
  return async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    const r = await fn(raw, lower(req.headers));
    res.status(r.status).set(r.headers).send(r.body);
  };
}

const lower = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

module.exports = {
  handleIntake,
  handleDepositLink,
  handleRecordCash,
  handleStripeWebhook,
  buildPricingRequest,
  netlify,
  worker,
  expressRoute,
};
