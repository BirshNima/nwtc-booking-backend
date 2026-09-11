/* ============================================================================
   Northwest Town Car Service — delivery  (step 5)
   ----------------------------------------------------------------------------
   Takes a plan from messages.js / sequences.js and delivers it:
     - SMS   via Twilio
     - email via a JSON HTTP sender (Postmark shape; swap sendEmail() for SES etc.)
   Every send: dedupe on (reference + templateId), retry once on 5xx, log the
   result to the CRM Activity Log, and honor opt-out.

   Also: handleInboundSms() for the STOP / HELP / YES keywords and to mark a
   Lead as "customer replied" (which stops the follow-up sequence).

   Node 18+. Env: see config.example.env.
   ============================================================================ */
'use strict';

const COMMS = require('./messages.js');           // NWTCComms
const crm = require('../booking-payment/crm-airtable.js');

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;
const TWILIO_MSID = process.env.TWILIO_MESSAGING_SERVICE_SID; // optional, preferred
const EMAIL_ENDPOINT = process.env.EMAIL_API_URL;             // e.g. https://api.postmarkapp.com/email
const EMAIL_TOKEN = process.env.EMAIL_API_TOKEN;
const EMAIL_FROM = process.env.EMAIL_FROM || COMMS.constants.FROM_EMAIL;
const DRY_RUN = process.env.COMMS_DRY_RUN === '1';

/* ---------------------------------------------------------------- dedupe ---
   A tiny "Messages" table (Ref, Template, Channel, Status, Sent At, Error).
   sentAlready() short-circuits repeats; recordMessage() writes the outcome. */
async function sentAlready(dedupeKey) {
  try { return !!(await crm.findMessage(dedupeKey)); }
  catch { return false; } // if the table isn't there yet, don't block sends
}

/* ------------------------------------------------------------- public API */

/**
 * Deliver one message object from NWTCComms.plan()/sequences.
 * @returns {object} { ok, id, channel, status, skipped?, error? }
 */
async function deliver(msg) {
  const dedupeKey = msg.dedupeKey || `${(msg.vars || {}).reference || 'x'}:${msg.id || msg.templateId}`;
  const templateId = msg.id || msg.templateId;

  if (await sentAlready(dedupeKey)) {
    return { ok: true, skipped: 'already sent', channel: msg.channel, templateId };
  }

  const rendered = COMMS.render(templateId, msg.vars || {});
  let result;
  try {
    result = msg.channel === 'sms'
      ? await withRetry(() => sendSms(msg.to, rendered.text))
      : await withRetry(() => sendEmail(msg.to, msg.from || EMAIL_FROM, rendered.subject, rendered.text));
  } catch (e) {
    await log(msg, dedupeKey, 'Failed', e.message);
    return { ok: false, channel: msg.channel, templateId, error: e.message };
  }

  await log(msg, dedupeKey, 'Sent', '', result.providerId);
  if (msg.onSent && msg.onSent.appendStep != null && (msg.vars || {}).reference) {
    await crm.appendFollowupStep((msg.vars).reference, msg.onSent.appendStep).catch(() => {});
  }
  return { ok: true, channel: msg.channel, templateId, status: 'Sent', providerId: result.providerId };
}

/** Deliver a whole plan; returns per-message results. */
async function deliverAll(messages) {
  const out = [];
  for (const m of messages) out.push(await deliver(m));
  return out;
}

/* ------------------------------------------------------------- providers */

async function sendSms(to, body) {
  if (DRY_RUN) { console.log(`[dry-run sms] ${to}\n${body}\n`); return { providerId: 'dry' }; }
  if (!TWILIO_SID || !TWILIO_TOKEN) throw new Error('Twilio not configured');
  const params = new URLSearchParams({ To: to, Body: body });
  if (TWILIO_MSID) params.set('MessagingServiceSid', TWILIO_MSID);
  else params.set('From', TWILIO_FROM);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const data = await res.json();
  if (!res.ok) throw httpErr(`Twilio ${res.status}: ${data.message || ''}`, res.status);
  return { providerId: data.sid };
}

async function sendEmail(to, from, subject, text) {
  if (DRY_RUN) { console.log(`[dry-run email] ${to}  «${subject}»\n${text}\n`); return { providerId: 'dry' }; }
  if (!EMAIL_ENDPOINT || !EMAIL_TOKEN) throw new Error('email sender not configured');
  const res = await fetch(EMAIL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Postmark-Server-Token': EMAIL_TOKEN,   // Postmark; for SES swap this whole fn
    },
    body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: text, MessageStream: 'outbound' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpErr(`email ${res.status}: ${data.Message || ''}`, res.status);
  return { providerId: data.MessageID };
}

/* --------------------------------------------------------- inbound SMS ---
   Point your Twilio number's "A message comes in" webhook here.
   Returns TwiML (or {}), and mutates the CRM as a side effect. */
async function handleInboundSms({ From, Body }) {
  const text = (Body || '').trim();
  const kw = text.toUpperCase();
  const lead = await crm.findLatestLeadByPhone(From).catch(() => null);

  if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)\b/.test(kw)) {
    await crm.setContactOptOut(From, true).catch(() => {});
    await activity(lead, 'sms:opt-out', From);
    return twiml('You are unsubscribed and will get no more texts. Reply START to opt back in. Call (206) 596-5504 anytime.');
  }
  if (/^START\b|^UNSTOP\b/.test(kw)) {
    await crm.setContactOptOut(From, false).catch(() => {});
    return twiml('You are opted back in. Reply STOP to opt out again.');
  }
  if (/^HELP\b|^INFO\b/.test(kw)) {
    return twiml('Northwest Town Car Service. Book or ask: (206) 596-5504. Msg&data rates may apply. Reply STOP to opt out.');
  }

  // Any other reply: a human takes over. Flag the lead so the sequence halts.
  if (lead) {
    await crm.patchLead(lead.fields.Reference, { 'Customer Replied': true, 'Needs Reply': true }).catch(() => {});
    await activity(lead, 'sms:inbound', text.slice(0, 140));
  }
  await notifyOwner(`Inbound text from ${From}${lead ? ` (${lead.fields.Reference})` : ''}`, text);
  return twiml(''); // no auto-reply — a person will answer
}

/* -------------------------------------------------------------- plumbing */

async function withRetry(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.status && e.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500));
      return fn();
    }
    throw e;
  }
}

async function log(msg, dedupeKey, status, error, providerId) {
  const ref = (msg.vars || {}).reference || '';
  await crm.recordMessage({
    dedupeKey, reference: ref, template: msg.id || msg.templateId,
    channel: msg.channel, status, error: error || '', providerId: providerId || '',
    to: msg.to,
  }).catch((e) => console.error('[comms] recordMessage failed:', e.message));

  await crm.logActivity({
    ref, recordType: 'Lead', actor: 'comms',
    event: `${msg.channel}:${status.toLowerCase()}`,
    detail: `${msg.id || msg.templateId}${error ? ' — ' + error : ''}`,
  }).catch(() => {});

  if (status === 'Failed') {
    await notifyOwner(`Message FAILED — ${ref} — ${msg.id || msg.templateId}`, error);
  }
}

async function activity(lead, event, detail) {
  if (!lead) return;
  await crm.logActivity({
    ref: lead.fields.Reference, recordType: 'Lead', actor: 'customer', event, detail,
  }).catch(() => {});
}

async function notifyOwner(subject, text) {
  const hook = process.env.DISPATCH_WEBHOOK_URL;
  if (!hook) { console.warn('[comms] owner alert (no webhook):', subject); return; }
  try {
    await fetch(hook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, text }),
    });
  } catch (e) { console.error('[comms] owner alert failed:', e.message); }
}

const twiml = (t) => ({
  contentType: 'text/xml',
  body: t
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(t)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response/>`,
});
const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const httpErr = (m, status) => Object.assign(new Error(m), { status });

module.exports = { deliver, deliverAll, handleInboundSms, sendSms, sendEmail };
