# Ads &amp; corporate growth — Northwest Town Car Service

Step 10 of the revenue core. Paid search to buy demand now; a B2B motion to turn
one-off riders into recurring revenue.

## Files

| File | What it is |
|------|-----------|
| `index.html` | The plan — 12 sections. **Live:** https://claude.ai/code/artifact/b6f1ab2d-10a9-4b7d-9da2-716e0c70ccb4 |
| `outreach-templates.md` | 8 ready-to-send corporate-outreach templates: LinkedIn connect + message, a 3-email sequence, a hotel/venue partnership pitch, a pilot-proposal outline, and a referral ask. |

## The plan in one screen

1. **Strategy** — paid covers the gap while SEO builds; tracking before spend; start with one campaign and prove it.
2. **Account structure** — 7 search campaigns + Local Services Ads, tight ad groups, phrase/exact at launch, presence-targeted to your service area.
3. **Campaigns** — Airport, Branded, Corporate, Wedding, Hourly/wine, General — each with goal, ad groups, sample keywords, bidding, budget, and target CPA.
4. **Local Services Ads** — pay-per-lead, "Google Screened", often the best local ROI. Needs license + insurance verification (start early).
5. **Negative keywords** — shared lists (employment, price-shoppers, DIY, wrong service, wrong geo) that stop 20–35% of early waste.
6. **Ad copy** — full RSA asset sets (15 headlines / 4 descriptions) for Airport and Corporate, lead copy for the rest, plus every extension.
7. **Landing pages** — use the step-7 service pages; add `gclid` capture and deep-link paid traffic to the rate table.
8. **Conversion tracking — the gate** — GA4 events → conversions → Google Ads, enhanced conversions, call tracking, and **offline conversion import** from the CRM so Smart Bidding optimizes toward booked fares, not form fills.
9. **Microsoft Ads** — import from Google at −10–20% bids; Bing's older/corporate audience often wins the Corporate campaign per dollar.
10. **Budget tiers** — Lean ~$1–1.5k/mo, Standard ~$2.5–3.5k, Growth ~$5–7k — all contingent on tracking live and 30 days showing a workable cost per booked ride. Scaling rules included.
11. **Corporate growth** — ICP tiers (Eastside tech, downtown professional services, event planners, hotels), a partnership-first motion mirroring the CRM corporate pipeline, the pilot offer, and a 5-touch cadence with targets.
12. **Measurement &amp; 90-day plan** — a combined paid + corporate scorecard, and a phased rollout.

## What changed elsewhere for this

`crm/intake.js` now captures the **`GCLID`** (Google Ads click id) and **`Term`**
on every Lead — from an explicit `payload.gclid` or parsed from the landing URL
(`gclid` / `wbraid` / `gbraid`). The CRM Leads table gained matching fields.
This is what makes offline conversion import (§8) possible.

**Still to do on the site:** persist the `gclid` across the session (cookie +
hidden field) so it reaches the funnel `payload` even when the visitor navigates
from the ad landing page to `/book`.

## Depends on your access

Google Ads, Google Business Profile (for LSA + location extensions), GA4 + GTM,
a call-tracking account. Local Services Ads additionally need WUTC license and
insurance verification.
