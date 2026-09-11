# Pricing engine — Northwest Town Car Service

The single source of truth for what a trip costs. The same calculation runs in
the customer's browser (to show a price) and on the server (to validate it).

## Files

| File | Role |
|------|------|
| `pricing-table.json` | **The master rate table.** Every rate, fee, minimum, and tier lives here and nowhere else. |
| `pricing-engine.js` | The calculation. Pure, dependency-free, runs in a browser or Node. Exposes `NWTCPricing.quote()` and `NWTCPricing.verifyQuote()`. |
| `index.html` | Reference implementation + admin tool: a live calculator, an editable copy of the table with change log and rollback, and a 39-scenario test suite. Open it directly or host it. It inlines copies of the table and engine — regenerate those blocks (or use the Export tab) when the real files change. |

## The calculation, in order

1. **Method** — `flat` if it's a SEA airport trip (or a cruise trip with a SEA leg) to a known service area in a sedan/SUV class; `hourly` for hourly service; otherwise `manual-quote` (weddings, events, crew, non-airport point-to-point, vans/Sprinters to the airport, unknown areas). Manual-quote returns no price — dispatch quotes it.
2. **Base rate** — the flat rate for the area+tier, or `billed hours × hourly rate` where `billed hours = max(requested, class minimum)`.
3. **Add-ons** — additional stops, child seats.
4. **Waiting** — billable minutes beyond the included window (60 airport / 15 non-airport) × per-minute rate.
5. **Discount** — from the account's corporate tier only. Never stacked. **Precedence:** a dispatch override amount beats a contract rate beats a tier discount.
6. **Fees** — fuel surcharge, booking fee (both default 0).
7. **Tax** — applied to discounted subtotal + fees (default 0 — see below).
8. **Gratuity** — on the discounted service subtotal, before tax and pass-through. Customer-adjustable unless the account fixes a policy.
9. **Pass-through** — parking and tolls shown as a non-binding estimate; billed at actual cost after the trip.

Every line is rounded to the whole dollar, and the total is the sum of the lines — so the displayed breakdown always adds up.

## Server-side contract (the important part)

The client price is **display only**. On every booking:

```js
const table = loadPricingTable();               // authoritative, server-side
const req = {
  ...clientRequest,                              // service, zone, vehicleClass, hours, stops, seats, waitMinutes, gratuityPct
  account: accountFromSession(),                 // corporateTier / contractRate / fixedGratuityPct — NEVER from the client
  adminOverrideAmount: dispatchOverrideOrNull(), // server-only
};
const check = NWTCPricing.verifyQuote(clientSubmittedTotal, req, table);
if (!check.valid) reject(`price mismatch: client ${check.clientAmount}, server ${check.serverAmount}`);
```

Rules this enforces:

- **Never trust a client price.** `verifyQuote` recomputes from scratch and compares.
- **Customers can't touch pricing parameters.** `corporateTier`, `contractRate`, `fixedGratuityPct`, and `adminOverrideAmount` are injected from the authenticated account / dispatch context. If the client sends them, ignore them.
- **No duplicate discounts.** The engine applies at most one, by the precedence above.
- **Corporate pricing never overrides a dispatch special quote** — `adminOverrideAmount` wins and suppresses the tier discount.

## Storing the price on the booking

Persist the full `quote()` result, not just the total:

```
baseRate, vehicleClass, route, method, lineItems[],
addOns, waiting, discount, fees, tax, gratuity, passThrough,
finalAmount, tableVersion, quotedAt, quoteExpiresHours
```

Then payment status, actual pass-through costs, and any post-trip adjustment
attach to the same record.

## Editing rates without code

Use the **Rate table** tab in `index.html`:

- Edit any value → **Apply** (updates the working copy) → **Save version** (records who/when/what, keeps a rollback point) → **Copy JSON** into `pricing-table.json` on the server.
- **Roll back** restores the table to its state before any saved version.

In production this screen sits behind admin auth, writes go through an
authenticated endpoint, and the change log lives in the database — but the
mechanics (versioned table, diff log, rollback) are exactly what's shown here.

## Tax — read before enabling

`tax.pct` ships at **0**. Washington's tax treatment of passenger ground
transportation varies by service type and jurisdiction. Confirm the correct
rate with the business's accountant before setting it. When set, it applies to
the discounted service subtotal plus fees — not gratuity, not pass-through.

## Testing

The **Tests** tab runs 39 scenarios covering every service area, both
directions, all vehicle classes, add-ons, waiting thresholds, each corporate
tier, override/contract precedence, and every manual-quote path. Each one
asserts the shown total equals `verifyQuote`'s recalculation; known-value
scenarios also assert an exact figure. Add scenarios to the `SCENARIOS` array
as rates change.
