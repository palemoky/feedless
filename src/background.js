"use strict";
// Chrome's service worker pulls in shared modules via importScripts. Firefox
// MV3 runs an event page where importScripts is undefined, so the Firefox build
// lists these files in background.scripts instead — guard the call so the same
// source works for both targets.
if (typeof importScripts === "function") {
  importScripts("sites.js");
  importScripts("config.js");
}

const ALARM_PREFIX = "feedless_reminder_";
const SESSION_KEY_PREFIX = "reminderTab_";
const ACCUMULATED_KEY_PREFIX = "accumulated_";
// Absolute timestamp (ms) each category's reminder is scheduled to fire. The
// per-tab countdown overlay is derived from this so every tab of the same site
// shows the same deadline instead of an independently-drifting local snapshot.
const FIRE_AT_KEY_PREFIX = "fireAt_";

// Send a message to every open tab that belongs to `category`, so multi-tab /
// multi-window users get a consistent reminder + countdown across all of them
// rather than only on the single most-recently-active tab. Tabs we lack host
// permission for have no `url`; those are skipped.
async function broadcastToCategory(category, message) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    let site;
    try {
      site = getSiteByHostname(new URL(tab.url).hostname);
    } catch {
      continue;
    }
    if (site?.category === category) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  }
}

// Tell every category except `keepCategory` to drop its countdown overlay. Used
// when the active tab changes so stale overlays on other-category tabs clear,
// without racing the fresh countdownStart we send for the new category.
async function broadcastCountdownStop(keepCategory) {
  const categories = [...new Set(SITES.map((s) => s.category))];
  for (const c of categories) {
    if (c === keepCategory) continue;
    broadcastToCategory(c, { type: "feedless:countdownStop" });
  }
}

// chrome.alarms silently clamps any delay below ~30s (and logs a warning for
// unpacked builds). When the user switches back to a site having already spent
// almost the whole interval, the remaining time can be just a few seconds; pin
// it to this floor so behaviour is explicit and predictable instead of relying
// on Chrome's hidden clamp.
const MIN_ALARM_SECS = 30;

// Which category is currently active and when it started, persisted to session
// storage so an idle service-worker restart does not lose the elapsed time.
// Shape: { category, start } where start is Date.now() when it became active.
const ACTIVE_KEY = "feedless_active";

async function getActive() {
  const data = await chrome.storage.session.get(ACTIVE_KEY);
  return data[ACTIVE_KEY] || null;
}

async function setActive(category, start) {
  await chrome.storage.session.set({ [ACTIVE_KEY]: { category, start } });
}

async function clearActive() {
  await chrome.storage.session.remove(ACTIVE_KEY);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(
    { disabledSites: [], reminderIntervals: {} },
    () => {},
  );
  reconcileActiveTab();
});

// Re-establish the reminder for the current tab. Called when the service
// worker (re)starts so a reload/restart resumes reminders without waiting for
// the next tab switch. Skips if a schedule is already in place, to avoid
// resetting a running cycle on a routine worker wake-up.
async function reconcileActiveTab() {
  const alarms = await chrome.alarms.getAll();
  const hasReminder = alarms.some((a) => a.name.startsWith(ALARM_PREFIX));
  const active = await getActive();
  if (hasReminder || active?.category) return;

  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (activeTab?.id) await onActiveTabChange(activeTab.id);
}

// Browser startup and plain worker wake-ups both run the top-level script;
// onStartup covers browser launch, and the direct call covers extension reload.
chrome.runtime.onStartup.addListener(reconcileActiveTab);
reconcileActiveTab();

function getSiteByHostname(hostname) {
  return findSiteByHostname(hostname);
}

async function getSettings() {
  return new Promise((resolve) =>
    chrome.storage.sync.get(
      { disabledSites: [], reminderIntervals: {} },
      resolve,
    ),
  );
}

async function getSiteForTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return null;
    return getSiteByHostname(new URL(tab.url).hostname);
  } catch {
    return null;
  }
}

async function getAccumulated(category) {
  const data = await chrome.storage.session.get(
    ACCUMULATED_KEY_PREFIX + category,
  );
  return data[ACCUMULATED_KEY_PREFIX + category] || 0;
}

async function addAccumulated(category, seconds) {
  const current = await getAccumulated(category);
  await chrome.storage.session.set({
    [ACCUMULATED_KEY_PREFIX + category]: current + seconds,
  });
}

async function resetAccumulated(category) {
  await chrome.storage.session.remove(ACCUMULATED_KEY_PREFIX + category);
}

// Save elapsed time for the active category to session storage.
async function saveCurrentCategoryElapsed() {
  const active = await getActive();
  if (!active?.category || !active.start) return;
  const elapsed = (Date.now() - active.start) / 1000;
  await addAccumulated(active.category, elapsed);
  await clearActive();
}

async function scheduleReminder(category, tabId, remainingSecs) {
  chrome.storage.session.set({ [SESSION_KEY_PREFIX + category]: tabId });

  // The alarm cannot fire sooner than MIN_ALARM_SECS, so the countdown must
  // count down to the *effective* fire time — otherwise it would hit 0 and then
  // hang while the clamped alarm finishes.
  const delaySecs = Math.max(remainingSecs, MIN_ALARM_SECS);
  const fireAt = Date.now() + delaySecs * 1000;
  await chrome.storage.session.set({ [FIRE_AT_KEY_PREFIX + category]: fireAt });

  // In DEV_MODE, show a live countdown overlay. Purely visual: the reminder
  // always fires from chrome.alarms, which persists across worker restarts
  // (setTimeout would not). Broadcast to every tab of this category so multiple
  // same-site tabs stay in sync instead of each running its own clock.
  if (DEV_MODE) {
    broadcastToCategory(category, { type: "feedless:countdownStart", fireAt });
  }

  chrome.alarms.create(ALARM_PREFIX + category, {
    delayInMinutes: delaySecs / 60,
  });
}

async function handleReminderFired(category) {
  const { disabledSites, reminderIntervals } = await getSettings();
  const interval = reminderIntervals[category] || 0;

  // Find every foreground tab (one per window) that currently shows a site in
  // this category. Checking tab.active per window — rather than only the single
  // tracked tab — means the reminder shows wherever the user is actually
  // looking, even if they switched between multiple same-site tabs or windows.
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true });
  } catch {
    tabs = [];
  }
  const targets = [];
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    let site;
    try {
      site = getSiteByHostname(new URL(tab.url).hostname);
    } catch {
      continue;
    }
    if (site?.category === category && !disabledSites.includes(site.id)) {
      targets.push(tab.id);
    }
  }

  if (!interval || targets.length === 0) {
    chrome.storage.session.remove(SESSION_KEY_PREFIX + category);
    return;
  }

  // Reset accumulated time and restart the cycle from now.
  await resetAccumulated(category);
  await setActive(category, Date.now());

  for (const id of targets) {
    chrome.tabs.sendMessage(id, { type: "feedless:remind" }).catch(() => {});
  }

  // Keep tracking the previously-scheduled tab if it's still a valid target,
  // otherwise fall back to the first foreground tab we found.
  const data = await chrome.storage.session.get(SESSION_KEY_PREFIX + category);
  const tracked = data[SESSION_KEY_PREFIX + category];
  const nextTab = targets.includes(tracked) ? tracked : targets[0];
  await scheduleReminder(category, nextTab, interval);
}

async function clearAllReminderAlarms() {
  const alarms = await chrome.alarms.getAll();
  for (const alarm of alarms) {
    if (alarm.name.startsWith(ALARM_PREFIX)) chrome.alarms.clear(alarm.name);
  }
  const categories = [...new Set(SITES.map((s) => s.category))];
  chrome.storage.session.remove([
    ...categories.map((cat) => SESSION_KEY_PREFIX + cat),
    ...categories.map((cat) => FIRE_AT_KEY_PREFIX + cat),
  ]);
}

async function onActiveTabChange(tabId) {
  // Save elapsed time for the previous category before switching.
  await saveCurrentCategoryElapsed();

  await clearAllReminderAlarms();

  const site = await getSiteForTab(tabId);
  if (!site) {
    // Left all tracked sites — drop every countdown overlay.
    if (DEV_MODE) await broadcastCountdownStop(null);
    return;
  }

  const { disabledSites, reminderIntervals } = await getSettings();
  const interval = reminderIntervals[site.category] || 0;
  if (interval <= 0) {
    if (DEV_MODE) await broadcastCountdownStop(null);
    return;
  }

  // Schedule based on remaining time for this category.
  const accumulated = await getAccumulated(site.category);
  const remaining = Math.max(interval - accumulated, 1);

  await setActive(site.category, Date.now());

  await scheduleReminder(site.category, tabId, remaining);
  // Clear countdowns left over on other categories (the line above already
  // (re)started this category's countdown, so don't stop it here).
  if (DEV_MODE) await broadcastCountdownStop(site.category);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  onActiveTabChange(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
    if (activeTab?.id === tabId) onActiveTabChange(tabId);
  });
});

// Count still-open tabs belonging to `category`, excluding `excludeTabId`
// (the tab currently being removed, which may still appear in queries).
async function countCategoryTabs(category, excludeTabId) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return 0;
  }
  let n = 0;
  for (const tab of tabs) {
    if (!tab.id || tab.id === excludeTabId || !tab.url) continue;
    try {
      if (getSiteByHostname(new URL(tab.url).hostname)?.category === category) {
        n++;
      }
    } catch {}
  }
  return n;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const data = await chrome.storage.session.get(null);
  for (const [key, val] of Object.entries(data)) {
    if (key.startsWith(SESSION_KEY_PREFIX) && val === tabId) {
      const category = key.slice(SESSION_KEY_PREFIX.length);

      chrome.alarms.clear(ALARM_PREFIX + category);
      chrome.storage.session.remove([key, FIRE_AT_KEY_PREFIX + category]);

      // The budget is shared across all tabs of the category. Only wipe it when
      // the last such tab closes — otherwise the remaining tabs keep counting
      // toward the same interval (the newly-focused tab's onActivated reschedules
      // using the preserved accumulated time). Reopening after the last one
      // closes then starts a fresh full interval instead of warning immediately.
      const remaining = await countCategoryTabs(category, tabId);
      if (remaining === 0) {
        const active = await getActive();
        if (active?.category === category) await clearActive();
        await resetAccumulated(category);
      }
    }
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    handleReminderFired(alarm.name.slice(ALARM_PREFIX.length));
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "feedless:reminderUpdate") {
    // Reset accumulated times when reminder settings change.
    const categories = [...new Set(SITES.map((s) => s.category))];
    chrome.storage.session.remove([
      ...categories.map((cat) => ACCUMULATED_KEY_PREFIX + cat),
      ACTIVE_KEY,
    ]);

    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) onActiveTabChange(tab.id);
    });
  }
});
