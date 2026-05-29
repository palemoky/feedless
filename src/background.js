"use strict";
importScripts("sites.js");
importScripts("config.js");

const ALARM_PREFIX = "feedless_reminder_";
const SESSION_KEY_PREFIX = "reminderTab_";
const ACCUMULATED_KEY_PREFIX = "accumulated_";

// In-memory timers for DEV_MODE short intervals (seconds < 60).
// These are lost on service worker restart, which is acceptable for dev testing.
const devTimers = new Map(); // category -> timeoutId

// Track which category is currently active and when it started.
// Lost on service worker restart; accumulated time in session storage persists.
let currentCategory = null;
let currentCategoryStart = null; // Date.now() when this category became active

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(
    { disabledSites: [], reminderIntervals: {} },
    () => {},
  );
});

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

// Save elapsed time for the in-memory current category to session storage.
async function saveCurrentCategoryElapsed() {
  if (!currentCategory || !currentCategoryStart) return;
  const elapsed = (Date.now() - currentCategoryStart) / 1000;
  await addAccumulated(currentCategory, elapsed);
  currentCategory = null;
  currentCategoryStart = null;
}

function scheduleReminder(category, tabId, remainingSecs) {
  chrome.storage.session.set({ [SESSION_KEY_PREFIX + category]: tabId });
  if (remainingSecs < 60) {
    // Dev mode short interval: use setTimeout and show a countdown overlay
    chrome.tabs
      .sendMessage(tabId, {
        type: "feedless:countdownStart",
        seconds: remainingSecs,
      })
      .catch(() => {});
    devTimers.set(
      category,
      setTimeout(() => handleReminderFired(category), remainingSecs * 1000),
    );
  } else {
    chrome.alarms.create(ALARM_PREFIX + category, {
      delayInMinutes: remainingSecs / 60,
    });
  }
}

async function handleReminderFired(category) {
  devTimers.delete(category);

  const data = await chrome.storage.session.get(SESSION_KEY_PREFIX + category);
  const tabId = data[SESSION_KEY_PREFIX + category];
  if (!tabId) return;

  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (activeTab?.id !== tabId) return;

  const site = await getSiteForTab(tabId);
  const { disabledSites, reminderIntervals } = await getSettings();
  if (!site || site.category !== category || !disabledSites.includes(site.id)) {
    chrome.storage.session.remove(SESSION_KEY_PREFIX + category);
    return;
  }

  const interval = reminderIntervals[category] || 0;
  if (!interval) return;

  // Reset accumulated time and restart the cycle from now.
  await resetAccumulated(category);
  currentCategoryStart = Date.now();

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

  currentCategory = site.category;
  currentCategoryStart = Date.now();

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
      if (currentCategory === category) {
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
    chrome.storage.session.remove(
      categories.map((cat) => ACCUMULATED_KEY_PREFIX + cat),
    );
    currentCategory = null;
    currentCategoryStart = null;

    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) onActiveTabChange(tab.id);
    });
  }
});
