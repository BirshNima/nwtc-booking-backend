/* ============================================================================
   Northwest Town Car Service — offline conversion export  (step 6 ↔ step 10)
   ----------------------------------------------------------------------------
   Google Ads optimizes to what you tell it converts. A form-fill is a weak
   signal; a paid deposit and a collected fare are the real ones. This builds
   the rows to feed back to Ads (and Microsoft Ads) keyed on the click id the
   funnel captured and the CRM Lead stored.

     buildConversionRows(records, opts) -> {
       googleAds:   [ { gclid, conversionName, conversionTime, value, currency } ],
       microsoft:   [ { msclkid, conversionName, conversionTime, value, currency } ],
       skipped:     [ { reference, reason } ]
     }

   Feed googleAds rows via:
     - the Google Ads UI  (Tools → Conversions → Uploads → "Conversions from clicks"), or
     - the Ads API OfflineUserDataJobService / ConversionUploadService.
   Two conversion actions, both "count once", in the Ads account:
     "Deposit paid"   — value = deposit amount
     "Fare collected" — value = total fare (primary; use for bidding)

   Pure. No network. Run it on a schedule against a CRM query of recently
   changed Bookings/Payments.
   ============================================================================ */
'use strict';

const DEFAULTS = {
  currency: 'USD',
  // Only upload clicks from the last 90 days — Ads rejects older ones.
  maxClickAgeDays: 90,
  actions: {
    depositPaid: 'Deposit paid',
    fareCollected: 'Fare collected',
  },
};

/**
 * @param {Array} records  CRM rows, each:
 *   {
 *     reference,
 *     clickId, clickIdType,     // 'gclid' | 'wbraid' | 'gbraid' | 'msclkid'
 *     clickTime,                // ISO — when the ad was clicked (Lead.Created is fine)
 *     depositPaid, depositPaidAt,
 *     fareCollected, fareCollectedAt,
 *   }
 * @param {object} [opts]  overrides of DEFAULTS
 */
function buildConversionRows(records, opts) {
  const cfg = { ...DEFAULTS, ...(opts || {}), actions: { ...DEFAULTS.actions, ...((opts || {}).actions || {}) } };
  const now = Date.now();
  const out = { googleAds: [], microsoft: [], skipped: [] };

  for (const r of records || []) {
    if (!r.clickId) { out.skipped.push({ reference: r.reference, reason: 'no click id — not from a tracked ad' }); continue; }

    const clickAgeDays = r.clickTime ? (now - new Date(r.clickTime).getTime()) / 864e5 : 999;
    if (clickAgeDays > cfg.maxClickAgeDays) {
      out.skipped.push({ reference: r.reference, reason: `click ${Math.round(clickAgeDays)}d old — past the ${cfg.maxClickAgeDays}d window` });
      continue;
    }

    const isMicrosoft = r.clickIdType === 'msclkid';
    const bucket = isMicrosoft ? out.microsoft : out.googleAds;
    const idField = isMicrosoft ? 'msclkid' : 'gclid';

    if (r.depositPaid > 0 && r.depositPaidAt) {
      bucket.push(row(idField, r.clickId, cfg.actions.depositPaid, r.depositPaidAt, r.depositPaid, cfg.currency));
    }
    if (r.fareCollected > 0 && r.fareCollectedAt) {
      bucket.push(row(idField, r.clickId, cfg.actions.fareCollected, r.fareCollectedAt, r.fareCollected, cfg.currency));
    }
    if (!(r.depositPaid > 0) && !(r.fareCollected > 0)) {
      out.skipped.push({ reference: r.reference, reason: 'no money yet — nothing to upload' });
    }
  }
  return out;
}

function row(idField, id, conversionName, timeISO, value, currency) {
  return {
    [idField]: id,
    conversionName,
    conversionTime: toAdsTime(timeISO),
    value: Math.round(Number(value) * 100) / 100,
    currency,
  };
}

/* Google Ads wants "yyyy-MM-dd HH:mm:ss+00:00" */
function toAdsTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+00:00`;
}

/** CSV for the Ads UI "Conversions from clicks" upload template. */
function toGoogleAdsCsv(rows) {
  const header = ['Google Click ID', 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Conversion Currency'];
  const lines = rows.map((r) => [r.gclid, r.conversionName, r.conversionTime, r.value, r.currency]
    .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  return ['Parameters:TimeZone=+0000', header.join(','), ...lines].join('\n');
}

module.exports = { buildConversionRows, toGoogleAdsCsv, DEFAULTS };
