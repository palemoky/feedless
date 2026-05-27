// To add a new site: append an entry to this array.
// id:        unique key, used in storage
// name:      display name in popup
// hostnames: list of hostnames (with or without www)
// selectors: CSS selectors for recommendation containers to hide
// paths:     (optional) only apply on these URL paths; omit to apply everywhere
const SITES = [
  {
    id: 'youtube',
    name: 'YouTube',
    hostnames: ['youtube.com', 'www.youtube.com'],
    selectors: [
      'ytd-rich-grid-renderer',                      // Home feed grid
      'ytd-watch-next-secondary-results-renderer',   // Sidebar recommendations on video page
      'ytd-reel-shelf-renderer',                     // Shorts shelf
      'ytd-rich-section-renderer',                   // Featured sections (breaking news etc.)
    ],
  },
  {
    id: 'bilibili',
    name: 'Bilibili',
    hostnames: ['bilibili.com', 'www.bilibili.com'],
    selectors: [
      '.recommended-container_floor-aside',  // Home recommendations
      '.feed-card',                          // Feed cards
      '.video-recommend',                    // Video page sidebar recs
      '.rcmd-box',                           // Recommended box
    ],
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    hostnames: ['xiaohongshu.com', 'www.xiaohongshu.com'],
    selectors: [
      '.feeds-container',       // Main feed
      '.note-item',             // Individual note items
      '#homefeed',              // Home feed wrapper
    ],
  },
  {
    id: 'x',
    name: 'X (Twitter)',
    hostnames: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
    paths: ['/', '/home'],
    selectors: [
      'article[data-testid="tweet"]',              // Individual tweets in home timeline
      '[data-testid="sidebarColumn"]',             // Right sidebar (who to follow, trends)
    ],
  },
];
