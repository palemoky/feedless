(function () {
  'use strict';

  const hostname = location.hostname.replace(/^www\./, '');
  const site = SITES.find(s =>
    s.hostnames.some(h => h.replace(/^www\./, '') === hostname)
  );
  if (!site) return;

  const STYLE_ID = 'feedless-styles';
  const FETCH_ATTR = 'data-feedless-active';
  const PLACEHOLDER_ID = 'feedless-placeholder';
  const strategy = site.strategy || 'css';

  // State for 'remove' strategy
  let removalObserver = null;
  let activelyRemoving = false;

  // State for 'spacer' strategy
  let managedSection = null;
  let sectionGuard = null;  // observer that keeps the section clean

  // Cached enabled state (set after first storage check; avoids repeated async lookups)
  let isEnabled = null;

  // ─── helpers ─────────────────────────────────────────────────────────────────

  function shouldApply() {
    if (!site.paths) return true;
    return site.paths.includes(location.pathname);
  }

  // ─── CSS strategy ────────────────────────────────────────────────────────────

  function injectCSS() {
    if (!site.selectors?.length || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = site.selectors.map(s => `${s}{display:none!important}`).join('');
    document.documentElement.appendChild(style);
  }

  function removeCSS() {
    document.getElementById(STYLE_ID)?.remove();
  }

  // ─── Remove strategy ─────────────────────────────────────────────────────────

  function removeMatchingIn(root) {
    for (const sel of site.selectors) {
      try { root.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
    }
  }

  function startRemoval() {
    if (activelyRemoving) return;
    activelyRemoving = true;
    removeMatchingIn(document);
    removalObserver = new MutationObserver((mutations) => {
      for (const { addedNodes } of mutations) {
        for (const node of addedNodes) {
          if (node.nodeType !== 1) continue;
          for (const sel of site.selectors) {
            try {
              if (node.matches(sel)) { node.remove(); break; }
              node.querySelectorAll(sel).forEach(el => el.remove());
            } catch {}
          }
        }
      }
    });
    removalObserver.observe(document.documentElement, { subtree: true, childList: true });
  }

  function stopRemoval() {
    removalObserver?.disconnect();
    removalObserver = null;
    activelyRemoving = false;
  }

  // ─── Spacer strategy ─────────────────────────────────────────────────────────
  //
  // The key insight: hiding or removing tweets collapses the container, which
  // makes X's IntersectionObserver sentinel enter the viewport and trigger more
  // loads. Instead, we replace the feed section with a full-height placeholder
  // so the sentinel is always pushed below the fold. We also block the
  // HomeTimeline fetch as a secondary defense.

  function injectFetchBlocker() {
    const patterns = JSON.stringify(site.fetchBlockPatterns || []);
    const script = document.createElement('script');
    script.textContent = `(function(){
  var P=${patterns},A="${FETCH_ATTR}",F=window.fetch;
  if(!F)return;
  window.fetch=function(input,init){
    if(document.documentElement.hasAttribute(A)){
      var url=typeof input==="string"?input:input instanceof URL?input.href:input&&input.url||"";
      if(P.some(function(p){return url.indexOf(p)!==-1}))return new Promise(function(){});
    }
    return F.apply(this,arguments);
  };
})();`;
    document.documentElement.appendChild(script);
    script.remove();
  }

  function buildPlaceholder() {
    const ph = document.createElement('div');
    ph.id = PLACEHOLDER_ID;
    // min-height:100vh ensures the sentinel (placed after our placeholder by X)
    // is always below the viewport, so IntersectionObserver never fires.
    ph.style.cssText = 'min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding-top:80px;box-sizing:border-box';
    const msg = document.createElement('div');
    msg.style.cssText = 'color:#536471;font-size:15px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
    msg.textContent = '推荐已屏蔽';
    ph.appendChild(msg);
    return ph;
  }

  function claimSection(section) {
    if (section === managedSection) return;
    releaseSection();
    managedSection = section;

    // Replace section content with our placeholder
    while (section.firstChild) section.firstChild.remove();
    section.appendChild(buildPlaceholder());

    // Guard: keep the section clean if X tries to inject content back
    sectionGuard = new MutationObserver(() => {
      let hasPlaceholder = false;
      for (const child of [...section.children]) {
        if (child.id === PLACEHOLDER_ID) { hasPlaceholder = true; }
        else { child.remove(); }
      }
      if (!hasPlaceholder) section.appendChild(buildPlaceholder());
    });
    sectionGuard.observe(section, { childList: true });
  }

  function releaseSection() {
    sectionGuard?.disconnect();
    sectionGuard = null;
    managedSection = null;
  }

  function findAndClaimSection() {
    if (!site.spacerTarget) return;
    const sections = document.querySelectorAll(site.spacerTarget);
    if (sections.length) claimSection(sections[sections.length - 1]);
  }

  // ─── Unified apply ────────────────────────────────────────────────────────────

  function apply(enabled) {
    isEnabled = enabled;

    if (enabled && shouldApply()) {
      if (strategy === 'spacer') {
        document.documentElement.setAttribute(FETCH_ATTR, '');
        injectCSS();            // hide sidebar
        findAndClaimSection();  // replace feed with placeholder
      } else if (strategy === 'remove') {
        startRemoval();
      } else {
        injectCSS();
      }
    } else {
      if (strategy === 'spacer') {
        document.documentElement.removeAttribute(FETCH_ATTR);
        removeCSS();
        const wasManaging = managedSection !== null;
        releaseSection();
        if (wasManaging) location.reload();
      } else if (strategy === 'remove') {
        const needsReload = activelyRemoving;
        stopRemoval();
        if (needsReload) location.reload();
      } else {
        removeCSS();
      }
    }
  }

  // ─── Initialisation ───────────────────────────────────────────────────────────

  // For spacer strategy: inject the fetch blocker synchronously (before X's own
  // scripts load) and set the attribute optimistically. The storage check below
  // will quickly remove the attribute if the site is actually disabled.
  if (strategy === 'spacer') {
    document.documentElement.setAttribute(FETCH_ATTR, '');
    injectFetchBlocker();
  }

  chrome.storage.sync.get({ disabledSites: [] }, ({ disabledSites }) => {
    const enabled = !disabledSites.includes(site.id);
    if (!enabled && strategy === 'spacer') {
      document.documentElement.removeAttribute(FETCH_ATTR);
    }
    apply(enabled);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'feedless:toggle' && msg.siteId === site.id) {
      apply(msg.enabled);
    }
  });

  // ─── SPA navigation + spacer section watcher (one combined observer) ──────────

  let lastPath = location.pathname;

  const navObserver = new MutationObserver((mutations) => {
    // 1. Path change
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;

      if (strategy === 'remove') stopRemoval();
      if (strategy === 'spacer') {
        releaseSection();
        if (!shouldApply()) {
          document.documentElement.removeAttribute(FETCH_ATTR);
          removeCSS();
        }
      }

      chrome.storage.sync.get({ disabledSites: [] }, ({ disabledSites }) => {
        apply(!disabledSites.includes(site.id));
      });
      return;
    }

    // 2. For spacer: watch for the target section to appear after X renders it
    if (strategy === 'spacer' && isEnabled && shouldApply() && managedSection === null) {
      for (const { addedNodes } of mutations) {
        for (const node of addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.(site.spacerTarget)) { claimSection(node); return; }
          const found = node.querySelector?.(site.spacerTarget);
          if (found) { claimSection(found); return; }
        }
      }
    }
  });

  navObserver.observe(document.documentElement, { subtree: true, childList: true });
})();
