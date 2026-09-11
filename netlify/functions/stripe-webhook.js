/* Stripe calls this directly — do not call it yourself. Verifies the webhook
   signature (STRIPE_WEBHOOK_SECRET) then marks deposits paid/failed/refunded.
   See booking-payment/server.js for the actual logic.
   rawBodyFor:'stripe' is required — signature verification needs the exact
   unparsed request body. */
'use strict';
const { handleStripeWebhook, netlify } = require('../../booking-payment/server.js');
exports.handler = netlify(handleStripeWebhook, { rawBodyFor: 'stripe' });
