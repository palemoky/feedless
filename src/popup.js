'use strict';

const t = (key, subs) => chrome.i18n.getMessage(key, subs);

// Use native name only for Chinese locales; fall back to nameIntl otherwise.
const isZh = chrome.i18n.getUILanguage().toLowerCase().startsWith('zh');
const siteName = site => (!isZh && site.nameIntl) ? site.nameIntl : site.name;

const CATEGORIES = [
  { id: 'video',    label: t('catVideo') },
  { id: 'social',   label: t('catSocial') },
  { id: 'shopping', label: t('catShopping') },
  { id: 'other',    label: t('catOther') },
];

const REMINDER_TAB_ID = '__reminder__';
const REMINDER_OPTIONS = [0, 5, 10, 15, 30, 60];

async function getDisabledSites() {
  return new Promise(resolve =>
    chrome.storage.sync.get({ disabledSites: [] }, ({ disabledSites }) => resolve(disabledSites))
  );
}

async function getActiveTabHostname() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      try {
        resolve(new URL(tab?.url ?? '').hostname.replace(/^www\./, ''));
      } catch {
        resolve(null);
      }
    });
  });
}

async function setDisabledSites(siteId, enabled) {
  const disabledSites = await getDisabledSites();
  const updated = enabled
    ? disabledSites.filter(id => id !== siteId)
    : [...new Set([...disabledSites, siteId])];
  return new Promise(resolve => chrome.storage.sync.set({ disabledSites: updated }, resolve));
}

function notifyActiveTab(siteId, enabled) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'feedless:toggle', siteId, enabled }).catch(() => {});
    }
  });
}

function createSiteItem(site, enabled, isCurrent) {
  const item = document.createElement('div');
  item.className = `site-item${isCurrent ? ' is-current' : ''}`;

  const info = document.createElement('div');
  info.className = 'site-info';

  const favicon = document.createElement('img');
  favicon.className = 'site-favicon';
  favicon.src = `https://www.google.com/s2/favicons?domain=${site.hostnames[0]}&sz=32`;
  favicon.alt = '';
  favicon.width = 14;
  favicon.height = 14;
  info.appendChild(favicon);

  const nameEl = document.createElement('span');
  nameEl.className = 'site-name';
  nameEl.textContent = siteName(site);
  info.appendChild(nameEl);

  const label = document.createElement('label');
  label.className = 'toggle';
  label.title = t(enabled ? 'titleEnabled' : 'titleDisabled');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = enabled;
  checkbox.setAttribute('aria-label', t('ariaLabel', [siteName(site)]));
  checkbox.addEventListener('change', async () => {
    label.title = t(checkbox.checked ? 'titleEnabled' : 'titleDisabled');
    await setDisabledSites(site.id, checkbox.checked);
    notifyActiveTab(site.id, checkbox.checked);
  });

  const slider = document.createElement('span');
  slider.className = 'slider';

  label.appendChild(checkbox);
  label.appendChild(slider);
  item.appendChild(info);
  item.appendChild(label);
  return item;
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.tab === tabId);
  });
  chrome.storage.local.set({ activeTab: tabId });
}

async function getReminderIntervals() {
  return new Promise(resolve =>
    chrome.storage.sync.get({ reminderIntervals: {} }, ({ reminderIntervals }) => resolve(reminderIntervals))
  );
}

function buildReminderPanel(reminderIntervals) {
  const container = document.createElement('div');
  container.className = 'reminder-panel';

  for (const { id, label } of CATEGORIES) {
    const row = document.createElement('div');
    row.className = 'reminder-row';

    const catLabel = document.createElement('span');
    catLabel.className = 'reminder-cat';
    catLabel.textContent = label;

    const select = document.createElement('select');
    select.className = 'reminder-select';

    for (const mins of REMINDER_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = mins;
      opt.textContent = mins === 0 ? t('reminderOff') : t('reminderMinutes', [String(mins)]);
      opt.selected = (reminderIntervals[id] || 0) === mins;
      select.appendChild(opt);
    }

    select.addEventListener('change', async () => {
      const updated = await new Promise(resolve =>
        chrome.storage.sync.get({ reminderIntervals: {} }, ({ reminderIntervals: ri }) => resolve(ri))
      );
      updated[id] = Number(select.value);
      chrome.storage.sync.set({ reminderIntervals: updated });
      chrome.runtime.sendMessage({ type: 'feedless:reminderUpdate' }).catch(() => {});
    });

    row.appendChild(catLabel);
    row.appendChild(select);
    container.appendChild(row);
  }

  const hint = document.createElement('p');
  hint.className = 'reminder-hint';
  hint.textContent = t('reminderHint');
  container.appendChild(hint);

  return container;
}

async function init() {
  const [disabledSites, activeHostname, { activeTab: savedTab }, reminderIntervals] = await Promise.all([
    getDisabledSites(),
    getActiveTabHostname(),
    new Promise(resolve => chrome.storage.local.get({ activeTab: 'video' }, resolve)),
    getReminderIntervals(),
  ]);

  const activeSite = SITES.find(s =>
    s.hostnames.some(h => h.replace(/^www\./, '') === activeHostname)
  );
  const activeSiteId = activeSite?.id ?? null;

  // Group sites by category
  const grouped = {};
  for (const site of SITES) {
    const cat = site.category ?? 'other';
    (grouped[cat] = grouped[cat] ?? []).push(site);
  }

  const tabBar = document.getElementById('tabBar');
  const tabPanels = document.getElementById('tabPanels');

  // Determine which tab to open: prefer the tab containing the active site
  const initialTab = activeSite?.category ?? savedTab ?? 'video';

  for (const { id, label } of CATEGORIES) {
    const sites = grouped[id];
    if (!sites?.length) continue;

    const btn = document.createElement('button');
    btn.className = `tab-btn${id === initialTab ? ' active' : ''}`;
    btn.dataset.tab = id;
    btn.textContent = label;
    btn.addEventListener('click', () => switchTab(id));
    tabBar.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = `tab-panel${id === initialTab ? ' active' : ''}`;
    panel.dataset.tab = id;

    for (const site of sites) {
      const enabled = !disabledSites.includes(site.id);
      const isCurrent = site.id === activeSiteId;
      panel.appendChild(createSiteItem(site, enabled, isCurrent));
    }

    tabPanels.appendChild(panel);
  }

  // Reminder settings tab
  const reminderBtn = document.createElement('button');
  reminderBtn.className = `tab-btn${initialTab === REMINDER_TAB_ID ? ' active' : ''}`;
  reminderBtn.dataset.tab = REMINDER_TAB_ID;
  reminderBtn.textContent = t('tabReminder');
  reminderBtn.addEventListener('click', () => switchTab(REMINDER_TAB_ID));
  tabBar.appendChild(reminderBtn);

  const reminderPanel = document.createElement('div');
  reminderPanel.className = `tab-panel${initialTab === REMINDER_TAB_ID ? ' active' : ''}`;
  reminderPanel.dataset.tab = REMINDER_TAB_ID;
  reminderPanel.appendChild(buildReminderPanel(reminderIntervals));
  tabPanels.appendChild(reminderPanel);
}

// Apply i18n to static HTML elements
document.querySelectorAll('[data-i18n]').forEach(el => {
  el.textContent = t(el.dataset.i18n);
});

document.getElementById('btnFeedback').textContent = t('btnFeedback');
document.getElementById('btnAbout').textContent = t('btnAbout');

document.getElementById('btnFeedback').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://github.com/palemoky/feedless/issues' });
});
document.getElementById('btnAbout').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://github.com/palemoky/feedless' });
});

init();
