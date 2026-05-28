# Privacy Policy

**Last updated: 2026-05-28**

## Data Collection

Feedless does not collect, transmit, or share any personal data. All settings (per-site enable/disable state and reminder intervals) are stored locally on your device using `chrome.storage.sync`, which may be synced across your own devices via your Google account. No data is sent to the extension's developer or any third-party server.

## External Requests

The extension popup fetches site favicons from Google's favicon service (`https://www.google.com/s2/favicons`) solely to display site icons. No user data is included in these requests.

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Save your preferences (disabled sites, reminder intervals) |
| `tabs` | Detect the active tab's site to show its status in the popup |
| `alarms` | Schedule usage reminders at your configured intervals |
| Host permissions | Inject content scripts on supported sites to hide feed content |

## Contact

If you have questions, please open an issue at [github.com/palemoky/feedless](https://github.com/palemoky/feedless/issues).
