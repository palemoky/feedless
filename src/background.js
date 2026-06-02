"use strict";
importScripts("sites.js");
importScripts("config.js");

const ALARM_PREFIX = "feedless_reminder_";
const SESSION_KEY_PREFIX = "reminderTab_";
const ACCUMULATED_KEY_PREFIX = "accumulated_";

// chrome.alarms silently clamps any delay below ~30s (and logs a warning for
// unpacked builds). When the user switches back to a site having already spent
// almost the whole interval, the remaining time can be just a few seconds; pin
// it to this floor so behaviour is explicit and predictable instead of relying
// on Chrome's hidden clamp.
const MIN_ALARM_SECS = 30;

// In-memory timers for DEV_MODE short intervals (seconds < 60).
// These are lost on service worker restart, which is acceptable for dev testing.
const devTimers = new Map(); // category -> timeoutId

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

function scheduleReminder(category, tabId, remainingSecs) {
  chrome.storage.session.set({ [SESSION_KEY_PREFIX + category]: tabId });
  if (DEV_MODE && remainingSecs < 60) {
    // Dev mode short interval: use setTimeout and show a countdown overlay.
    // setTimeout does not survive service-worker suspension, which is
    // acceptable for dev testing only. Production always uses chrome.alarms,
    // which persists across worker restarts.
    chrome.tabs
      .sendMessage(tabId, {
        type: "feedless:countdownStart",
        seconds: Math.round(remainingSecs),
      })
      .catch(() => {});
    devTimers.set(
      category,
      setTimeout(() => handleReminderFired(category), remainingSecs * 1000),
    );
  } else {
    chrome.alarms.create(ALARM_PREFIX + category, {
      delayInMinutes: Math.max(remainingSecs, MIN_ALARM_SECS) / 60,
    });
  }
}

async function handleReminderFired(category) {
  devTimers.delete(category);

  const data = await chrome.storage.session.get(SESSION_KEY_PREFIX + category);
  const tabId = data[SESSION_KEY_PREFIX + category];
  if (!tabId) return;

  // Only remind if the scheduled tab is the foreground tab of its own window.
  // Checking tab.active (rather than comparing against the focused window's
  // active tab) avoids silently dropping the reminder when the tab lives in a
  // non-focused window — e.g. side-by-side windows.
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    chrome.storage.session.remove(SESSION_KEY_PREFIX + category);
    return;
  }
  if (!tab?.active) return;

  const site = await getSiteForTab(tabId);
  const { disabledSites, reminderIntervals } = await getSettings();
  if (!site || site.category !== category || disabledSites.includes(site.id)) {
    chrome.storage.session.remove(SESSION_KEY_PREFIX + category);
    return;
  }

  const interval = reminderIntervals[category] || 0;
  if (!interval) return;

  // Reset accumulated time and restart the cycle from now.
  await resetAccumulated(category);
  await setActive(category, Date.now());

  chrome.tabs.sendMessage(tabId, { type: "feedless:remind" }).catch(() => {});
  scheduleReminder(category, tabId, interval);
}

async function clearAllReminderAlarms() {
  const alarms = await chrome.alarms.getAll();
  for (const alarm of alarms) {
    if (alarm.name.startsWith(ALARM_PREFIX)) chrome.alarms.clear(alarm.name);
  }
  for (const tid of devTimers.values()) clearTimeout(tid);
  devTimers.clear();
  const keys = [...new Set(SITES.map((s) => s.category))].map(
    (cat) => SESSION_KEY_PREFIX + cat,
  );
  chrome.storage.session.remove(keys);
}

async function onActiveTabChange(tabId) {
  // Save elapsed time for the previous category before switching.
  await saveCurrentCategoryElapsed();

  await clearAllReminderAlarms();

  const site = await getSiteForTab(tabId);
  if (!site) return;

  const { disabledSites, reminderIntervals } = await getSettings();
  const interval = reminderIntervals[site.category] || 0;
  if (interval <= 0) return;

  // Schedule based on remaining time for this category.
  const accumulated = await getAccumulated(site.category);
  const remaining = Math.max(interval - accumulated, 1);

  await setActive(site.category, Date.now());

  scheduleReminder(site.category, tabId, remaining);
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

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const data = await chrome.storage.session.get(null);
  for (const [key, val] of Object.entries(data)) {
    if (key.startsWith(SESSION_KEY_PREFIX) && val === tabId) {
      const category = key.slice(SESSION_KEY_PREFIX.length);

      // If this was the actively-timed tab, save its elapsed time.
      const active = await getActive();
      if (active?.category === category) {
        await saveCurrentCategoryElapsed();
      }

      chrome.alarms.clear(ALARM_PREFIX + category);
      const tid = devTimers.get(category);
      if (tid !== undefined) {
        clearTimeout(tid);
        devTimers.delete(category);
      }
      chrome.storage.session.remove(key);
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
