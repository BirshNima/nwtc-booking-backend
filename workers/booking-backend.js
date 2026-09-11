/* ============================================================================
   Northwest Town Car Service — Cloudflare Worker entry point
   ----------------------------------------------------------------------------
   Thin wrapper: all the real logic lives in booking-payment/server.js (the
   `worker()` adapter). One Worker handles all four routes by URL path:

     POST /intake                public — the booking funnel
     POST /deposit-link          private (bearer DISPATCH_API_TOKEN) — dispatch
     POST /record-cash-payment   private (bearer DISPATCH_API_TOKEN) — dispatch/driver
     POST /stripe-webhook        Stripe calls this directly

   Env vars / secrets (set via `wrangler secret put <NAME>` or the Cloudflare
   dashboard — see booking-payment/config.example.env for the full list).
   ============================================================================ */
import { worker } from '../booking-payment/server.js';

export default worker();
