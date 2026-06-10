<div align="center">
<p align="center">
  <img src="icons/app/logo.svg" width="96" alt="Feedless logo">
</p>
# Feedless
</div>

Do you keep getting pulled away by recommended content every time you open a website? Feedless is a browser extension that hides homepage feeds, recommendation sections, and other distracting elements — giving you back control of your attention.

## Install

<a href="https://chromewebstore.google.com/detail/feedless/mkkdldcdmlfnodnlknphfffekdbmnnji">
  <img src="https://developer.chrome.com/static/docs/webstore/branding/image/UV4C4ybeBTsZt43U4xis.png" alt="Available in the Chrome Web Store" height="58">
</a>

## Supported Sites

| Video    | Social      | Shopping | Other |
| -------- | ----------- | -------- | ----- |
| YouTube  | X (Twitter) | Taobao   | Baidu |
| TikTok   | Xiaohongshu | JD.com   |       |
| Bilibili | Weibo       |          |       |
| Douyin   | Zhihu       |          |       |

## Reminders

Feedless can nudge you to take a break after you've spent a set amount of time on a site. Configure a reminder interval (5, 10, 15, 30, or 60 minutes) per category — Video, Social, Shopping, or Other — from the Reminder tab in the popup. When the timer expires, a browser notification prompts you to close the tab.

## Languages

English, Chinese (Simplified & Traditional), Japanese, French

## Project Structure

```
feedless/
├── manifest.json        # Extension config: permissions and URL matches
├── src/
│   ├── sites.js         # ★ Site configs — the only file you need to edit
│   ├── content.js       # Injects CSS to hide feed elements
│   ├── popup.html/js    # Popup UI with a toggle for each site
│   └── background.js    # Service worker (storage initialization)
├── _locales/            # Localization strings
├── icons/               # Extension icons
└── scripts/             # Build tooling (manifest generation, packaging)
```

## Building

`make build-all` writes one zip per browser to `dist/`:

```
dist/feedless-chrome-v<version>.zip    # Chrome Web Store
dist/feedless-edge-v<version>.zip      # Microsoft Edge Add-ons
dist/feedless-firefox-v<version>.zip   # Firefox (addons.mozilla.org)
```

Chrome and Edge ship the canonical `manifest.json`. The Firefox build is
transformed automatically (event-page `background.scripts` instead of a service
worker, plus the required `browser_specific_settings.gecko` block) by
`scripts/pack.cjs`. Set `DEV_MODE = false` in `src/config.js` before packaging;
the release workflow does this automatically when you `make release`.

