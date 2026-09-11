# Booking + quote funnel — Northwest Town Car Service

A self-contained, mobile-first reservation flow wired to the pricing engine. No
build step, no dependencies, no backend required to demo it.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The whole thing — markup, styles, the pricing engine + table, and the funnel script in one file. This is the deliverable. |
| `_artifact-preview.html` | Same page with the `<!doctype>`/`<head>` wrapper stripped, for publishing as a Claude Artifact. Generated from `index.html`; don't edit by hand. |

## Flow

Six steps, one visible at a time, progress saved to `localStorage`:

1. **Service** — airport pickup/drop-off and hourly are **priced instantly**; point-to-point, round trip, wedding/event, and cruise come back as a **custom quote**; corporate opens a short account-setup form.
2. **Trip** — airport trips ask for the service area (the 14 flat-rate zones) plus exact addresses; hourly asks hours + start; the quote-only services just take pickup/drop-off.
3. **Schedule** — date, time, return leg for round trips, passengers, bags, vehicle (Executive Sedan / Premium SUV / Sprinter Van / let us choose), auto-suggested from party size.
4. **Details** — flight number, extra stops, child seats, meet & greet, notes, gratuity toggle.
5. **Contact** — name, phone, email, consent.
6. **Review** — the fork:
   - **Price available** → itemized breakdown from the engine, `Reserve this ride`. On submit: reservation confirmed at the quoted price (held 72 h), "text + email on the way", "dispatch confirms then sends a deposit link".
   - **Custom quote** → the engine's reason for why, `Send quote request`. On submit: "quote request received, no card needed, written quote within the hour."
   - **Corporate** → `Send my request` → "a specialist will call within one business day."

No card details are ever collected here — payment is a Stripe link sent *after*
dispatch confirms, per the system blueprint.

## Pricing

The `<script>` blocks near the bottom are **inlined copies** of
`../pricing/pricing-table.json` and `../pricing/pricing-engine.js`. When the rate
table changes, regenerate both blocks (or paste a fresh export from the pricing
admin screen). The funnel calls `NWTCPricing.quote()` with a request it builds
from the form answers — same calculation the server uses to validate.

Funnel vehicle → engine class: Executive Sedan → `executive-sedan`, Premium SUV →
`premium-suv`, Sprinter Van → `sprinter`, "Let us choose" → picked by passenger
count. (The Luxury tiers in the rate table aren't offered in the funnel yet.)

## Wiring it up

The funnel is already wired to `../booking-payment/` (revenue-core step 4). On
submit it POSTs the `payload` to `window.NWTC_INTAKE_ENDPOINT` — retries once,
and shows a fallback message + the "email dispatch" button if it never lands.
Set that global to the deployed `/intake` URL, e.g. in the page template:

```html
<script>window.NWTC_INTAKE_ENDPOINT = "https://api.northwesttowncarservice.com/intake";</script>
```

`booking-payment/server.js` does the rest: re-prices with
`NWTCPricing.verifyQuote()` (never trusts the client total), writes the CRM via
`NWTCIntake.funnelPayloadToCRM()`, alerts dispatch. The Stripe deposit link is a
separate dispatch-triggered call (`/deposit-link`) — never from this form, and
there is no card field here. See `booking-payment/README.md`.

Leave `NWTC_INTAKE_ENDPOINT` unset to run the funnel standalone (localStorage +
the email-dispatch button only).

## Putting it on the site

- **Static host** (Netlify drop, Cloudflare Pages): upload `index.html`.
- **WordPress / Elementor**: paste the `<style>`, the markup between `<header>`
  and `</footer>`, and the three `<script>` blocks into an HTML widget on a new
  "Book Online" page.

## Known limitations (it's a prototype)

- Submissions log to `localStorage` under `nwtc_bookings`; they also POST to the
  intake endpoint when `NWTC_INTAKE_ENDPOINT` is set.
- Round trips are sent as custom quotes (return-timing logic belongs server-side).
- No abandoned-booking recovery, CRM sync, or SMS — those live in the automation layer.
- `localStorage` and `navigator.clipboard` may be restricted on `file://`; use a
  static server (`python3 -m http.server`) for a faithful local test.
