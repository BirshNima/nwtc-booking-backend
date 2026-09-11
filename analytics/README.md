# Analytics — Northwest Town Car Service

Revenue-core step 6. Measure impression → click → funnel → quote → booking →
deposit → collected fare, and feed the money events back to Google Ads.

Blueprint: `index.html` → https://claude.ai/code/artifact/b303768f-b2cc-4a31-9e94-0b64fa1d7cde

## Files

| File | What it is |
|------|-----------|
| `events.js` | The only thing that ships to the browser. `NWTCAnalytics.init()`, `captureAttribution()` (first + last touch → localStorage), `getAttribution()` (feeds the funnel payload), `track(name, params)` (rides on the page's gtag; safe no-op if absent). |
| `offline-conversions.js` | Pure. `buildConversionRows(records)` → Google Ads / Microsoft upload rows keyed on the click id. `toGoogleAdsCsv()` matches the "Conversions from clicks" template. Skips clicks > 90 days. |
| `config.example.env` | GA4 id + Measurement Protocol secret; Ads API creds (or export CSV from the UI and skip them). |
| `index.html` | GA4 setup, event taxonomy, the lead-to-fare funnel with data sources, KPIs, offline-conversion import, verify checklist. |

## The chain

1. `events.js` on every page captures attribution and fires named events through GA4.
2. The funnel reads `getAttribution()` into its `payload` → CRM Lead gets
   `source / medium / campaign / gclid`.
3. Weekly, `buildConversionRows()` turns paid deposits + collected fares into
   Ads upload rows → Ads bids on revenue, not form-fills.

## Event names (stable — they become GA4 key events + Ads conversions)

`cta_book_click` · `cta_quote_click` · `call_click` · `funnel_start` ·
`funnel_step` · `quote_shown` · `generate_lead` · `reservation_submitted` ·
`quote_requested` · `corporate_lead` · `deposit_paid`

## Setup

1. GA4 property + web stream; gtag snippet + `events.js` + `init({measurementId})`
   on every page.
2. Mark key events; register custom dimensions (`nwtc_source`, `nwtc_medium`,
   `nwtc_campaign`, `nwtc_click_id`, `service`, `service_area`, `quote_method`,
   `quote_value`).
3. Link Search Console.
4. Add `track()` calls to CTAs, `tel:` links, and the funnel (`goTo()` +
   `submitBooking()`).
5. Verify in DebugView with `?gclid=TEST123&utm_source=google&utm_medium=cpc`.
6. Two Ads conversion actions: `Deposit paid`, `Fare collected` (primary).
7. Only then turn on ad spend (growth plan, Phase E).

## Do not

Recommend broad ad spend before this chain is proven end-to-end with a live test.
