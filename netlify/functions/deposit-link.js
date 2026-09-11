/* PRIVATE — dispatch only (bearer DISPATCH_API_TOKEN). Call this AFTER
   confirming a ride to send the Stripe deposit link (or record cash intent).
   See booking-payment/server.js for the actual logic. */
'use strict';
const { handleDepositLink, netlify } = require('../../booking-payment/server.js');
exports.handler = netlify(handleDepositLink);
