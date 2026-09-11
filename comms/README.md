# SMS & email — Northwest Town Car Service

Revenue-core step 5. Every automated message: confirmations, the deposit link,
the 24-hour reminder, review requests, and the day 0/1/3/7 quote follow-up.

Blueprint: `index.html` → https://claude.ai/code/artifact/34669a90-1ea7-490a-a1fe-2a1fd3e88358

## Files

| File | What it is |
|------|-----------|
| `messages.js` | Pure. All templates in one place. `NWTCComms.plan(trigger, ctx)` → the messages to send (consent + quiet-hours filtered). `render(id, vars)` → `{subject?, text}`. |
| `sequences.js` | Pure state machine. `NWTCSequence.nextAction(lead)` → `send` / `wait` / `stop` / `handoff` for the 4-touch quote follow-up. |
| `send.js` | Delivery: Twilio SMS + JSON email (Postmark shape). Dedupe on `<ref>:<template>`, retry once on 5xx, log to CRM. `handleInboundSms()` for STOP/START/HELP and to halt the sequence on any reply. |
| `config.example.env` | Copy to `.env`. |
| `index.html` | Message inventory, sequence + stop conditions, SMS compliance, failure handling, deploy checklist. |

Adds to `booking-payment/crm-airtable.js`: `patchLead`, `findLatestLeadByPhone`,
`setContactOptOut`, `findMessage`, `recordMessage`, `appendFollowupStep`.

## Channel policy (runbook decision 5)

- Transactional (confirmations, deposit, reminder, receipt) → **SMS + email**
- Quote follow-up day 0 / day 1 → **SMS**
- Quote follow-up day 3 / day 7 → **email**
- Marketing / win-back → **not here** (separate opt-in list)

## The sequence stops on

Lead → Booked/Won/Lost/Cancelled · any inbound reply · STOP · pickup date passed.
Manual-quote with no `Quote Sent At` → `handoff` (dispatch prices it first).

## Compliance

- **A2P 10DLC**: register brand + campaign before first send (1–3 wk). Use a
  Messaging Service SID.
- **Consent**: funnel checkbox → `Consent` / `Marketing Opt-in`. `plan()` drops
  SMS when `smsConsent === false`.
- **STOP/START/HELP**: `handleInboundSms()` — point the Twilio inbound webhook at it.
- **Quiet hours**: SMS between 20:00–08:00 PT shifts to 08:05. Email unaffected.

## Deploy

1. Twilio number + 10DLC registration.
2. Email sender + SPF/DKIM on the domain.
3. Airtable: add `Messages` table; add `Customer Replied` / `Needs Reply` /
   `Followup Steps Sent` to Leads, `SMS Opt-out` to Customers.
4. `.env` with `COMMS_DRY_RUN=1`.
5. CRM automations call `deliverAll(NWTCComms.plan(trigger, ctx))`.
6. Hourly job runs `NWTCSequence.nextAction()` over open quotes.
7. Test STOP, then dry-run one of each message, then go live.
