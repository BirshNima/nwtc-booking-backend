# Booking & payment — Northwest Town Car Service

Step 4 of the revenue core. Takes the deposit **after** a human confirms the ride.
The funnel never touches a card; the customer only ever enters card details on
Stripe's hosted Checkout page, reached by a link dispatch chooses to send.

Reference doc / blueprint: `index.html` → https://claude.ai/code/artifact/700f56c4-35d3-4a02-a7c2-6260f3428c49

## Files

| File | What it is |
|------|-----------|
| `deposit.js` | Pure module. `NWTCPayments.depositPlan(booking, table)` + `checkoutSessionParams(...)`. Deposit policy lives in `pricing-table.json → deposit`, not here. Dependency-free, same pattern as `pricing-engine.js`. |
| `server.js` | The three endpoints — `handleIntake`, `handleDepositLink`, `handleStripeWebhook` — framework-agnostic, with Netlify / Cloudflare Workers / Express adapters at the bottom. |
| `crm-airtable.js` | The only file that knows Airtable's REST API. Swap this to move CRMs. |
| `config.example.env` | Every env var, commented. Copy to `.env`. |
| `index.html` | The blueprint: money-flow diagram, endpoint specs, deposit table, webhook events, test checklist. |

## The flow

```
funnel submit
  → POST /intake            re-price, write CRM, alert dispatch      [no money]
  → ◆ dispatch confirms the ride                                    [the gate]
  → POST /deposit-link      create Stripe Checkout Session          [dispatch only]
  → confirmation SMS/email  carries the checkoutUrl
  → customer pays on Stripe's hosted page
  → POST /stripe-webhook    Payment Succeeded, Booking Deposit Paid  [auto]
```

## Wiring the funnel

`homepage-redesign/booking-funnel/index.html` posts to `/intake` when `window.NWTC_INTAKE_ENDPOINT`
is set (e.g. in the page template or a small inline script before the funnel
script). Left unset, the funnel runs standalone — localStorage + the
"email dispatch" fallback button only. On a failed post the confirmation screen
tells the customer to use that button or call.

## Deposit policy (edit in `pricing-table.json`, not code)

| Ride type | Deposit | Refundable |
|-----------|---------|-----------|
| Airport flat / hourly | $50 flat | to 24h before pickup |
| Wedding / event / out-of-area | 25% of fare (dispatch can override) | to 24h before pickup |
| Corporate | none — on account | — |

Floor `minAmount` $25; never more than the fare. These are the runbook's
Decision 1 defaults — change the four values under `"deposit"` and bump `version`.

## What stays manual

Refunds, in-window cancellation fees, deposit waivers, releasing a held booking,
corporate billing. The code records these; it never decides them.

## Deploy

1. `.env` from `config.example.env` — Stripe **test** keys first.
2. Airtable: add `Webhook Events` table; add the deposit fields to `Bookings`.
3. Deploy the three handlers; add the Stripe webhook endpoint + 4 events.
4. Set `NWTC_INTAKE_ENDPOINT` on the funnel.
5. Run the 8-step test checklist in `index.html §6` (Stripe test cards + CLI).
6. Swap to live keys only when all 8 pass.

PCI: Checkout is hosted by Stripe, so card data never reaches these servers
(SAQ-A). Do not add card fields anywhere.
