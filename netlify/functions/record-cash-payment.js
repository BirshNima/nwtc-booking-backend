/* PRIVATE — dispatch/driver only (bearer DISPATCH_API_TOKEN). Call this after
   a cash trip to mark what the driver actually collected. See
   booking-payment/server.js for the actual logic. */
'use strict';
const { handleRecordCash, netlify } = require('../../booking-payment/server.js');
exports.handler = netlify(handleRecordCash);
