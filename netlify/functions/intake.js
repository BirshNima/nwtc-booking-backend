/* PUBLIC. The booking funnel posts its payload here. See booking-payment/server.js
   for what this actually does — this file is just the Netlify Functions wrapper. */
'use strict';
const { handleIntake, netlify } = require('../../booking-payment/server.js');
exports.handler = netlify(handleIntake);
