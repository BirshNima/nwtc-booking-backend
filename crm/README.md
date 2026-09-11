# CRM — Northwest Town Car Service

Step 3 of the revenue core: give every website submission a home, deduplicated
and moved through a visible pipeline.

## Files

| File | Role |
|------|------|
| `index.html` | The blueprint — 11 tables with every field and type, the views that make it operable, the automations to configure, the intake contract, and a "stand it up in an afternoon" checklist. Read it, build the base. |
| `intake.js` | The transform. `NWTCIntake.funnelPayloadToCRM(payload)` turns one funnel submission into ordered CRM upserts. Pure, dependency-free, runs in Node, a Make code step, or an Airtable script action. |

## What `intake.js` does

```js
const { ops, summary } = NWTCIntake.funnelPayloadToCRM(payload);
// ops = [ { table, op:'upsert'|'create', matchOn, fields }, ... ]  — apply in order
```

- **Dedupes the person** — matches Customers on phone (digits, US-normalised to
  `1XXXXXXXXXX`), falls back to email. Updates the existing row.
- **Idempotent** — Leads, Quotes, Bookings upsert on the funnel `Reference`, so a
  double-submit or webhook retry touches the same rows.
- **Sets status from `kind` + `quote.method`:**
  - `reservation` → Lead *Booked*, Quote *Accepted*, creates a Booking
  - `quote-request` + `flat`/`hourly` → Lead *Quote Sent*, Next Follow-up +3 h
  - `quote-request` + `manual-quote` → Lead *New*, Quote *Draft* (dispatch prices it)
  - `corporate-lead` → upserts a Corporate Account (Prospect) on Company
- **Attribution** from the `source` URL — `utm_*`, or `gclid` → google / cpc.
- Emits an **Activity Log** row for every submission.

Link markers (`_linkCustomer`, `_linkLead`, `_linkCorporate`) tell the applier to
resolve an Airtable/CRM link from the record matched earlier in the same batch.

Verified against airport-reservation, wedding-manual-quote, corporate-lead, and
priced-hourly payloads: correct table order, statuses, dedupe keys, phone/email
normalisation, quote expiry, and follow-up scheduling.

## Wiring it in

1. Build the Airtable base per `index.html` §7 (start with Customers, Leads,
   Quotes, Bookings, Corporate Accounts, Activity Log).
2. Create a Make/Zapier scenario triggered by a webhook.
3. In the funnel, point the `INTEGRATION` fetch in `submitBooking()` at that
   webhook URL — POST the `payload` object.
4. In the scenario: a code step running `funnelPayloadToCRM`, then a loop that
   applies each op with "search records" → "create or update".
5. Test with three real funnel submissions; confirm the rows, statuses, and
   Activity Log entries.

## Not included (later steps)

- **Booking/payment** (step 4) — Stripe deposit links after dispatch confirms.
- **SMS/email** (step 5) — the automations in §5 need Twilio + a transactional
  email provider connected.
- **Analytics** (step 6) — GA4 events + a Looker Studio dashboard over the CRM.
- Standing the base up needs your Airtable (or HubSpot) account.
