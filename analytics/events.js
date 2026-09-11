/* ============================================================================
   Northwest Town Car Service — analytics  (revenue-core step 6)
   ----------------------------------------------------------------------------
   One small client-side module, loaded on every page and the funnel.

     NWTCAnalytics.init({ measurementId, debug })
     NWTCAnalytics.captureAttribution()      // run once per page load
     NWTCAnalytics.getAttribution()          // -> { firstTouch, lastTouch, gclid, ... }
     NWTCAnalytics.track(name, params)       // -> gtag('event', ...) + dataLayer
     NWTCAnalytics.funnelStep(n, name, extra) // convenience for the funnel

   It does NOT bundle gtag.js — add the standard GA4 snippet to the page head and
   this module rides on the `gtag`/`dataLayer` it creates. If gtag is absent
   (e.g. the standalone funnel artifact) every call is a safe no-op that still
   records to an in-memory log you can inspect via NWTCAnalytics._log.

   Attribution is stored in localStorage:
     nwtc_attr_first  — set once, first time we see this browser (immutable)
     nwtc_attr_last   — overwritten whenever a new campaign/referrer appears
   The funnel reads getAttribution() into its payload so the CRM Lead carries
   source / medium / campaign / gclid, which step 10's offline-conversion import
   needs.
   ========================================================================== */
(function (global) {
  'use strict';

  var FIRST_KEY = 'nwtc_attr_first';
  var LAST_KEY = 'nwtc_attr_last';
  var CLICK_IDS = ['gclid', 'wbraid', 'gbraid', 'msclkid', 'fbclid'];
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  var cfg = { measurementId: '', debug: false };
  var mem = [];

  function init(opts) {
    opts = opts || {};
    cfg.measurementId = opts.measurementId || cfg.measurementId;
    cfg.debug = !!opts.debug;
    captureAttribution();
    return api;
  }

  /* ---- attribution ------------------------------------------------------ */
  function readParams() {
    var out = {};
    try {
      var p = new URLSearchParams(global.location.search);
      UTM.forEach(function (k) { if (p.get(k)) out[k] = p.get(k); });
      CLICK_IDS.forEach(function (k) { if (p.get(k)) out[k] = p.get(k); });
    } catch (e) {}
    return out;
  }

  function classify(params, referrer) {
    var src = params.utm_source, med = params.utm_medium, camp = params.utm_campaign || '';
    var clickId = firstOf(params, CLICK_IDS);
    if (!src && clickId) {
      if (params.gclid || params.wbraid || params.gbraid) { src = 'google'; med = 'cpc'; }
      else if (params.msclkid) { src = 'bing'; med = 'cpc'; }
      else if (params.fbclid) { src = 'facebook'; med = 'paid-social'; }
    }
    if (!src) {
      var ref = (referrer || '').toLowerCase();
      if (!ref) { src = 'direct'; med = 'none'; }
      else if (/google\.|bing\.|duckduckgo|yahoo\./.test(ref)) { src = ref.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]; med = 'organic'; }
      else if (/facebook|instagram|t\.co|linkedin|reddit/.test(ref)) { src = ref.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]; med = 'social'; }
      else { src = ref.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]; med = 'referral'; }
    }
    return {
      source: src || 'direct',
      medium: med || 'none',
      campaign: camp,
      term: params.utm_term || '',
      content: params.utm_content || '',
      clickId: clickId || '',
      clickIdType: clickId ? keyOf(params, CLICK_IDS) : '',
      landing: safePath(),
      at: new Date().toISOString()
    };
  }

  function captureAttribution() {
    var params = readParams();
    var hasSignal = Object.keys(params).length > 0;
    var referrer = '';
    try { referrer = global.document && global.document.referrer || ''; } catch (e) {}
    var internal = false;
    try { internal = referrer && new URL(referrer).host === global.location.host; } catch (e) {}

    var attr = classify(params, referrer);

    // first-touch: write once
    if (!ls(FIRST_KEY)) ls(FIRST_KEY, attr);

    // last-touch: update on a real new signal (campaign params or an external referrer)
    if (hasSignal || (referrer && !internal)) ls(LAST_KEY, attr);
    else if (!ls(LAST_KEY)) ls(LAST_KEY, attr);

    return getAttribution();
  }

  function getAttribution() {
    var first = ls(FIRST_KEY) || null;
    var last = ls(LAST_KEY) || first;
    return {
      firstTouch: first,
      lastTouch: last,
      // flat helpers for the funnel payload / CRM:
      source: last ? last.source : 'direct',
      medium: last ? last.medium : 'none',
      campaign: last ? last.campaign : '',
      term: last ? last.term : '',
      gclid: last && /gclid|wbraid|gbraid/.test(last.clickIdType) ? last.clickId : '',
      clickId: last ? last.clickId : '',
      clickIdType: last ? last.clickIdType : '',
      landingPage: first ? first.landing : safePath()
    };
  }

  /* ---- events --------------------------------------------------------- */
  function track(name, params) {
    var payload = Object.assign({}, params || {});
    var a = getAttribution();
    // attach attribution as event params -> becomes usable in GA4 explorations
    payload.nwtc_source = a.source;
    payload.nwtc_medium = a.medium;
    if (a.campaign) payload.nwtc_campaign = a.campaign;
    if (a.clickId) payload.nwtc_click_id = a.clickId;

    mem.push({ t: Date.now(), name: name, params: payload });
    if (mem.length > 200) mem.shift();

    try {
      if (typeof global.gtag === 'function') {
        global.gtag('event', name, payload);
      } else if (Array.isArray(global.dataLayer)) {
        global.dataLayer.push(Object.assign({ event: name }, payload));
      }
    } catch (e) {}
    if (cfg.debug) try { console.debug('[nwtc:analytics]', name, payload); } catch (e) {}
  }

  function funnelStep(n, name, extra) {
    track('funnel_step', Object.assign({ step_index: n, step_name: name }, extra || {}));
  }

  /* Standard events — call these from the funnel / pages.
     Keep names stable: they become GA4 key events and Ads conversions. */
  var EVENTS = {
    PAGE_CTA_BOOK: 'cta_book_click',
    PAGE_CTA_QUOTE: 'cta_quote_click',
    PAGE_CALL: 'call_click',
    FUNNEL_START: 'funnel_start',
    FUNNEL_STEP: 'funnel_step',
    QUOTE_SHOWN: 'quote_shown',            // instant price displayed
    QUOTE_SUBMIT: 'generate_lead',         // GA4 recommended name; params tag the kind
    RESERVATION: 'reservation_submitted',
    QUOTE_REQUEST: 'quote_requested',
    CORPORATE_LEAD: 'corporate_lead',
    DEPOSIT_PAID: 'deposit_paid'           // usually fired server-side; here for completeness
  };

  /* ---- storage helpers ---------------------------------------------- */
  function ls(key, val) {
    try {
      if (val === undefined) {
        var raw = global.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      }
      global.localStorage.setItem(key, JSON.stringify(val));
      return val;
    } catch (e) { return val === undefined ? null : val; }
  }
  function firstOf(o, keys) { for (var i = 0; i < keys.length; i++) if (o[keys[i]]) return o[keys[i]]; return ''; }
  function keyOf(o, keys) { for (var i = 0; i < keys.length; i++) if (o[keys[i]]) return keys[i]; return ''; }
  function safePath() { try { return global.location.pathname + global.location.search; } catch (e) { return ''; } }

  var api = {
    init: init,
    captureAttribution: captureAttribution,
    getAttribution: getAttribution,
    track: track,
    funnelStep: funnelStep,
    EVENTS: EVENTS,
    _log: mem
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.NWTCAnalytics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
