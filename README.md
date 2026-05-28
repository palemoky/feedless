# Feedless

<p align="center">
  <img src="icons/logo.png" width="96" alt="Feedless logo">
</p>

Feedless is a browser extension that removes homepage feeds, recommendation sections, and other distracting content — so you can visit a site with purpose and leave on your own terms.

## Supported Sites

| Video    | Social      | Shopping | Other |
| -------- | ----------- | -------- | ----- |
| YouTube  | X (Twitter) | Taobao   | Baidu |
| TikTok   | Instagram   | JD.com   |       |
| Bilibili | Xiaohongshu |          |       |
| Douyin   | Weibo       |          |       |
| Kuaishou | Zhihu       |          |       |

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
