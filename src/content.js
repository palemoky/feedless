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

  function showCountdown(seconds) {
    clearCountdown();

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

    let remaining = seconds;
    const tick = () => {
      if (!countdownEl) return;
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      countdownEl.textContent =
        mins > 0
          ? `⏰ ${mins}m ${String(secs).padStart(2, "0")}s`
          : `⏰ ${secs}s`;
      if (remaining <= 0) {
        clearCountdown();
        return;
      }
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
    if (
      (!site.selectors?.length && !site.extraCSS) ||
      document.getElementById(STYLE_ID)
    )
      return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    const selectorCSS = (site.selectors ?? [])
      .map((s) =>
        site.collapseChildren
          ? `${s}>*{display:none!important}`
          : `${s}{display:none!important}`,
      )
      .join("");
    style.textContent = selectorCSS + (site.extraCSS ?? "");
    document.documentElement.appendChild(style);
  }

  function removeCSS() {
    document.getElementById(STYLE_ID)?.remove();
  }

  // ─── Remove strategy ─────────────────────────────────────────────────────────

  function removeMatchingIn(root) {
    for (const sel of site.selectors) {
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
      for (const { addedNodes } of mutations) {
        for (const node of addedNodes) {
          if (node.nodeType !== 1) continue;
          for (const sel of site.selectors) {
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

  // Reminder visual styles. The chosen one is read from sync storage at trigger
  // time so changing it in the popup takes effect on the next reminder.
  const REMINDER_DEFAULT = "glitch";
  const RED = "220,38,38";

  function showReminder() {
    if (!isContextValid()) {
      renderReminder(REMINDER_DEFAULT);
      return;
    }
    chrome.storage.sync.get(
      { reminderStyle: REMINDER_DEFAULT },
      ({ reminderStyle }) => renderReminder(reminderStyle),
    );
  }

  function renderReminder(styleId) {
    if (document.getElementById("feedless-remind-overlay")) return;
    const render =
      { breathe: renderBreathe, hud: renderHud, glitch: renderGlitch }[
        styleId
      ] || renderGlitch;
    render();
  }

  // Mounts a full-screen, click-through overlay carrying its own scoped <style>,
  // then self-removes after `durationMs`. Returning the overlay lets callers wire
  // up early dismissal if needed.
  function mountReminderOverlay(durationMs, innerHTML, extraCss = "") {
    const overlay = document.createElement("div");
    overlay.id = "feedless-remind-overlay";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "pointer-events:none",
      "z-index:2147483647",
      "overflow:hidden",
      extraCss,
    ]
      .filter(Boolean)
      .join(";");
    overlay.innerHTML = innerHTML;
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), durationMs);
    return overlay;
  }

  // ── breathe: the original two-breath red vignette ──────────────────────────
  function renderBreathe() {
    mountReminderOverlay(
      6000,
      `<style>
        @keyframes feedless-breathe {
          0%   { box-shadow: inset 0 0  10px  2px rgba(${RED},0.05); }
          20%  { box-shadow: inset 0 0 140px 55px rgba(${RED},0.88); }
          40%  { box-shadow: inset 0 0  30px  8px rgba(${RED},0.18); }
          60%  { box-shadow: inset 0 0 140px 55px rgba(${RED},0.88); }
          85%  { box-shadow: inset 0 0  30px  8px rgba(${RED},0.18); }
          100% { box-shadow: inset 0 0  10px  2px rgba(${RED},0);    }
        }
      </style>`,
      "animation:feedless-breathe 6s ease-in-out forwards",
    );
  }

  // ── hud: cinematic targeting frame with converging corner brackets ─────────
  function renderHud() {
    mountReminderOverlay(
      2600,
      `<style>
        @keyframes fl-hud-frame {
          0%   { opacity:0; transform:scale(1.04); }
          12%  { opacity:1; transform:scale(1); }
          14%  { box-shadow: inset 0 0 0 2px rgba(${RED},1), inset 0 0 120px 10px rgba(${RED},0.35); }
          20%  { box-shadow: inset 0 0 0 2px rgba(${RED},0.4), inset 0 0 30px 4px rgba(${RED},0.08); }
          85%  { opacity:1; }
          100% { opacity:0; }
        }
        @keyframes fl-hud-corner {
          0%  { opacity:0; }
          8%  { opacity:0; transform: translate(var(--tx), var(--ty)); }
          20% { opacity:1; transform: translate(0,0); }
          85% { opacity:1; }
          100%{ opacity:0; }
        }
        @keyframes fl-hud-scan {
          0%  { top:-2%; opacity:0; }
          15% { opacity:0.9; }
          85% { opacity:0.9; }
          100%{ top:102%; opacity:0; }
        }
        @keyframes fl-hud-text {
          0%,10% { opacity:0; }
          18% { opacity:1; }
          50% { opacity:0.4; }
          65% { opacity:1; }
          85% { opacity:1; }
          100%{ opacity:0; }
        }
        #feedless-remind-overlay .fl-frame {
          position:absolute; inset:0; border:2px solid rgba(${RED},0.85);
          box-shadow: inset 0 0 120px 10px rgba(${RED},0.30);
          animation: fl-hud-frame 2.6s ease-out forwards;
        }
        #feedless-remind-overlay .fl-c {
          position:absolute; width:46px; height:46px; border:3px solid rgba(${RED},1);
          animation: fl-hud-corner 2.6s cubic-bezier(.2,.9,.2,1) forwards;
        }
        #feedless-remind-overlay .fl-tl { top:18px; left:18px;  border-right:0; border-bottom:0; --tx:-30px; --ty:-30px; }
        #feedless-remind-overlay .fl-tr { top:18px; right:18px; border-left:0;  border-bottom:0; --tx:30px;  --ty:-30px; }
        #feedless-remind-overlay .fl-bl { bottom:18px; left:18px;  border-right:0; border-top:0; --tx:-30px; --ty:30px; }
        #feedless-remind-overlay .fl-br { bottom:18px; right:18px; border-left:0;  border-top:0; --tx:30px;  --ty:30px; }
        #feedless-remind-overlay .fl-scan {
          position:absolute; left:0; right:0; height:2px;
          background: linear-gradient(90deg, transparent, rgba(${RED},0.9) 50%, transparent);
          box-shadow: 0 0 14px 3px rgba(${RED},0.6);
          animation: fl-hud-scan 2.6s ease-in-out forwards;
        }
        #feedless-remind-overlay .fl-label {
          position:absolute; top:30px; left:50%; transform:translateX(-50%);
          font:600 12px/1 monospace; letter-spacing:2px;
          color:rgba(${RED},1); text-shadow:0 0 8px rgba(${RED},0.8);
          animation: fl-hud-text 2.6s steps(1) forwards;
        }
        #feedless-remind-overlay .fl-tag {
          position:absolute; bottom:30px; right:34px;
          font:600 11px/1 monospace; letter-spacing:3px;
          color:rgba(${RED},0.9); animation: fl-hud-text 2.6s steps(1) forwards;
        }
      </style>
      <div class="fl-frame"></div>
      <div class="fl-c fl-tl"></div><div class="fl-c fl-tr"></div>
      <div class="fl-c fl-bl"></div><div class="fl-c fl-br"></div>
      <div class="fl-scan"></div>
      <div class="fl-label">◢ FOCUS LOCK ◣</div>
      <div class="fl-tag">FEEDLESS // ALERT</div>`,
    );
  }

  // ── glitch: cyberpunk signal-interference burst ────────────────────────────
  function renderGlitch() {
    mountReminderOverlay(
      2400,
      `<style>
        @keyframes fl-gl-flash {
          0%  { opacity:0; }
          6%  { opacity:1; box-shadow: inset 0 0 200px 40px rgba(${RED},0.9); }
          14% { opacity:0.3; }
          22% { opacity:1; box-shadow: inset 0 0 120px 20px rgba(${RED},0.6); }
          40% { opacity:0.5; }
          100%{ opacity:0; }
        }
        @keyframes fl-gl-scan { 0% { background-position:0 0; } 100% { background-position:0 100%; } }
        @keyframes fl-gl-shift-r {
          0%,100%{ transform:translate(0,0); } 10%{ transform:translate(-6px,3px); }
          30%{ transform:translate(4px,-2px); } 50%{ transform:translate(-8px,0); } 70%{ transform:translate(3px,2px); }
        }
        @keyframes fl-gl-shift-b {
          0%,100%{ transform:translate(0,0); } 10%{ transform:translate(6px,-3px); }
          30%{ transform:translate(-4px,2px); } 50%{ transform:translate(8px,0); } 70%{ transform:translate(-3px,-2px); }
        }
        @keyframes fl-gl-tear {
          0%,100%{ clip-path: inset(0 0 100% 0); opacity:0; }
          12%{ clip-path: inset(20% 0 42% 0); opacity:1; transform:translateX(-18px); }
          24%{ clip-path: inset(0 0 100% 0); opacity:0; }
          38%{ clip-path: inset(58% 0 12% 0); opacity:1; transform:translateX(22px); }
          46%{ clip-path: inset(0 0 100% 0); opacity:0; }
          60%{ clip-path: inset(35% 0 55% 0); opacity:1; transform:translateX(-12px); }
          66%{ clip-path: inset(0 0 100% 0); opacity:0; }
        }
        #feedless-remind-overlay .fl-flash {
          position:absolute; inset:0; background: rgba(${RED},0.12);
          animation: fl-gl-flash 2.4s ease-out forwards;
        }
        #feedless-remind-overlay .fl-scanlines {
          position:absolute; inset:0; mix-blend-mode:multiply;
          background: repeating-linear-gradient(0deg, rgba(0,0,0,0.28) 0 1px, transparent 1px 3px);
          animation: fl-gl-scan .4s linear infinite, fl-gl-flash 2.4s ease-out forwards;
        }
        #feedless-remind-overlay .fl-stage {
          position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
        }
        #feedless-remind-overlay .fl-txt {
          position:absolute; color:#fff; font:800 clamp(28px,6vw,72px)/1 monospace; letter-spacing:4px;
          text-shadow:0 0 12px rgba(${RED},0.9); animation: fl-gl-flash 2.4s ease-out forwards;
        }
        #feedless-remind-overlay .fl-txt.fl-r { color:rgba(255,0,60,0.9); mix-blend-mode:screen; animation: fl-gl-shift-r 2.4s steps(2) infinite, fl-gl-flash 2.4s ease-out forwards; }
        #feedless-remind-overlay .fl-txt.fl-b { color:rgba(0,200,255,0.8); mix-blend-mode:screen; animation: fl-gl-shift-b 2.4s steps(2) infinite, fl-gl-flash 2.4s ease-out forwards; }
        #feedless-remind-overlay .fl-tear {
          position:absolute; left:0; right:0; height:34%; top:33%; mix-blend-mode:screen;
          background: linear-gradient(90deg, transparent, rgba(${RED},0.85), transparent);
          animation: fl-gl-tear 2.4s steps(1) forwards;
        }
      </style>
      <div class="fl-flash"></div>
      <div class="fl-tear"></div>
      <div class="fl-stage">
        <div class="fl-txt fl-b">STOP · GET BACK</div>
        <div class="fl-txt fl-r">STOP · GET BACK</div>
        <div class="fl-txt">STOP · GET BACK</div>
      </div>
      <div class="fl-scanlines"></div>`,
    );
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "feedless:toggle" && msg.siteId === site.id) {
      apply(msg.enabled);
    }
    if (msg.type === "feedless:remind") {
      clearCountdown();
      showReminder();
    }
    if (msg.type === "feedless:countdownStart") {
      showCountdown(msg.seconds);
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
