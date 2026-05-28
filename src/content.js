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

  // ─── Dev countdown ────────────────────────────────────────────────────────────
  let countdownTickId = null;
  let countdownEl = null;

  function showCountdown(seconds) {
    clearCountdown();

    countdownEl = document.createElement('div');
    countdownEl.id = 'feedless-countdown';
    countdownEl.style.cssText = [
      'position:fixed', 'top:14px', 'right:14px', 'z-index:2147483646',
      'background:rgba(15,15,15,0.82)', 'color:#fff',
      'padding:7px 12px 7px 10px', 'border-radius:10px',
      'font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",monospace',
      'border:1.5px solid rgba(220,38,38,0.65)',
      'box-shadow:0 2px 10px rgba(0,0,0,0.4)',
      'pointer-events:none', 'letter-spacing:0.3px',
    ].join(';');
    document.body.appendChild(countdownEl);

    let remaining = seconds;
    const tick = () => {
      if (!countdownEl) return;
      countdownEl.textContent = `⏰ ${remaining}s`;
      if (remaining <= 0) { clearCountdown(); return; }
      remaining--;
      countdownTickId = setTimeout(tick, 1000);
    };
    tick();
  }

  function clearCountdown() {
    clearTimeout(countdownTickId);
    countdownTickId = null;
    countdownEl?.remove();
    countdownEl = null;
  }

  // ─── helpers ─────────────────────────────────────────────────────────────────

  function shouldApply() {
    if (!site.paths) return true;
    return site.paths.includes(location.pathname);
  }

  // ─── CSS strategy ────────────────────────────────────────────────────────────

  function injectCSS() {
    if ((!site.selectors?.length && !site.extraCSS) || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = (site.selectors ?? []).map(s => `${s}{display:none!important}`).join('') + (site.extraCSS ?? '');
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

  // For spacer strategy: set the attribute optimistically so that x-fetch-blocker.js
  // (which runs in the MAIN world via manifest.json) starts blocking immediately.
  // The storage check below will quickly remove the attribute if the site is disabled.
  if (strategy === 'spacer') {
    document.documentElement.setAttribute(FETCH_ATTR, '');
  }

  chrome.storage.sync.get({ disabledSites: [] }, ({ disabledSites }) => {
    const enabled = !disabledSites.includes(site.id);
    if (!enabled && strategy === 'spacer') {
      document.documentElement.removeAttribute(FETCH_ATTR);
    }
    apply(enabled);
  });

  function showReminder() {
    if (document.getElementById('feedless-remind-overlay')) return;

    const style = document.createElement('style');
    style.id = 'feedless-remind-style';
    // Two slow breaths over 6 s: gentle rise → full peak → slow exhale, repeat once, fade out.
    style.textContent = `
      @keyframes feedless-breathe {
        0%   { box-shadow: inset 0 0  10px  2px rgba(220,38,38,0.05); }
        20%  { box-shadow: inset 0 0 140px 55px rgba(220,38,38,0.88); }
        40%  { box-shadow: inset 0 0  30px  8px rgba(220,38,38,0.18); }
        60%  { box-shadow: inset 0 0 140px 55px rgba(220,38,38,0.88); }
        85%  { box-shadow: inset 0 0  30px  8px rgba(220,38,38,0.18); }
        100% { box-shadow: inset 0 0  10px  2px rgba(220,38,38,0);    }
      }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'feedless-remind-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none',
      'z-index:2147483647',
      'animation:feedless-breathe 6s ease-in-out forwards',
    ].join(';');

    document.body.appendChild(overlay);

    overlay.addEventListener('animationend', () => {
      overlay.remove();
      style.remove();
    }, { once: true });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'feedless:toggle' && msg.siteId === site.id) {
      apply(msg.enabled);
    }
    if (msg.type === 'feedless:remind') {
      clearCountdown();
      showReminder();
    }
    if (msg.type === 'feedless:countdownStart') {
      showCountdown(msg.seconds);
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
