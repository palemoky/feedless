'use strict';

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

async function init() {
  const [disabledSites, activeHostname] = await Promise.all([
    getDisabledSites(),
    getActiveTabHostname(),
  ]);

  const activeSiteId = SITES.find(s =>
    s.hostnames.some(h => h.replace(/^www\./, '') === activeHostname)
  )?.id ?? null;

  const list = document.getElementById('siteList');

  for (const site of SITES) {
    const enabled = !disabledSites.includes(site.id);
    const isCurrent = site.id === activeSiteId;

    const item = document.createElement('div');
    item.className = `site-item${isCurrent ? ' is-current' : ''}`;

    const info = document.createElement('div');
    info.className = 'site-info';

    const favicon = document.createElement('img');
    favicon.className = 'site-favicon';
    favicon.src = `https://www.google.com/s2/favicons?domain=${site.hostnames[0]}&sz=32`;
    favicon.alt = '';
    favicon.width = 16;
    favicon.height = 16;
    info.appendChild(favicon);

    const nameEl = document.createElement('span');
    nameEl.className = 'site-name';
    nameEl.textContent = site.name;
    info.appendChild(nameEl);

    const label = document.createElement('label');
    label.className = 'toggle';
    label.title = enabled ? '点击关闭屏蔽' : '点击开启屏蔽';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = enabled;
    checkbox.setAttribute('aria-label', `${site.name} 推荐屏蔽`);
    checkbox.addEventListener('change', async () => {
      label.title = checkbox.checked ? '点击关闭屏蔽' : '点击开启屏蔽';
      await setDisabledSites(site.id, checkbox.checked);
      notifyActiveTab(site.id, checkbox.checked);
    });

    const slider = document.createElement('span');
    slider.className = 'slider';

    label.appendChild(checkbox);
    label.appendChild(slider);
    item.appendChild(info);
    item.appendChild(label);
    list.appendChild(item);
  }
}

init();
