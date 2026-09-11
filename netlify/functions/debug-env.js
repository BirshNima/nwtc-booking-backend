/* TEMPORARY diagnostic — confirms which env vars Netlify is actually injecting
   into the function runtime, without ever revealing their values. Delete this
   file once STRIPE_SECRET_KEY / AIRTABLE_* are confirmed working. */
'use strict';
exports.handler = async () => {
  const names = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SITE_ORIGIN',
    'DISPATCH_API_TOKEN', 'DISPATCH_EMAIL', 'AIRTABLE_TOKEN', 'AIRTABLE_BASE_ID',
    'SITE_ORIGIN_FROM_TOML', 'SITE_ORIGIN_FROM_FUNCTIONS_TOML'];
  const report = {};
  for (const n of names) {
    const v = process.env[n];
    report[n] = v ? { present: true, length: v.length, startsWith: v.slice(0, 6) } : { present: false };
  }
  // Every env var key Netlify actually injects into this function, sorted.
  // Names only, never values — lets us see if custom vars show up at all
  // (vs. only Netlify's own built-ins like NETLIFY, DEPLOY_URL, URL, etc.)
  const allKeys = Object.keys(process.env).sort();
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checked: report, allKeyNamesInjected: allKeys }, null, 2),
  };
};
