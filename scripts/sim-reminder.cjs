// Simulation harness for src/background.js: fake chrome.* APIs + virtual clock.
// Replays event sequences to hunt for the "30s countdown, no popup" stuck state.
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

const chrome = {
  storage: { session: makeStorageArea(), sync: makeStorageArea() },
  tabs: {
    query(q, cb) {
      let res = tabs.slice();
      if (q.active) res = res.filter((t) => t.active);
      if (q.currentWindow) res = res.filter((t) => t.windowId === FOCUSED_WINDOW);
      if (q.windowId !== undefined) res = res.filter((t) => t.windowId === q.windowId);
      if (cb) { cb(res); return; }
      return Promise.resolve(res);
    },
    get(id) {
      const t = tabs.find((t) => t.id === id);
      return t ? Promise.resolve({ ...t }) : Promise.reject(new Error("no tab"));
    },
    sendMessage(tabId, msg) {
      sentMessages.push({ t: NOW, tabId, msg });
      return Promise.resolve();
    },
    onActivated: { addListener: (f) => listeners.onActivated.push(f) },
    onUpdated: { addListener: (f) => listeners.onUpdated.push(f) },
    onRemoved: { addListener: (f) => listeners.onRemoved.push(f) },
  },
  alarms: {
    create(name, info) {
      alarms[name] = NOW + info.delayInMinutes * 60 * 1000;
    },
    clear(name) {
      delete alarms[name];
      return Promise.resolve(true);
    },
    getAll() {
      return Promise.resolve(
        Object.keys(alarms).map((name) => ({ name })),
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

let FOCUSED_WINDOW = 1;

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
async function focusWindow(id) {
  FOCUSED_WINDOW = id;
  for (const f of listeners.onFocusChanged) f(id);
  await settle();
}

function state(label) {
  const s = chrome.storage.session._data;
  const alarmList = Object.entries(alarms)
    .map(([n, at]) => `${n}@+${((at - NOW) / 1000).toFixed(0)}s`)
    .join(", ");
  realLog(`── ${label}`);
  realLog(`   session: ${JSON.stringify(s)}`);
  realLog(`   alarms:  [${alarmList || "none"}]`);
  const reminds = sentMessages.filter((m) => m.msg.type === "feedless:remind");
  realLog(`   reminds so far: ${reminds.length}`);
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
    state("opened video tab");
    await advance(600);
    state("after 10 min (alarm should have fired + popup)");
    await advance(600);
    state("after 20 min");
  }

  if (scenario === "close-reopen") {
    // Watch 9.5 min, close, reopen within grace, repeatedly.
    let v = await openTab("https://www.bilibili.com/video/abc");
    await advance(570); // 9.5 min watched
    const blank = await openTab("about:blank"); // user goes elsewhere
    await closeTab(v);
    state("closed video tab after 9.5min");
    await advance(60); // 1 min away (< grace)
    v = await openTab("https://www.bilibili.com/video/abc2");
    state("reopened video (should be ~30s remaining)");
    await advance(35);
    state("35s later — did reminder fire?");
    await advance(600);
    state("10 more min later");
  }

  if (scenario === "two-windows-close-tracked") {
    // Window 1: video tab (tracked). Window 2: another video tab.
    const v1 = await openTab("https://www.bilibili.com/video/a", { windowId: 1 });
    const v2 = await openTab("https://www.youtube.com/watch?v=b", { windowId: 2 });
    state("two windows, both video; tracked = v2 (last activated)");
    await advance(120);
    // user closes window 2 (its only tab) — no onActivated follows
    await closeTab(v2);
    await focusWindow(1);
    state("closed window-2 video tab (tracked)");
    await advance(600);
    state("10 min later, still watching window-1 video — popup?");
    // user finally clicks another video in window 1 (same tab navigation)
    await fireOnUpdated(v1.id);
    state("after in-tab navigation");
    await advance(35);
    state("35s later — popup?");
  }

  if (scenario === "fire-no-targets") {
    // alarm fires while no video tab is active in any window
    const v1 = await openTab("https://www.bilibili.com/video/a", { windowId: 1 });
    await advance(60);
    // window 2 exists with a non-video tab; user focuses it (no event fires
    // for window focus). Make window-1 video tab inactive via direct mutation
    // to emulate cases where the tab is not active in its window at fire time.
    const g = { id: nextTabId++, url: "https://example.com/", windowId: 2, active: true };
    tabs.push(g);
    v1.active = false; // e.g. devtools/picture-in-picture edge, or stale state
    FOCUSED_WINDOW = 2; // silent focus move (no event), worst case
    await advance(540);
    state("alarm fired with no active video tab anywhere");
    await advance(1200); // 20 min pass, user on example.com
    // user opens a new video tab in window 2
    const v3 = await openTab("https://www.bilibili.com/video/c", { windowId: 2 });
    state("opened new video tab after 20 min away");
    await advance(35);
    state("35s later — popup?");
    await advance(120);
    state("2 min more");
  }

  if (scenario === "window-switch") {
    // Window 1: video. Window 2: non-tracked site. User flips focus between
    // windows — previously this banked away-time into the video budget.
    const v1 = await openTab("https://www.bilibili.com/video/a", { windowId: 1 });
    const g = await openTab("https://example.com/", { windowId: 2 });
    await switchToTab(v1); // back to video, window 1
    await focusWindow(1);
    await advance(300); // watch 5 min
    await focusWindow(2); // work in window 2 for 20 min
    state("focused non-video window after 5 min of video");
    await advance(1200);
    await focusWindow(1); // back to the video window
    state("refocused video window after 20 min away (budget should be reset by grace)");
    await advance(620);
    state("10+ min later — popup?");
  }

  if (scenario === "rapid-reopen") {
    // accumulated >= interval; user keeps opening pages every ~20s
    const v1 = await openTab("https://www.bilibili.com/video/a");
    await advance(595); // 9:55 — just before fire
    // navigate in-tab repeatedly (SPA full reloads) every 20s
    for (let i = 0; i < 6; i++) {
      await fireOnUpdated(v1.id);
      await advance(20);
    }
    state("after 6 quick navigations 20s apart");
  }
})();
