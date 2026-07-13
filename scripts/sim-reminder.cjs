// Simulation harness for src/background.js: fake chrome.* APIs + virtual clock.
// Exercises the "only the engaged (focused-window's active) tab counts down"
// model: switching between two sites of the same category is a no-op for the
// timer, switching away/closing pauses it, and resuming within the frozen
// remaining time continues rather than resets.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ─── virtual clock ───────────────────────────────────────────────────────────
let NOW = 1_000_000_000_000;
const realLog = console.log.bind(console);

// ─── fake storage area ───────────────────────────────────────────────────────
function makeStorageArea() {
  const data = {};
  return {
    _data: data,
    get(keys, cb) {
      let out = {};
      if (keys === null || keys === undefined) out = { ...data };
      else if (typeof keys === "string")
        out = keys in data ? { [keys]: data[keys] } : {};
      else if (Array.isArray(keys)) {
        for (const k of keys) if (k in data) out[k] = data[k];
      } else {
        out = { ...keys };
        for (const k of Object.keys(keys)) if (k in data) out[k] = data[k];
      }
      if (cb) { cb(out); return; }
      return Promise.resolve(out);
    },
    set(obj, cb) {
      Object.assign(data, obj);
      if (cb) { cb(); return; }
      return Promise.resolve();
    },
    remove(keys, cb) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
      if (cb) { cb(); return; }
      return Promise.resolve();
    },
  };
}

// ─── fake tabs ───────────────────────────────────────────────────────────────
// tab: { id, url, windowId, active }
let tabs = [];
const sentMessages = []; // { t, tabId, msg }
const staleTabIds = new Set(); // tabs whose content script is "dead" until re-injected
const injectionLog = []; // { t, tabId } from chrome.scripting.executeScript

const listeners = {
  onActivated: [],
  onUpdated: [],
  onRemoved: [],
  onAlarm: [],
  onMessage: [],
  onInstalled: [],
  onStartup: [],
  onFocusChanged: [],
};

// ─── fake alarms ─────────────────────────────────────────────────────────────
let alarms = {}; // name -> fireAtMs

let FOCUSED_WINDOW = 1;

const chrome = {
  storage: { session: makeStorageArea(), sync: makeStorageArea() },
  tabs: {
    query(q, cb) {
      let res = tabs.slice();
      if (q.active) res = res.filter((t) => t.active);
      if (q.currentWindow) res = res.filter((t) => t.windowId === FOCUSED_WINDOW);
      if (q.lastFocusedWindow) res = res.filter((t) => t.windowId === FOCUSED_WINDOW);
      if (q.windowId !== undefined) res = res.filter((t) => t.windowId === q.windowId);
      if (cb) { cb(res); return; }
      return Promise.resolve(res);
    },
    get(id) {
      const t = tabs.find((t) => t.id === id);
      return t ? Promise.resolve({ ...t }) : Promise.reject(new Error("no tab"));
    },
    sendMessage(tabId, msg) {
      // Tabs left open across a simulated extension reload keep a dead content
      // script until chrome.scripting.executeScript "revives" them below.
      if (staleTabIds.has(tabId)) {
        return Promise.reject(new Error("Receiving end does not exist."));
      }
      sentMessages.push({ t: NOW, tabId, msg });
      return Promise.resolve();
    },
    onActivated: { addListener: (f) => listeners.onActivated.push(f) },
    onUpdated: { addListener: (f) => listeners.onUpdated.push(f) },
    onRemoved: { addListener: (f) => listeners.onRemoved.push(f) },
  },
  scripting: {
    executeScript({ target: { tabId } }) {
      injectionLog.push({ t: NOW, tabId });
      staleTabIds.delete(tabId);
      return Promise.resolve();
    },
  },
  alarms: {
    create(name, info) {
      alarms[name] = info.when ?? NOW + (info.delayInMinutes || 0) * 60 * 1000;
    },
    clear(name) {
      const existed = name in alarms;
      delete alarms[name];
      return Promise.resolve(existed);
    },
    get(name) {
      if (!(name in alarms)) return Promise.resolve(undefined);
      return Promise.resolve({ name, scheduledTime: alarms[name] });
    },
    getAll() {
      return Promise.resolve(
        Object.entries(alarms).map(([name, scheduledTime]) => ({ name, scheduledTime })),
      );
    },
    onAlarm: { addListener: (f) => listeners.onAlarm.push(f) },
  },
  runtime: {
    onMessage: { addListener: (f) => listeners.onMessage.push(f) },
    onInstalled: { addListener: (f) => listeners.onInstalled.push(f) },
    onStartup: { addListener: (f) => listeners.onStartup.push(f) },
  },
  windows: {
    WINDOW_ID_NONE: -1,
    onFocusChanged: { addListener: (f) => listeners.onFocusChanged.push(f) },
  },
};

// ─── load background.js in a sandbox ─────────────────────────────────────────
const sandbox = {
  chrome,
  console,
  Date: { now: () => NOW },
  URL,
  Promise,
  setTimeout, // unused by background.js
  importScripts: undefined,
};
vm.createContext(sandbox);
for (const f of ["sites.js", "config.js", "background.js"]) {
  const code = fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
  vm.runInContext(code, sandbox, { filename: f });
}

// ─── helpers to drive events (await each so the serialized chain settles) ────
const tick = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 50; i++) await tick();
}

async function fireOnActivated(tabId) {
  for (const f of listeners.onActivated) f({ tabId });
  await settle();
}
async function fireOnUpdated(tabId) {
  for (const f of listeners.onUpdated) f(tabId, { status: "complete" });
  await settle();
}
async function fireOnRemoved(tabId) {
  for (const f of listeners.onRemoved) f(tabId);
  await settle();
}
async function fireOnMessage(msg) {
  for (const f of listeners.onMessage) f(msg);
  await settle();
}
async function fireOnFocusChanged(windowId) {
  for (const f of listeners.onFocusChanged) f(windowId);
  await settle();
}

// Advance virtual time; fire any due alarms in order.
async function advance(secs) {
  const target = NOW + secs * 1000;
  while (true) {
    const due = Object.entries(alarms)
      .filter(([, at]) => at <= target)
      .sort((a, b) => a[1] - b[1])[0];
    if (!due) break;
    NOW = due[1];
    delete alarms[due[0]];
    for (const f of listeners.onAlarm) f({ name: due[0] });
    await settle();
  }
  NOW = target;
}

// ─── scenario DSL ────────────────────────────────────────────────────────────
let nextTabId = 100;
async function openTab(url, { windowId = 1, activate = true } = {}) {
  const tab = { id: nextTabId++, url, windowId, active: false };
  tabs.push(tab);
  if (activate) {
    for (const t of tabs) if (t.windowId === windowId) t.active = false;
    tab.active = true;
    FOCUSED_WINDOW = windowId;
    await fireOnActivated(tab.id);
  }
  await fireOnUpdated(tab.id);
  return tab;
}
async function switchToTab(tab) {
  for (const t of tabs) if (t.windowId === tab.windowId) t.active = false;
  tab.active = true;
  FOCUSED_WINDOW = tab.windowId;
  await fireOnActivated(tab.id);
}
async function closeTab(tab, { thenActivate } = {}) {
  tabs = tabs.filter((t) => t.id !== tab.id);
  if (thenActivate) {
    for (const t of tabs) if (t.windowId === thenActivate.windowId) t.active = false;
    thenActivate.active = true;
  }
  await fireOnRemoved(tab.id);
  if (thenActivate) await fireOnActivated(thenActivate.id);
}
async function focusWindow(windowId) {
  FOCUSED_WINDOW = windowId;
  await fireOnFocusChanged(windowId);
}

function state(label) {
  const alarmList = Object.entries(alarms)
    .map(([n, at]) => `${n}@+${((at - NOW) / 1000).toFixed(0)}s`)
    .join(", ");
  const paused = Object.entries(chrome.storage.session._data)
    .filter(([k]) => k.startsWith("feedless_paused_"))
    .map(([k, v]) => `${k.slice("feedless_paused_".length)}:${(v.remainingMs / 1000).toFixed(0)}s@${v.pausedAt}`)
    .join(", ");
  const engaged = chrome.storage.session._data.feedless_engaged || "none";
  realLog(`── ${label}`);
  realLog(`   alarms:  [${alarmList || "none"}]   engaged: ${engaged}   paused: [${paused || "none"}]`);
  const reminds = sentMessages.filter((m) => m.msg.type === "feedless:remind");
  realLog(`   reminds so far: ${reminds.length}`);
  realLog(`   reinjections: ${injectionLog.length}`);
}

// ─── run a scenario ──────────────────────────────────────────────────────────
(async () => {
  await settle();
  // user config: video reminder = 10 min
  await chrome.storage.sync.set({
    reminderIntervals: { video: 600 },
    disabledSites: [],
  });

  const scenario = process.argv[2] || "basic";
  realLog(`=== scenario: ${scenario} ===`);

  if (scenario === "basic") {
    const v = await openTab("https://www.bilibili.com/video/abc");
    state("opened+activated video tab");
    await advance(600);
    state("after 10 min (alarm should have fired + popup)");
    await advance(600);
    state("after 20 min");
  }

  if (scenario === "spec-example") {
    // 30 min interval, watch 20 min, close all tabs, come back within the
    // remaining 10 min -> continues; come back after more than 10 min ->
    // resets to full 30 min.
    await chrome.storage.sync.set({ reminderIntervals: { video: 1800 } });

    let v = await openTab("https://www.bilibili.com/video/abc");
    await advance(1200); // 20 min watched
    await closeTab(v);
    state("closed all video tabs after 20 min (10 min should remain, paused)");

    v = await openTab("https://www.bilibili.com/video/abc2");
    state("reopened after a short gap (well within the 10 min left) — resumed");
    await advance(9 * 60);
    state("9 more min pass — no popup yet (~1 min left)");
    await advance(61);
    state("61s more — popup should have fired now, fresh 30 min cycle started");

    await closeTab(v);
    state("closed again");
    await advance(1800 + 1); // way more than any remaining budget
    state("stayed away over 30 min while closed — budget should be considered spent");
    v = await openTab("https://www.bilibili.com/video/abc3");
    state("reopened after the long gap — must start a fresh full 30 min cycle");
    await advance(1799);
    state("29:59 later — should not have fired yet");
    await advance(2);
    state("30:01 later — should fire now");
  }

  if (scenario === "cross-site-same-category") {
    // Switching between two different ACTIVE sites of the same category
    // (the reported YouTube <-> Bilibili bug) must never reset or pause.
    const yt = await openTab("https://www.youtube.com/watch?v=a");
    await advance(300); // 5 min on YouTube
    const bili = await openTab("https://www.bilibili.com/video/b");
    state("switched to Bilibili after 5 min on YouTube (still same category)");
    await advance(299);
    state("9:59 total — should not fire yet");
    await advance(1);
    state("10:00 total — should fire now, on the currently active (Bilibili) tab");
  }

  if (scenario === "switch-away-inactive-tab") {
    // The behaviour this whole model exists for: a video tab left OPEN but
    // not active/focused must NOT keep counting down.
    const v = await openTab("https://www.bilibili.com/video/a");
    await advance(300); // watch 5 min
    const other = await openTab("https://example.com/"); // switch away, video tab stays open in background
    state("switched to an unrelated tab after 5 min — video timer should pause with 5 min left");
    await advance(1200); // 20 min pass while working elsewhere
    state("20 min pass on the other tab — must NOT have fired (was paused)");
    await switchToTab(v);
    state("switched back to the (still open) video tab — 20 min away > 5 min left, so reset to full 10 min");
    await advance(599);
    state("9:59 after return — should not have fired yet");
    await advance(2);
    state("10:01 after return — should fire now");
  }

  if (scenario === "switch-away-and-back-within-grace") {
    // Pausing freezes the remaining time; it is not decremented by how long
    // the user was away, as long as they return within that same window
    // (mirrors the spec's "return within the remaining 10 min -> the 10 min
    // continues" example). So resuming after 20s away with 30s frozen still
    // leaves 30s, not 10s.
    const v = await openTab("https://www.bilibili.com/video/a");
    await advance(570); // 9.5 min watched, 30s left
    const other = await openTab("https://example.com/");
    state("switched away with 30s left");
    await advance(20); // 20s away, within the 30s grace
    await switchToTab(v);
    state("switched back after 20s — should resume with the full 30s still left");
    await advance(29);
    state("29s later — should not have fired yet");
    await advance(2);
    state("31s later — should fire now");
  }

  if (scenario === "two-windows-background-active-tab") {
    // Window 1 (focused): video tab, engaged. Window 2 (unfocused): another
    // video tab that is *active within its own window* but not focused —
    // must not itself drive the timer (only the focused window's active tab
    // does), yet still receives the popup if the reminder does fire.
    const v1 = await openTab("https://www.bilibili.com/video/a", { windowId: 1 });
    const v2 = await openTab("https://www.youtube.com/watch?v=b", { windowId: 2 });
    // openTab(activate:true) focuses window 2, so it's now the engaged one.
    await focusWindow(1);
    state("window 1 (bilibili) refocused — engaged again after brief pause");
    await advance(600);
    state("10 min later — popup should show on both v1 and v2 (both active tabs)");
  }

  if (scenario === "all-tabs-closed-no-return") {
    const v = await openTab("https://www.bilibili.com/video/a");
    await advance(60);
    await closeTab(v);
    state("closed only video tab after 1 min (9 min should remain, paused)");
    await advance(600);
    state("well past the 9 min remaining with nobody around — no popup");
  }

  if (scenario === "disabled-site") {
    await chrome.storage.sync.set({ disabledSites: ["bilibili"] });
    await openTab("https://www.bilibili.com/video/abc");
    state("opened disabled site's video tab — no countdown should start");
    await advance(600);
    state("10 min later — still nothing, by design");
  }

  if (scenario === "settings-change-resets-fresh") {
    const v = await openTab("https://www.bilibili.com/video/a");
    await advance(300); // 5 of 10 min elapsed
    await chrome.storage.sync.set({ reminderIntervals: { video: 120 } });
    await fireOnMessage({ type: "feedless:reminderUpdate" });
    state("changed interval to 2 min mid-cycle — should restart fresh at 2 min");
    await advance(119);
    state("1:59 after change — should not have fired yet");
    await advance(2);
    state("2:01 after change — should fire now");
  }

  if (scenario === "stale-tab-reload") {
    const v1 = await openTab("https://www.bilibili.com/video/a");
    staleTabIds.add(v1.id);
    await advance(600);
    state("alarm fired at a stale tab — should retry after re-injecting");
  }

  if (scenario === "reconcile-on-restart") {
    // Tab already open + focused before the service worker (re)loads must
    // keep its in-flight countdown across the simulated restart.
    const v = await openTab("https://www.bilibili.com/video/a");
    await advance(60);
    for (const f of listeners.onStartup) f();
    await settle();
    state("re-ran startup reconciliation mid-cycle — alarm must be unchanged");
    await advance(541);
    state("10 min total — should fire now");
  }
})();
