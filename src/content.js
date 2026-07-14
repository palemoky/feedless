(function () {
  "use strict";

  const hostname = location.hostname.replace(/^www\./, "");
  const site = findSiteByHostname(hostname);
  if (!site) return;

  const STYLE_ID = "feedless-styles";
  const FETCH_ATTR = "data-feedless-active";
  // Patterns the MAIN-world fetch blocker (x-fetch-blocker.js) should match
  // against outgoing request URLs. Published here so the per-site config in
  // sites.js is the single source of truth instead of being hardcoded twice.
  const FETCH_BLOCK_ATTR = "data-feedless-block";
  const PLACEHOLDER_ID = "feedless-placeholder";
  const strategy = site.strategy || "css";

  // When the extension is reloaded/updated/disabled, this content script keeps
  // running in already-open tabs but its link to the extension is severed, so
  // any chrome.* call throws "Extension context invalidated." Guard with this.
  const isContextValid = () => Boolean(chrome.runtime?.id);

  // State for 'remove' strategy
  let removalObserver = null;
  let activelyRemoving = false;

  // State for 'spacer' strategy
  let managedSection = null;
  let sectionGuard = null; // observer that keeps the section clean

  // Cached enabled state (set after first storage check; avoids repeated async lookups)
  let isEnabled = null;

  // ─── Reminder countdown ───────────────────────────────────────────────────────
  // A floating timer in the top-right corner showing the time left until the
  // next reminder. Purely visual; the reminder itself fires from the background
  // alarm. Started by the background's "feedless:countdownStart" message.
  let countdownTickId = null;
  let countdownEl = null;
  // Absolute timestamp (ms) the reminder will fire. The display is derived from
  // this single source of truth — broadcast by the background — rather than a
  // local snapshot, so multiple tabs of the same site all show the same number
  // and switching tabs no longer makes the count "jump".
  let countdownFireAt = null;

  function showCountdown(fireAt) {
    if (!document.body) return;
    countdownFireAt = fireAt;

    if (!countdownEl) {
      countdownEl = document.createElement("div");
      countdownEl.id = "feedless-countdown";
      countdownEl.style.cssText = [
        "position:fixed",
        "top:14px",
        "right:14px",
        "z-index:2147483646",
        "background:rgba(15,15,15,0.82)",
        "color:#fff",
        "padding:7px 12px 7px 10px",
        "border-radius:10px",
        'font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",monospace',
        "border:1.5px solid rgba(220,38,38,0.65)",
        "box-shadow:0 2px 10px rgba(0,0,0,0.4)",
        "pointer-events:none",
        "letter-spacing:0.3px",
      ].join(";");
      document.body.appendChild(countdownEl);
    }

    clearTimeout(countdownTickId);
    const tick = () => {
      if (!countdownEl || countdownFireAt == null) return;
      const remaining = Math.max(
        0,
        Math.round((countdownFireAt - Date.now()) / 1000),
      );
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      countdownEl.textContent =
        mins > 0
          ? `⏰ ${mins}m ${String(secs).padStart(2, "0")}s`
          : `⏰ ${secs}s`;
      if (remaining <= 0) {
        clearTimeout(countdownTickId);
        return;
      }
      // Tick faster than 1s so the wall-clock-derived display stays accurate
      // even if a timer is throttled in a background tab.
      countdownTickId = setTimeout(tick, 250);
    };
    tick();
  }

  function clearCountdown() {
    clearTimeout(countdownTickId);
    countdownTickId = null;
    countdownFireAt = null;
    countdownEl?.remove();
    countdownEl = null;
  }

  // ─── helpers ─────────────────────────────────────────────────────────────────

  // A path rule matches the current pathname exactly, or as a prefix when it
  // ends with "/*" — e.g. "/hot/*" covers /hot/weibo, /hot/realtimehot, …
  // (needed because feed pages often carry dynamic trailing segments).
  function pathMatches(rule) {
    if (rule.endsWith("/*")) {
      const base = rule.slice(0, -2);
      return (
        location.pathname === base || location.pathname.startsWith(base + "/")
      );
    }
    return location.pathname === rule;
  }

  function shouldApply() {
    if (!site.paths) return true;
    return site.paths.some(pathMatches);
  }

  // Selector entries are either plain strings (apply on every page of the
  // site) or { css, paths } objects that only apply on the listed URL paths —
  // e.g. Weibo's home-feed scroller class also appears on profile pages,
  // which must keep their own posts visible.
  function activeSelectors() {
    return (site.selectors ?? [])
      .filter(
        (s) => typeof s === "string" || !s.paths || s.paths.some(pathMatches),
      )
      .map((s) => (typeof s === "string" ? s : s.css));
  }

  // ─── CSS strategy ────────────────────────────────────────────────────────────

  function injectCSS() {
    const selectorCSS = activeSelectors()
      .map((s) =>
        site.collapseChildren
          ? `${s}>*{display:none!important}`
          : `${s}{display:none!important}`,
      )
      .join("");
    const cssText = selectorCSS + (site.extraCSS ?? "");
    if (!cssText) {
      removeCSS();
      return;
    }
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.documentElement.appendChild(style);
    }
    // Path-scoped selectors mean the rules can change across SPA navigations
    // (apply() re-runs on every path change); rewrite only on actual change.
    if (style.textContent !== cssText) style.textContent = cssText;
  }

  function removeCSS() {
    document.getElementById(STYLE_ID)?.remove();
  }

  // ─── Remove strategy ─────────────────────────────────────────────────────────

  function removeMatchingIn(root) {
    for (const sel of activeSelectors()) {
      try {
        root.querySelectorAll(sel).forEach((el) => el.remove());
      } catch {}
    }
  }

  function startRemoval() {
    if (activelyRemoving) return;
    activelyRemoving = true;
    removeMatchingIn(document);
    removalObserver = new MutationObserver((mutations) => {
      const sels = activeSelectors();
      for (const { addedNodes } of mutations) {
        for (const node of addedNodes) {
          if (node.nodeType !== 1) continue;
          for (const sel of sels) {
            try {
              if (node.matches(sel)) {
                node.remove();
                break;
              }
              node.querySelectorAll(sel).forEach((el) => el.remove());
            } catch {}
          }
        }
      }
    });
    removalObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
    });
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
    const ph = document.createElement("div");
    ph.id = PLACEHOLDER_ID;
    // min-height:100vh ensures the sentinel (placed after our placeholder by X)
    // is always below the viewport, so IntersectionObserver never fires.
    ph.style.cssText =
      "min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding-top:80px;box-sizing:border-box";
    const msg = document.createElement("div");
    msg.style.cssText =
      'color:#536471;font-size:15px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
    msg.textContent = "推荐已屏蔽";
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
        if (child.id === PLACEHOLDER_ID) {
          hasPlaceholder = true;
        } else {
          child.remove();
        }
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
      if (strategy === "spacer") {
        document.documentElement.setAttribute(FETCH_ATTR, "");
        injectCSS(); // hide sidebar
        findAndClaimSection(); // replace feed with placeholder
      } else if (strategy === "remove") {
        startRemoval();
      } else {
        injectCSS();
      }
    } else {
      if (strategy === "spacer") {
        document.documentElement.removeAttribute(FETCH_ATTR);
        removeCSS();
        const wasManaging = managedSection !== null;
        releaseSection();
        if (wasManaging) location.reload();
      } else if (strategy === "remove") {
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
  if (strategy === "spacer") {
    // Patterns are fixed per page, so publish them once; only the active flag
    // toggles. The blocker no-ops when no patterns are present.
    document.documentElement.setAttribute(
      FETCH_BLOCK_ATTR,
      (site.fetchBlockPatterns ?? []).join(","),
    );
    document.documentElement.setAttribute(FETCH_ATTR, "");
  }

  chrome.storage.sync.get({ disabledSites: [] }, ({ disabledSites }) => {
    const enabled = !disabledSites.includes(site.id);
    if (!enabled && strategy === "spacer") {
      document.documentElement.removeAttribute(FETCH_ATTR);
    }
    apply(enabled);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "feedless:toggle" && msg.siteId === site.id) {
      apply(msg.enabled);
    }
    if (msg.type === "feedless:remind") {
      clearCountdown();
      window.__feedlessShowReminder?.();
    }
    if (msg.type === "feedless:countdownStart") {
      showCountdown(msg.fireAt);
    }
    if (msg.type === "feedless:countdownStop") {
      clearCountdown();
    }
  });

  // ─── SPA navigation + spacer section watcher (one combined observer) ──────────

  let lastPath = location.pathname;

  const navObserver = new MutationObserver((mutations) => {
    // Extension was reloaded; stop observing so we don't touch dead chrome.* APIs.
    if (!isContextValid()) {
      navObserver.disconnect();
      return;
    }

    // 1. Path change
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;

      if (strategy === "remove") stopRemoval();
      if (strategy === "spacer") {
        releaseSection();
        if (!shouldApply()) {
          document.documentElement.removeAttribute(FETCH_ATTR);
          removeCSS();
        }
      }

      // Re-apply synchronously from the cached enabled state so path-scoped
      // CSS switches without a flash of unblocked content, then re-check
      // storage in case the site was toggled since the cache was set.
      if (isEnabled !== null) apply(isEnabled);
      chrome.storage.sync.get({ disabledSites: [] }, ({ disabledSites }) => {
        apply(!disabledSites.includes(site.id));
      });
      return;
    }

    // 2. For spacer: watch for the target section to appear after X renders it
    if (strategy === "spacer" && isEnabled && shouldApply()) {
      // X tab-switch destroys the section element without a path change; detect
      // the detachment so we can claim the newly inserted section.
      if (managedSection !== null && !document.contains(managedSection)) {
        releaseSection();
      }

      if (managedSection === null) {
        for (const { addedNodes } of mutations) {
          for (const node of addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.matches?.(site.spacerTarget)) {
              claimSection(node);
              return;
            }
            const found = node.querySelector?.(site.spacerTarget);
            if (found) {
              claimSection(found);
              return;
            }
          }
        }
      }
    }
  });

  navObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
  });
})();
