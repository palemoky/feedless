// Runs in the page's main JS world (world: "MAIN" in manifest.json).
// This bypasses the site's Content Security Policy, which blocks inline scripts.
// The isolated content script controls blocking via two attributes on <html>:
//   data-feedless-active  present → blocking is on
//   data-feedless-block   comma-separated URL substrings to block (from sites.js)
(function () {
  'use strict';
  var ACTIVE_ATTR = 'data-feedless-active';
  var PATTERN_ATTR = 'data-feedless-block';
  var orig = window.fetch;
  if (!orig) return;

  window.fetch = function (input, init) {
    var de = document.documentElement;
    if (de.hasAttribute(ACTIVE_ATTR)) {
      var raw = de.getAttribute(PATTERN_ATTR) || '';
      var patterns = raw ? raw.split(',') : [];
      if (patterns.length) {
        var url = typeof input === 'string' ? input
          : input instanceof URL ? input.href
          : (input && input.url) || '';
        if (patterns.some(function (p) { return p && url.indexOf(p) !== -1; })) {
          return new Promise(function () {});
        }
      }
    }
    return orig.apply(this, arguments);
  };
})();
