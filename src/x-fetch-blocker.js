// Runs in the page's main JS world (world: "MAIN" in manifest.json).
// This bypasses the site's Content Security Policy, which blocks inline scripts.
// The isolated content script controls blocking via the data-feedless-active attribute.
(function () {
  'use strict';
  var PATTERNS = ['HomeTimeline'];
  var ATTR = 'data-feedless-active';
  var orig = window.fetch;
  if (!orig) return;

  window.fetch = function (input, init) {
    if (document.documentElement.hasAttribute(ATTR)) {
      var url = typeof input === 'string' ? input
        : input instanceof URL ? input.href
        : (input && input.url) || '';
      if (PATTERNS.some(function (p) { return url.indexOf(p) !== -1; })) {
        return new Promise(function () {});
      }
    }
    return orig.apply(this, arguments);
  };
})();
