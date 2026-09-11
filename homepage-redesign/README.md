# Homepage + service-page redesign — Northwest Town Car Service

Step 7 of the revenue core. The pages that turn traffic into bookings, wired to
the funnel so a visitor lands in a working sales system, not another contact form.

## Files

| File | Live preview |
|------|--------------|
| `index.html` — homepage | https://claude.ai/code/artifact/512f79cc-ca9b-4c1e-b2fd-80647f25cd88 |
| `airport-transportation.html` | https://claude.ai/code/artifact/0e97705c-3e13-4d96-86fe-0e55a4cd6381 |
| `corporate-transportation.html` | https://claude.ai/code/artifact/273bcaa5-56cf-4375-9111-1c41ead44fae |
| `hourly-chauffeur.html` | https://claude.ai/code/artifact/1166d2e8-25f4-4211-be22-6090fada7f21 |
| `wedding-transportation.html` | https://claude.ai/code/artifact/3229fb52-575b-4fc6-8950-9af4408f6803 |
| `point-to-point.html` | https://claude.ai/code/artifact/18382ffc-b392-4839-8bab-41d9ba6837da |
| `cruise-wine-tours.html` | https://claude.ai/code/artifact/92288df2-4edd-40ac-b290-ff6d0ca5ac6b |
| `service-area/*.html` — **all 14 city pages** | https://claude.ai/code/artifact/c99b51b8-e950-4411-85e0-61fa187d490f (tabbed preview) |
| `blog/*.html` — **12 journal posts** | https://claude.ai/code/artifact/444473ee-ca79-408f-ac3d-cd4bd2c458f6 (tabbed preview) |
| Launch runbook (how to take all of this live) | https://claude.ai/code/artifact/8c911646-dea0-4824-8239-9a5534bb9f33 |
| Booking &amp; payment blueprint (step 4) | https://claude.ai/code/artifact/700f56c4-35d3-4a02-a7c2-6260f3428c49 |
| SMS &amp; email blueprint (step 5) | https://claude.ai/code/artifact/34669a90-1ea7-490a-a1fe-2a1fd3e88358 |
| Analytics blueprint (step 6) | https://claude.ai/code/artifact/b303768f-b2cc-4a31-9e94-0b64fa1d7cde |
| `_*.frag.html` | Publish copies (wrappers stripped, cross-links pointed at the artifact URLs). Regenerate from the `.html` files. |

All six services and **all fourteen service areas** (Kent, Bellevue, Redmond,
Kirkland, Tacoma, Seattle, Renton, Federal Way, Auburn, Puyallup, Lynnwood,
Edmonds, Everett, Gig Harbor) have a page, plus the **full 12-post journal** from
the SEO content calendar.
Each city page carries the real SEA flat rate, honest drive times, the specific
routes and chokepoints, named pickup neighborhoods, and `Service` + `FAQPage`
schema — written so no paragraph survives a find-and-replace to another city.
The homepage has a Journal section and its coverage grid links all 14 cities.
Local `.html` files cross-link with relative paths; the two tabbed preview
artifacts cross-link by URL. On deploy each is an independent page
(`/service-area/<city>`, `/blog/<slug>`).

The local `.html` files use relative links (`airport-transportation.html`,
`index.html#areas`, `service-area/<city>.html`, `booking-funnel/index.html`).
This folder is now **self-contained and deployable as the web root** — the
booking funnel lives at `booking-funnel/` inside it, so every "Book a ride" CTA
resolves both when served locally and once deployed. On deploy you can still
prettify the paths (`/`, `/airport-transportation`, `/book`) but nothing is
broken as-is. The two tabbed preview artifacts (`_*.frag.html`) cross-link by
claude.ai URL instead and are not part of the deployable tree.

## The 5-second test

A visitor to the homepage learns, above the fold:

- **What** — "chauffeurs who already know the way", the six services
- **Where** — "Seattle & the Puget Sound", cities named on the rate board
- **Why trust it** — Licensed WUTC · insured · dispatch 24/7 · flights tracked, plus published prices (transparency reads as confidence)
- **How to book** — three buttons: Book a ride / Get a quote / Call, and the phone number in the sticky header on every scroll

## Audit of the current site — keep / improve / remove / rebuild

**Keep**
- The evergreen + brass + cream identity, Fraunces + Work Sans. It's distinctive and it's yours — the redesign builds on it.
- The voice: "Every route, handled." / "A car is waiting. So is your schedule." Kept verbatim.
- "One dispatcher, one number" positioning and the 24/7 promise.
- The genuine Kent testimonial (the only real review on the current site).

**Improve**
- **Hero** → now leads with a live rate board (real flat prices) and three explicit CTAs. The old hero said nothing about price or online booking.
- **Services** → 3 vague cards became 6, each linking to a dedicated page.
- **Fleet** → capacities now stated accurately (sedan 3, SUV 6, Sprinter 14) and matched to the pricing engine's vehicle classes.
- **Trust** → licensing, insurance, and WUTC status surfaced instead of buried.
- **Contact** → the sticky phone + booking button replace a single top-right pill.

**Remove**
- The `<form action="mailto:" enctype="text/plain">` — unreliable, untrackable, no CRM. Replaced by the funnel.
- The personal `birhanunima@yahoo.com` address in the primary contact position. The footer now uses `booking@northwesttowncarservice.com` (set up this mailbox on the domain, or forward it, before launch).
- The unrelated "Towne Car Co." mock that was at the repo root (`index.html`) — wrong brand; deleted 2026-09-06.
- Vague filler ("Since day one").

**Rebuild**
- **Information architecture** → homepage + one page per service + one page per service area (14). Two service pages are done here as the template; the rest follow the same shell (below).
- **Pricing presentation** → every price on these pages comes from `pricing/pricing-table.json`. When rates change there, update the rate board (homepage hero + airport spotlight) and the airport rate table.
- **Technical SEO** → titles, meta descriptions, Open Graph, and JSON-LD (`LimousineService` on the homepage, `Service` + `FAQPage` on the airport page, `Service` on corporate) are in place. Still to add on deploy: a sitemap, canonical tags, and real `og:image`.

## Service-area pages (still to build)

The homepage coverage grid links to `/service-area/<city>.html` for all 14
zones; those pages don't exist yet. They're lighter: hero with that
city's SEA rate, a paragraph of genuinely local detail (routes, pickup notes,
neighbourhoods served), the vehicle list, and a CTA. **Do not** mass-generate
thin near-duplicates — write each one only where you have real local content.

## Reviews

The pages show the one real testimonial from the current site. **Do not add
invented or placeholder reviews.** Pull 2–3 genuine reviews from your Google
Business Profile and drop them into the marked comment blocks (`<!-- Add real
Google reviews here -->`) in `index.html` and `airport-transportation.html`.
