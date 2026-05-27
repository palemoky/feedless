'use strict';

// Initialize storage defaults on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get({ disabledSites: [] }, () => {});
});
