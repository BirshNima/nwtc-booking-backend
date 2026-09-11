/* ============================================================================
   Northwest Town Car Service — CRM adapter (Airtable)
   ----------------------------------------------------------------------------
   The one file that knows Airtable's REST API. server.js talks only to this
   interface, so swapping to HubSpot / a real DB later means rewriting this file
   and nothing else:

     applyOps(ops)          apply the upsert ops from NWTCIntake.funnelPayloadToCRM
     getBooking(reference)   -> { id, fields } | null
     getLead(reference)      -> { id, fields } | null
     patchBooking(ref, f)    partial update by Reference
     recordPayment(p)        create/patch a Payments row (idempotent on Session/Event id)
     logActivity(entry)      append to Activity Log
     eventSeen(id) / markEvent(id)   webhook idempotency ledger

   Node 18+ (global fetch). No SDK.
   ============================================================================ */
'use strict';

const AIRTABLE_API = 'https://api.airtable.com/v0';

function cfg() {
  const key = process.env.AIRTABLE_TOKEN;
  const base = process.env.AIRTABLE_BASE_ID;
  if (!key || !base) throw new Error('AIRTABLE_TOKEN and AIRTABLE_BASE_ID are required');
  return { key, base };
}

async function at(path, init = {}) {
  const { key, base } = cfg();
  const res = await fetch(`${AIRTABLE_API}/${base}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Airtable ${res.status} on ${path}: ${body.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const enc = (s) => encodeURIComponent(s);
const esc = (s) => String(s).replace(/'/g, "\\'");

/** First record in `table` where `field` == `value`, or null. */
async function findBy(table, field, value) {
  const formula = `{${field}} = '${esc(value)}'`;
  const data = await at(`${enc(table)}?maxRecords=1&filterByFormula=${enc(formula)}`);
  return data.records && data.records[0] ? data.records[0] : null;
}

async function createRow(table, fields) {
  const data = await at(enc(table), {
    method: 'POST',
    body: JSON.stringify({ fields, typecast: true }),
  });
  return data;
}

async function patchRow(table, id, fields) {
  return at(`${enc(table)}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields, typecast: true }),
  });
}

/* ---------------------------------------------------------------------------
   Apply the intake ops (from crm/intake.js). Ops are ordered; later ops link
   to earlier records via _link* keys, which we resolve to Airtable record ids.
   --------------------------------------------------------------------------- */
async function applyOps(ops) {
  const created = {};                 // table -> { matchKey -> recordId }
  const results = [];

  for (const op of ops) {
    const fields = { ...op.fields };

    // Resolve _link* -> Airtable record id arrays
    for (const k of Object.keys(fields)) {
      if (!k.startsWith('_link')) continue;
      const link = fields[k];
      delete fields[k];
      if (!link) continue;
      const targetTable = LINK_TABLE[k];
      const [lf, lv] = Object.entries(link)[0] || [];
      if (!targetTable || !lf) continue;
      const cacheHit = created[targetTable] && created[targetTable][String(lv)];
      const rec = cacheHit ? { id: cacheHit } : await findBy(targetTable, lf, lv);
      if (rec) fields[LINK_FIELD[k]] = [rec.id];
    }

    let record;
    if (op.op === 'create') {
      record = await createRow(op.table, fields);
    } else {
      const [mf, mv] = Object.entries(op.matchOn)[0];
      const existing = await findBy(op.table, mf, mv);
      record = existing
        ? await patchRow(op.table, existing.id, fields)
        : await createRow(op.table, fields);
      created[op.table] = created[op.table] || {};
      created[op.table][String(mv)] = record.id;
    }
    results.push({ table: op.table, id: record.id });
  }
  return results;
}

const LINK_TABLE = {
  _linkCustomer: 'Customers',
  _linkCorporate: 'Corporate Accounts',
  _linkLead: 'Leads',
  _linkTrip: 'Trips',
};
const LINK_FIELD = {
  _linkCustomer: 'Customer',
  _linkCorporate: 'Corporate Account',
  _linkLead: 'Lead',
  _linkTrip: 'Trip',
};

/* --------------------------- typed helpers --------------------------- */

async function getBooking(reference) {
  return findBy('Bookings', 'Reference', reference);
}
async function getLead(reference) {
  return findBy('Leads', 'Reference', reference);
}

async function patchBooking(reference, fields) {
  const b = await getBooking(reference);
  if (!b) throw new Error(`No Booking ${reference}`);
  return patchRow('Bookings', b.id, fields);
}

/**
 * Idempotent on `dedupeRef` (Stripe Session id for the deposit, Event id for
 * webhook-driven writes). Returns { id, created:boolean }.
 */
async function recordPayment(p) {
  const existing = p.dedupeRef ? await findBy('Payments', 'Processor Ref', p.dedupeRef) : null;
  const booking = await getBooking(p.reference);
  const fields = {
    'Amount': p.amount,
    'Type': p.type,                       // Deposit · Balance · Gratuity · Refund
    'Method': p.method || 'card',
    'Processor Ref': p.dedupeRef || '',
    'Status': p.status,                   // Pending · Succeeded · Failed · Refunded
    ...(booking ? { Booking: [booking.id] } : {}),
    ...(p.note ? { Note: p.note } : {}),
  };
  if (existing) return { id: (await patchRow('Payments', existing.id, fields)).id, created: false };
  return { id: (await createRow('Payments', fields)).id, created: true };
}

async function logActivity(entry) {
  return createRow('Activity Log', {
    Timestamp: entry.timestamp || new Date().toISOString(),
    'Record Type': entry.recordType || 'Booking',
    'Record Ref': entry.ref,
    Event: entry.event,
    Detail: entry.detail || '',
    Actor: entry.actor || 'system',
  });
}

/* Webhook idempotency: a tiny ledger table "Webhook Events" (Event Id, Received).
   If you would rather not add a table, swap these two for a KV store. */
async function eventSeen(id) {
  return !!(await findBy('Webhook Events', 'Event Id', id));
}
async function markEvent(id) {
  return createRow('Webhook Events', { 'Event Id': id, Received: new Date().toISOString() });
}

/* ------------------------------------------------------------ comms (step 5)
   Used by comms/send.js. All optional-table-tolerant: a missing table degrades
   to "not found" rather than throwing, so sends aren't blocked before setup. */

async function patchLead(reference, fields) {
  const l = await getLead(reference);
  if (!l) throw new Error(`No Lead ${reference}`);
  return patchRow('Leads', l.id, fields);
}

/** Most recent Lead for a phone number (E.164 or 10-digit), or null. */
async function findLatestLeadByPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '').replace(/^1/, '');
  if (d.length < 10) return null;
  const formula = `RIGHT(SUBSTITUTE({Phone}, "-", ""), 10) = '${d.slice(-10)}'`;
  const data = await at(`${enc('Leads')}?maxRecords=1&sort%5B0%5D%5Bfield%5D=Created&sort%5B0%5D%5Bdirection%5D=desc&filterByFormula=${enc(formula)}`)
    .catch(() => ({ records: [] }));
  return data.records && data.records[0] ? data.records[0] : null;
}

/** Flip the opt-out flag on the Customer (and any open Lead) for a phone. */
async function setContactOptOut(phone, optedOut) {
  const d = String(phone || '').replace(/\D/g, '').replace(/^1/, '');
  const cust = await findBy('Customers', 'Phone', '1' + d).catch(() => null)
            || await findBy('Customers', 'Phone', d).catch(() => null);
  if (cust) await patchRow('Customers', cust.id, { 'SMS Opt-out': !!optedOut, 'Marketing Opt-in': optedOut ? false : cust.fields['Marketing Opt-in'] });
  return { updated: !!cust };
}

async function findMessage(dedupeKey) {
  return findBy('Messages', 'Dedupe Key', dedupeKey).catch(() => null);
}
async function recordMessage(m) {
  return createRow('Messages', {
    'Dedupe Key': m.dedupeKey,
    'Reference': m.reference || '',
    'Template': m.template,
    'Channel': m.channel,
    'To': m.to || '',
    'Status': m.status,
    'Provider Id': m.providerId || '',
    'Error': m.error || '',
    'Sent At': new Date().toISOString(),
  }).catch((e) => { console.error('[crm] recordMessage:', e.message); return null; });
}
async function appendFollowupStep(reference, step) {
  const l = await getLead(reference);
  if (!l) return null;
  const cur = String(l.fields['Followup Steps Sent'] || '');
  const set = new Set(cur.split(',').map((s) => s.trim()).filter(Boolean));
  set.add(String(step));
  return patchRow('Leads', l.id, {
    'Followup Steps Sent': [...set].join(','),
    'Next Follow-up': null,
  });
}

module.exports = {
  applyOps,
  getBooking,
  getLead,
  patchBooking,
  patchLead,
  recordPayment,
  logActivity,
  eventSeen,
  markEvent,
  findLatestLeadByPhone,
  setContactOptOut,
  findMessage,
  recordMessage,
  appendFollowupStep,
};
