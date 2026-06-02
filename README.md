# Feedless

<p align="center">
  <img src="icons/app/logo.png" width="96" alt="Feedless logo">
</p>

Do you keep getting pulled away by recommended content every time you open a website? Feedless is a browser extension that hides homepage feeds, recommendation sections, and other distracting elements — giving you back control of your attention.

## Supported Sites

| Video    | Social      | Shopping | Other |
| -------- | ----------- | -------- | ----- |
| YouTube  | X (Twitter) | Taobao   | Baidu |
| TikTok   | Xiaohongshu   | JD.com   |       |
| Bilibili | Weibo |          |       |
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
└── icons/               # Extension icons
```
