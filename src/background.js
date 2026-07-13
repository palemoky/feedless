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
const PAUSED_KEY_PREFIX = "feedless_paused_";
const ENGAGED_KEY = "feedless_engaged";

// chrome.alarms silently clamps any delay below ~30s (and logs a warning for
// unpacked builds). Pin a floor so behaviour is explicit and predictable
// instead of relying on Chrome's hidden clamp.
const MIN_ALARM_SECS = 30;

// ─── Model ──────────────────────────────────────────────────────────────────
// Only one category can be "engaged" at a time: the category of the site
// showing in the currently active tab of the currently focused window. A
// category's timer only counts down while it is engaged; switching away
// (to a different category, a untracked site, or another window) pauses it,
// and switching between two sites of the *same* category (e.g. YouTube <->
// Bilibili) is not a change of engaged category at all, so it is a total
// no-op for the timer — this is what fixes the countdown resetting/jumping
// when hopping between same-category sites.
//
// State is intentionally minimal and lives in two places only:
//  - chrome.alarms: the alarm named ALARM_PREFIX+category exists iff that
//    category is *currently engaged and counting down*; its scheduledTime is
//    the absolute moment (ms) the reminder is due.
//  - chrome.storage.session[PAUSED_KEY_PREFIX+category]: set only while that
//    category is paused (not engaged) but still has unspent budget from its
//    last engaged stretch — { remainingMs, pausedAt }. Absent otherwise.
// There is no separate "elapsed time" accumulator: every earlier version of
// this feature that tracked elapsed time apart from the actual timer
// eventually drifted out of sync with it, which is what produced the
// "stuck at 30s" / "resets on tab switch" bugs.
//
// Pause -> resume rule (applied uniformly whether the tab was merely
// switched away from, its window lost focus, or every tab of the category
// was closed): remainingMs is frozen at the moment of pausing. If the
// category becomes engaged again before remainingMs has elapsed in real
// time, the countdown continues from exactly where it left off. If more
// real time than remainingMs passes first, the budget is discarded and the
// next engagement starts a fresh full interval.
//
// When the alarm fires while engaged: the reminder is shown on every
// currently-active tab of the category (across all windows), and the timer
// restarts fresh for a full interval, still engaged.

async function getSettings() {
  return new Promise((resolve) =>
    chrome.storage.sync.get(
      { disabledSites: [], reminderIntervals: {} },
      resolve,
    ),
  );
}

function getSiteByHostname(hostname) {
  return findSiteByHostname(hostname);
}

function siteForUrl(url) {
  try {
    return getSiteByHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}

// All currently open tabs whose site belongs to `category`, paired with their
// site, regardless of whether the tab is active/visible.
async function categoryTabs(category) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return [];
  }
  const matches = [];
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    const site = siteForUrl(tab.url);
    if (site?.category === category) matches.push({ tab, site });
  }
  return matches;
}

// Same as categoryTabs, minus tabs whose site is individually disabled — those
// don't count toward "is anyone here" and shouldn't receive a reminder.
async function eligibleCategoryTabs(category, disabledSites) {
  const all = await categoryTabs(category);
  return all.filter(({ site }) => !disabledSites.includes(site.id));
}

// A tab left open across an extension reload/update keeps its old content
// script running, but that instance's connection to the extension is severed
// the moment the new version loads — chrome.tabs.sendMessage to it fails with
// "Receiving end does not exist" and the reminder would silently never show
// until the user happens to refresh the page. Re-inject a fresh content
// script and retry once instead of giving up, so a reload doesn't quietly
// break reminders (or blocking) for every tab that was already open.
async function sendReminderWithReinject(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "feedless:remind" });
    return;
  } catch {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/sites.js", "src/content.js"],
    });
    await chrome.tabs.sendMessage(tabId, { type: "feedless:remind" });
  } catch {}
}

function computeFireAt(intervalSecs) {
  const now = Date.now();
  return Math.max(now + intervalSecs * 1000, now + MIN_ALARM_SECS * 1000);
}

function armAlarm(category, fireAt) {
  chrome.alarms.create(ALARM_PREFIX + category, { when: fireAt });
}

async function stopTimer(category) {
  await chrome.alarms.clear(ALARM_PREFIX + category);
}

async function getPaused(category) {
  const key = PAUSED_KEY_PREFIX + category;
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

async function setPaused(category, remainingMs, pausedAt) {
  await chrome.storage.session.set({
    [PAUSED_KEY_PREFIX + category]: { remainingMs, pausedAt },
  });
}

async function clearPaused(category) {
  await chrome.storage.session.remove(PAUSED_KEY_PREFIX + category);
}

async function getEngagedCategory() {
  const data = await chrome.storage.session.get(ENGAGED_KEY);
  return data[ENGAGED_KEY] || null;
}

async function setEngagedCategory(category) {
  if (category) await chrome.storage.session.set({ [ENGAGED_KEY]: category });
  else await chrome.storage.session.remove(ENGAGED_KEY);
}

// Purely visual: broadcast the live countdown (or its removal) to every tab of
// the category so multiple same-site/same-category tabs stay in sync instead
// of each running its own clock. Never affects scheduling.
function broadcastCountdown(entries, fireAt) {
  if (!DEV_MODE) return;
  for (const { tab } of entries) {
    chrome.tabs
      .sendMessage(tab.id, { type: "feedless:countdownStart", fireAt })
      .catch(() => {});
  }
}

function broadcastCountdownStop(entries) {
  if (!DEV_MODE) return;
  for (const { tab } of entries) {
    chrome.tabs
      .sendMessage(tab.id, { type: "feedless:countdownStop" })
      .catch(() => {});
  }
}

// Category stops being engaged: freeze however much time was left (if the
// timer was even running — it might not be, e.g. interval is 0) and drop the
// alarm. The frozen remainder plus this timestamp is exactly what a later
// engageCategory() needs to decide resume-vs-reset.
async function pauseCategory(category) {
  const alarm = await chrome.alarms.get(ALARM_PREFIX + category);
  if (!alarm) return;
  const now = Date.now();
  await stopTimer(category);
  await setPaused(category, Math.max(0, alarm.scheduledTime - now), now);
  broadcastCountdownStop(await categoryTabs(category));
}

// Category becomes engaged: resume the frozen countdown if we're still
// within its grace window, otherwise start a fresh full interval. No-op if
// the category has no configured interval.
async function engageCategory(category) {
  const { disabledSites, reminderIntervals } = await getSettings();
  const interval = reminderIntervals[category] || 0;
  if (interval <= 0) return;

  const now = Date.now();
  const paused = await getPaused(category);
  let fireAt;
  if (paused) {
    const elapsedIdle = now - paused.pausedAt;
    fireAt =
      elapsedIdle < paused.remainingMs
        ? now + paused.remainingMs
        : computeFireAt(interval);
    await clearPaused(category);
  } else {
    const existing = await chrome.alarms.get(ALARM_PREFIX + category);
    fireAt = existing ? existing.scheduledTime : computeFireAt(interval);
  }
  armAlarm(category, fireAt);

  const eligible = await eligibleCategoryTabs(category, disabledSites);
  broadcastCountdown(eligible, fireAt);
}

// The site of the active tab in the currently focused window, if any — the
// single candidate for "engaged category". lastFocusedWindow makes this
// independent of whichever window last fired an activation event.
async function getFocusedSite() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    return null;
  }
  const tab = tabs[0];
  return tab?.url ? siteForUrl(tab.url) : null;
}

async function engagedCategoryFor(site, disabledSites, reminderIntervals) {
  if (!site) return null;
  if (disabledSites.includes(site.id)) return null;
  if ((reminderIntervals[site.category] || 0) <= 0) return null;
  return site.category;
}

// Re-evaluate which category (if any) is engaged right now and transition
// only on an actual change. Same-category-to-same-category (including
// null-to-null) is a deliberate no-op — that's what makes hopping between
// two sites of one category, or between two untracked pages, invisible to
// the timer.
async function checkEngagement() {
  const { disabledSites, reminderIntervals } = await getSettings();
  const site = await getFocusedSite();
  const nextCategory = await engagedCategoryFor(
    site,
    disabledSites,
    reminderIntervals,
  );
  const prevCategory = await getEngagedCategory();
  if (nextCategory === prevCategory) return;

  if (prevCategory) await pauseCategory(prevCategory);
  if (nextCategory) await engageCategory(nextCategory);
  await setEngagedCategory(nextCategory);
}

async function handleReminderFired(category) {
  const { disabledSites, reminderIntervals } = await getSettings();
  const interval = reminderIntervals[category] || 0;
  const engaged = await getEngagedCategory();
  const eligible = await eligibleCategoryTabs(category, disabledSites);

  if (interval <= 0 || engaged !== category || eligible.length === 0) {
    // The alarm only runs while engaged, so this is a race (focus moved away
    // in the instant the alarm fired) rather than the normal path. Treat it
    // as "went idle with the budget fully spent right now" so the next
    // engagement starts fresh, and drop engaged state since it no longer
    // reflects an alarm we still own.
    await setPaused(category, 0, Date.now());
    await setEngagedCategory(null);
    broadcastCountdownStop(await categoryTabs(category));
    return;
  }

  // Show the overlay on every currently-active tab of the category, across
  // all windows — not just the focused one — so a video left playing active
  // in a second window also gets reminded.
  const activeTargets = eligible.filter(({ tab }) => tab.active);
  for (const { tab } of activeTargets) sendReminderWithReinject(tab.id);

  const fireAt = computeFireAt(interval);
  armAlarm(category, fireAt);
  broadcastCountdown(eligible, fireAt);
}

// Extension event listeners can run concurrently (e.g. onActivated and
// onUpdated firing almost simultaneously for the same navigation). Funnel
// every state-mutating handler through one promise chain so they run one at a
// time and never race each other's alarm/session-storage reads and writes.
let stateChain = Promise.resolve();
function serialized(fn) {
  return (...args) => {
    stateChain = stateChain.then(() => fn(...args)).catch(() => {});
    return stateChain;
  };
}

const allCategories = () => [...new Set(SITES.map((s) => s.category))];

const queueCheckEngagement = serialized(checkEngagement);

// Active tab changed within a window.
chrome.tabs.onActivated.addListener(() => queueCheckEngagement());
// Navigation completed in a tab — may have changed which site the (possibly
// already-active) tab shows.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") queueCheckEngagement();
});
// OS focus moved to a different window without changing which tab is active
// in either window — the only case that fires no tab event at all.
chrome.windows.onFocusChanged.addListener(() => queueCheckEngagement());
// Safety net: closing the engaged tab is normally followed by onActivated
// (browser focuses another tab) or onFocusChanged (window closes), but cover
// the case where neither follows.
chrome.tabs.onRemoved.addListener(() => queueCheckEngagement());

const queueReminderFired = serialized(handleReminderFired);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    queueReminderFired(alarm.name.slice(ALARM_PREFIX.length));
  }
});

const queueSettingsChanged = serialized(async function handleSettingsChanged() {
  // Interval or disabled-sites changed: drop all timer/pause state and let
  // checkEngagement rebuild it from scratch under the new settings, so a
  // changed interval always takes effect as a fresh full countdown.
  for (const category of allCategories()) {
    await stopTimer(category);
    await clearPaused(category);
  }
  await setEngagedCategory(null);
  await checkEngagement();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "feedless:reminderUpdate") queueSettingsChanged();
});

// Re-derive engagement from the currently focused tab. Called on
// install/startup/service-worker (re)start so a reload never leaves the
// timer stuck despite the user still sitting on a tracked tab. Session
// storage (and therefore engaged/paused state) does not survive a full
// browser restart, but chrome.alarms do; a stale alarm left over from before
// such a restart is harmless — checkEngagement will pause it (freezing
// whatever time happened to be left) if the tab it belongs to isn't the
// focused one, or leave it running as-is if it still is.
const queueReconcileAll = serialized(checkEngagement);

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(
    { disabledSites: [], reminderIntervals: {} },
    () => {},
  );
  queueReconcileAll();
});
chrome.runtime.onStartup.addListener(queueReconcileAll);
queueReconcileAll();
