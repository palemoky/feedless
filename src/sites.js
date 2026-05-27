// To add a new site: append an entry to this array.
// id:        unique key, used in storage
// name:      display name in popup
// hostnames: list of hostnames (with or without www)
// selectors: CSS selectors for recommendation containers to block
// paths:     (optional) only apply on these URL paths; omit to apply everywhere
// strategy:  'css' (default) hides via CSS display:none
//            'remove' physically removes nodes from the DOM
//            'spacer'  replaces the feed container with a fixed-height placeholder so
//                      the infinite-scroll sentinel stays below the viewport and never
//                      fires. Also blocks feed API calls via window.fetch override.
//                      Use when both hiding and removing collapse the container and
//                      trigger more loads (e.g. X/Twitter).
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
      '.exploreFeeds',
      // '.feeds-container',       // Main feed
      // '.note-item',             // Individual note items
      '#homefeed',              // Home feed wrapper
    ],
  },
  {
    id: 'x',
    name: 'X (Twitter)',
    hostnames: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
    paths: ['/', '/home'],
    strategy: 'spacer',
    // The timeline section to replace with a placeholder. Our placeholder is
    // min-height:100vh so the infinite-scroll sentinel is always below the fold.
    spacerTarget: '[data-testid="primaryColumn"] section',
    // Block the GraphQL HomeTimeline fetch as a secondary defense.
    fetchBlockPatterns: ['HomeTimeline'],
    // The sidebar is hidden with normal CSS (it doesn't affect scroll detection).
    selectors: ['[data-testid="sidebarColumn"]'],
  },
];
