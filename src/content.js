(function () {
  'use strict';

  const hostname = location.hostname.replace(/^www\./, '');
  const site = SITES.find(s =>
    s.hostnames.some(h => h.replace(/^www\./, '') === hostname)
  );

  if (!site) return;

  const STYLE_ID = 'feedless-styles';

  function shouldApplyOnCurrentPath() {
    if (!site.paths) return true;
    return site.paths.includes(location.pathname);
  }

  function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = site.selectors
      .map(s => `${s}{display:none!important}`)
      .join('');
    document.documentElement.appendChild(style);
  }

  function removeCSS() {
    document.getElementById(STYLE_ID)?.remove();
  }

  function apply(enabled) {
    if (enabled && shouldApplyOnCurrentPath()) {
      injectCSS();
    } else {
      removeCSS();
    }
  }

  chrome.storage.sync.get({ disabledSites: [] }, ({ disabledSites }) => {
    apply(!disabledSites.includes(site.id));
  });

  // Listen for toggle from popup (no page reload needed)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'feedless:toggle' && msg.siteId === site.id) {
      apply(msg.enabled);
    }
  });

  // Handle SPA navigation for sites with path-restricted rules (e.g. X)
  if (site.paths) {
    let lastPath = location.pathname;
    const navObserver = new MutationObserver(() => {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      chrome.storage.sync.get({ disabledSites: [] }, ({ disabledSites }) => {
        apply(!disabledSites.includes(site.id));
      });
    });
    navObserver.observe(document.documentElement, { subtree: true, childList: true });
  }
})();
