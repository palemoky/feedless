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
      {
        breathe: renderBreathe,
        hud: renderHud,
        glitch: renderGlitch,
        stamp: renderStamp,
        pulse: renderPulse,
        dim: renderDim,
        fog: renderFog,
        closed: renderClosed,
      }[styleId] || renderGlitch;
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
    // Video sites are most often reminded of while the player is in Fullscreen
    // API mode, but the fullscreen element is the only thing the browser paints
    // in that mode — anything appended to document.body (a sibling, not an
    // ancestor, of the fullscreen element) is composited but never shown. Mount
    // inside the fullscreen element when one is active so the overlay is
    // actually visible instead of silently firing with nothing on screen.
    const mountPoint = document.fullscreenElement || document.body;
    mountPoint.appendChild(overlay);
    // If fullscreen is entered/exited while the overlay is up, re-parent so it
    // keeps rendering wherever the browser is currently painting.
    const onFullscreenChange = () => {
      const target = document.fullscreenElement || document.body;
      if (overlay.isConnected && overlay.parentElement !== target) {
        target.appendChild(overlay);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    setTimeout(() => {
      overlay.remove();
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    }, durationMs);
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

  // ── stamp: a rubber stamp slams down with a screen jolt ────────────────────
  function renderStamp() {
    mountReminderOverlay(
      2600,
      `<style>
        @keyframes fl-sp-drop {
          0%   { opacity:0; transform:rotate(-11deg) scale(3.2); }
          14%  { opacity:1; transform:rotate(-11deg) scale(1); }
          20%  { transform:rotate(-9deg) scale(1.07); }
          26%  { transform:rotate(-10deg) scale(1); }
          82%  { opacity:1; }
          100% { opacity:0; }
        }
        @keyframes fl-sp-jolt {
          0%,13% { transform:translate(0,0); }
          15% { transform:translate(0,7px); }
          19% { transform:translate(0,-4px); }
          23% { transform:translate(0,2px); }
          27%,100% { transform:translate(0,0); }
        }
        @keyframes fl-sp-burst {
          0%,13% { opacity:0; }
          16% { opacity:1; }
          50% { opacity:0; }
          100%{ opacity:0; }
        }
        #feedless-remind-overlay .fl-jolt {
          position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
          animation: fl-sp-jolt 2.6s linear forwards;
        }
        #feedless-remind-overlay .fl-burst {
          position:absolute; inset:0;
          box-shadow: inset 0 0 160px 30px rgba(${RED},0.55);
          opacity:0; animation: fl-sp-burst 2.6s ease-out forwards;
        }
        #feedless-remind-overlay .fl-stamp {
          padding:18px 36px; border:5px double rgba(${RED},0.95); border-radius:10px;
          color:rgba(${RED},0.95); font:800 clamp(30px,6vw,76px)/1.15 monospace;
          letter-spacing:6px; text-align:center; text-transform:uppercase;
          text-shadow:0 0 14px rgba(${RED},0.5);
          box-shadow:0 0 22px rgba(${RED},0.35), inset 0 0 18px rgba(${RED},0.25);
          background:rgba(15,15,15,0.25);
          animation: fl-sp-drop 2.6s cubic-bezier(.16,1.2,.3,1) forwards;
        }
        #feedless-remind-overlay .fl-stamp small {
          display:block; font-size:0.32em; letter-spacing:9px; text-indent:9px; margin-top:8px; opacity:0.85;
        }
      </style>
      <div class="fl-burst"></div>
      <div class="fl-jolt"><div class="fl-stamp">STOP<small>GET BACK</small></div></div>`,
    );
  }

  // ── pulse: two heartbeats — paired rings radiating from the center ─────────
  function renderPulse() {
    const ring = (delay) =>
      `<div class="fl-ring" style="animation-delay:${delay}s"></div>`;
    mountReminderOverlay(
      3000,
      `<style>
        @keyframes fl-pl-ring {
          0%   { transform:translate(-50%,-50%) scale(0.04); opacity:0.95; }
          70%  { opacity:0.3; }
          100% { transform:translate(-50%,-50%) scale(1); opacity:0; }
        }
        @keyframes fl-pl-beat {
          0%,8% { box-shadow: inset 0 0 0 0 rgba(${RED},0); }
          12% { box-shadow: inset 0 0 120px 24px rgba(${RED},0.5); }
          28% { box-shadow: inset 0 0 40px 6px rgba(${RED},0.12); }
          40% { box-shadow: inset 0 0 130px 28px rgba(${RED},0.55); }
          70% { box-shadow: inset 0 0 30px 4px rgba(${RED},0.08); }
          100%{ box-shadow: inset 0 0 0 0 rgba(${RED},0); }
        }
        @keyframes fl-pl-text {
          0%,10% { opacity:0; } 22% { opacity:1; } 80% { opacity:1; } 100% { opacity:0; }
        }
        #feedless-remind-overlay .fl-beat {
          position:absolute; inset:0; animation: fl-pl-beat 3s ease-out forwards;
        }
        #feedless-remind-overlay .fl-ring {
          position:absolute; top:50%; left:50%; width:130vmax; height:130vmax; border-radius:50%;
          border:3px solid rgba(${RED},0.8); box-shadow:0 0 24px rgba(${RED},0.45);
          transform:translate(-50%,-50%) scale(0.04); opacity:0;
          animation: fl-pl-ring 1.4s cubic-bezier(.2,.6,.4,1) forwards;
        }
        #feedless-remind-overlay .fl-word {
          position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
          color:#fff; font:700 clamp(20px,3.4vw,40px)/1 monospace; letter-spacing:6px;
          text-shadow:0 0 12px rgba(${RED},0.9); animation: fl-pl-text 3s ease forwards;
        }
      </style>
      <div class="fl-beat"></div>
      ${ring(0)}${ring(0.18)}${ring(0.84)}${ring(1.02)}
      <span class="fl-word">STOP · GET BACK</span>`,
    );
  }

  // ── dim: the page quietly fades to dark with a minimal prompt ──────────────
  function renderDim() {
    mountReminderOverlay(
      3600,
      `<style>
        @keyframes fl-dm-veil {
          0% { opacity:0; } 22% { opacity:1; } 78% { opacity:1; } 100% { opacity:0; }
        }
        @keyframes fl-dm-line {
          0%,24% { transform:scaleX(0); } 46% { transform:scaleX(1); } 100% { transform:scaleX(1); }
        }
        #feedless-remind-overlay .fl-veil {
          position:absolute; inset:0; background:rgba(6,6,8,0.86);
          display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;
          animation: fl-dm-veil 3.6s ease-in-out forwards;
        }
        #feedless-remind-overlay .fl-quiet {
          color:rgba(255,255,255,0.92);
          font:300 clamp(18px,2.6vw,30px)/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          letter-spacing:10px; text-indent:10px;
        }
        #feedless-remind-overlay .fl-rule {
          width:min(46vw,360px); height:1px; background:rgba(${RED},0.85);
          box-shadow:0 0 8px rgba(${RED},0.6); transform:scaleX(0);
          animation: fl-dm-line 3.6s ease forwards;
        }
      </style>
      <div class="fl-veil">
        <span class="fl-quiet">STOP · GET BACK</span>
        <div class="fl-rule"></div>
      </div>`,
    );
  }

  // ── fog: the glass mists over and the message is "wiped" into it ───────────
  function renderFog() {
    const letters = [..."STOP · GET BACK"]
      .map(
        (ch, i) =>
          `<span style="animation-delay:${(1.1 + i * 0.09).toFixed(2)}s">${ch === " " ? "&nbsp;" : ch}</span>`,
      )
      .join("");
    mountReminderOverlay(
      5200,
      `<style>
        @keyframes fl-fg-rise {
          0% { opacity:0; } 26% { opacity:1; } 78% { opacity:1; } 100% { opacity:0; }
        }
        @keyframes fl-fg-drift {
          0% { transform:translate(-4%,2%) scale(1.04); }
          100% { transform:translate(4%,-2%) scale(1.12); }
        }
        @keyframes fl-fg-write { to { opacity:1; } }
        #feedless-remind-overlay .fl-mist {
          position:absolute; inset:0;
          backdrop-filter: blur(7px) saturate(0.8);
          background: rgba(232,238,244,0.36);
          animation: fl-fg-rise 5.2s ease-in-out forwards;
        }
        #feedless-remind-overlay .fl-cloud {
          position:absolute; inset:-12%;
          background:
            radial-gradient(45% 35% at 28% 30%, rgba(255,255,255,0.55), transparent 70%),
            radial-gradient(50% 40% at 74% 66%, rgba(255,255,255,0.5), transparent 70%);
          filter: blur(14px);
          animation: fl-fg-drift 5.2s ease-in-out forwards;
        }
        #feedless-remind-overlay .fl-write {
          position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
          white-space:nowrap; color:rgba(40,50,60,0.8);
          font:600 clamp(24px,4.4vw,52px)/1 monospace; letter-spacing:6px;
          text-shadow:0 1px 1px rgba(255,255,255,0.55);
        }
        #feedless-remind-overlay .fl-write span {
          opacity:0; animation: fl-fg-write 0.45s ease forwards;
        }
      </style>
      <div class="fl-mist">
        <div class="fl-cloud"></div>
        <div class="fl-write">${letters}</div>
      </div>`,
    );
  }

  // ── closed: a shop "CLOSED" sign drops in and swings itself still ──────────
  function renderClosed() {
    mountReminderOverlay(
      4200,
      `<style>
        @keyframes fl-cd-dim {
          0% { opacity:0; } 18% { opacity:1; } 80% { opacity:1; } 100% { opacity:0; }
        }
        /* Settled offset: -50% recenters the hang block on its own height and
           the extra 32px shifts the visual centre from the block's midpoint to
           the sign's midpoint (the 64px cord section sits above the sign). */
        @keyframes fl-cd-drop {
          0% { transform:translate(-50%,-160vh); }
          14% { transform:translate(-50%,calc(-50% - 32px)); }
          100% { transform:translate(-50%,calc(-50% - 32px)); }
        }
        /* Damped pendulum: each half-swing loses amplitude until the sign rests. */
        @keyframes fl-cd-swing {
          0%,12% { transform:rotate(0deg); }
          24% { transform:rotate(13deg); }
          37% { transform:rotate(-9.5deg); }
          49% { transform:rotate(6.5deg); }
          60% { transform:rotate(-4deg); }
          70% { transform:rotate(2.4deg); }
          79% { transform:rotate(-1.2deg); }
          87% { transform:rotate(0.5deg); }
          94%,100% { transform:rotate(0deg); }
        }
        #feedless-remind-overlay .fl-shade {
          position:absolute; inset:0; background:rgba(8,8,12,0.6);
          animation: fl-cd-dim 4.2s ease forwards;
        }
        #feedless-remind-overlay .fl-hang {
          position:absolute; top:50%; left:50%;
          animation: fl-cd-drop 4.2s cubic-bezier(.34,1.3,.45,1) forwards;
        }
        #feedless-remind-overlay .fl-nail {
          position:absolute; top:-5px; left:50%; transform:translateX(-50%);
          width:9px; height:9px; border-radius:50%;
          background:#e8e8e8; box-shadow:0 1px 3px rgba(0,0,0,0.6);
        }
        /* padding-top (not a margin on the sign) keeps the sign's offset from
           collapsing through this wrapper, so the cords stay anchored between
           the nail and the sign's top edge and the swing pivots at the nail. */
        #feedless-remind-overlay .fl-pendulum {
          transform-origin:50% 0; padding-top:64px;
          animation: fl-cd-swing 4.2s ease-in-out forwards;
        }
        #feedless-remind-overlay .fl-cord {
          position:absolute; top:0; left:50%; width:2px; height:68px;
          background:rgba(235,235,235,0.85); transform-origin:50% 0;
        }
        #feedless-remind-overlay .fl-sign {
          padding:22px 44px; text-align:center;
          background:rgba(16,18,24,0.94); border:3px solid rgba(${RED},0.9);
          border-radius:12px;
          box-shadow:0 8px 30px rgba(0,0,0,0.55), 0 0 18px rgba(${RED},0.35);
          color:#fff; font:800 clamp(34px,6vw,64px)/1.1 monospace; letter-spacing:8px;
        }
        #feedless-remind-overlay .fl-sign small {
          display:block; margin-top:10px; font-size:0.26em;
          letter-spacing:7px; text-indent:7px; color:rgba(${RED},0.95);
        }
      </style>
      <div class="fl-shade"></div>
      <div class="fl-hang">
        <div class="fl-pendulum">
          <div class="fl-cord" style="transform:translateX(-1px) rotate(20deg)"></div>
          <div class="fl-cord" style="transform:translateX(-1px) rotate(-20deg)"></div>
          <div class="fl-sign">CLOSED<small>GET BACK LATER</small></div>
        </div>
        <div class="fl-nail"></div>
      </div>`,
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
