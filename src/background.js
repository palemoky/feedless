'use strict';
importScripts('sites.js');
importScripts('config.js');

const ALARM_PREFIX = 'feedless_reminder_';
const SESSION_KEY_PREFIX = 'reminderTab_';

// In-memory timers for DEV_MODE short intervals (seconds < 60).
// These are lost on service worker restart, which is acceptable for dev testing.
const devTimers = new Map(); // category -> timeoutId

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get({ disabledSites: [], reminderIntervals: {} }, () => {});
});

function getSiteByHostname(hostname) {
  const clean = hostname.replace(/^www\./, '');
  return SITES.find(s => s.hostnames.some(h => h.replace(/^www\./, '') === clean));
}

async function getSettings() {
  return new Promise(resolve =>
    chrome.storage.sync.get({ disabledSites: [], reminderIntervals: {} }, resolve)
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

function scheduleReminder(category, tabId, intervalSecs) {
  chrome.storage.session.set({ [SESSION_KEY_PREFIX + category]: tabId });
  if (intervalSecs < 60) {
    // Dev mode short interval: use setTimeout and show a countdown overlay
    chrome.tabs.sendMessage(tabId, { type: 'feedless:countdownStart', seconds: intervalSecs }).catch(() => {});
    devTimers.set(category, setTimeout(() => handleReminderFired(category), intervalSecs * 1000));
  } else {
    chrome.alarms.create(ALARM_PREFIX + category, { delayInMinutes: intervalSecs / 60 });
  }
}

async function handleReminderFired(category) {
  devTimers.delete(category);

  const data = await chrome.storage.session.get(SESSION_KEY_PREFIX + category);
  const tabId = data[SESSION_KEY_PREFIX + category];
  if (!tabId) return;

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id !== tabId) return;

  const site = await getSiteForTab(tabId);
  const { disabledSites, reminderIntervals } = await getSettings();
  if (!site || site.category !== category || !disabledSites.includes(site.id)) {
    chrome.storage.session.remove(SESSION_KEY_PREFIX + category);
    return;
  }

  const interval = reminderIntervals[category] || 0;
  if (!interval) return;

  chrome.tabs.sendMessage(tabId, { type: 'feedless:remind' }).catch(() => {});
  scheduleReminder(category, tabId, interval);
}

async function clearAllReminderAlarms() {
  const alarms = await chrome.alarms.getAll();
  for (const alarm of alarms) {
    if (alarm.name.startsWith(ALARM_PREFIX)) chrome.alarms.clear(alarm.name);
  }
  for (const tid of devTimers.values()) clearTimeout(tid);
  devTimers.clear();
  const keys = [...new Set(SITES.map(s => s.category))].map(cat => SESSION_KEY_PREFIX + cat);
  chrome.storage.session.remove(keys);
}

async function onActiveTabChange(tabId) {
  await clearAllReminderAlarms();

  const site = await getSiteForTab(tabId);
  if (!site) return;

  const { disabledSites, reminderIntervals } = await getSettings();
  if (!disabledSites.includes(site.id)) return; // reminder only when blocking is off

  const interval = reminderIntervals[site.category] || 0;
  if (interval <= 0) return;

  scheduleReminder(site.category, tabId, interval);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  onActiveTabChange(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
    if (activeTab?.id === tabId) onActiveTabChange(tabId);
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const data = await chrome.storage.session.get(null);
  for (const [key, val] of Object.entries(data)) {
    if (key.startsWith(SESSION_KEY_PREFIX) && val === tabId) {
      const category = key.slice(SESSION_KEY_PREFIX.length);
      chrome.alarms.clear(ALARM_PREFIX + category);
      const tid = devTimers.get(category);
      if (tid !== undefined) { clearTimeout(tid); devTimers.delete(category); }
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
  if (msg.type === 'feedless:reminderUpdate') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) onActiveTabChange(tab.id);
    });
  }
});
