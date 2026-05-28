// To add a new site: append an entry to this array.
// id:        unique key, used in storage
// name:      native display name (shown in zh_CN / zh_TW)
// nameIntl:  (optional) international name shown in all other locales
// category:  'video' | 'social' | 'shopping' | 'other'
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
  // ── 视频 ──────────────────────────────────────────────────────────────────
  {
    id: 'youtube',
    name: 'YouTube',
    category: 'video',
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
    category: 'video',
    hostnames: ['bilibili.com', 'www.bilibili.com'],
    selectors: [
      '.recommended-container_floor-aside',  // Home recommendations
      '.feed-card',                          // Feed cards
      '.video-recommend',                    // Video page sidebar recs
      '.rcmd-box',                           // Recommended box
    ],
  },
  {
    id: 'douyin',
    name: '抖音',
    nameIntl: 'Douyin',
    category: 'video',
    hostnames: ['douyin.com', 'www.douyin.com'],
    selectors: [
      '[class*="recommend-container"]',
      '[class*="videoFeedV2"]',
      '[data-e2e="feed-active-video"]',
    ],
  },
  {
    id: 'kuaishou',
    name: '快手',
    nameIntl: 'Kuaishou',
    category: 'video',
    hostnames: ['kuaishou.com', 'www.kuaishou.com'],
    selectors: [
      '.main-content',
      '[class*="feedList"]',
      '[class*="videoItem"]',
    ],
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    category: 'video',
    hostnames: ['tiktok.com', 'www.tiktok.com'],
    selectors: [
      '[data-e2e="recommend-list-item-container"]',
      '[class*="DivVideoFeedV2"]',
      '[class*="recommend-feed"]',
    ],
  },
  {
    id: 'twitch',
    name: 'Twitch',
    category: 'video',
    hostnames: ['twitch.tv', 'www.twitch.tv'],
    paths: ['/'],
    selectors: [
      '[data-target="directory-first-time-user-experience__discover"]',
      '.front-page-discovery',
      '[data-a-target="home-live-container"]',
      '.tw-tower',
    ],
  },

  // ── 社交 ──────────────────────────────────────────────────────────────────
  {
    id: 'xiaohongshu',
    name: '小红书',
    nameIntl: 'Xiaohongshu',
    category: 'social',
    hostnames: ['xiaohongshu.com', 'www.xiaohongshu.com'],
    selectors: [
      '.exploreFeeds',
      '#homefeed',
    ],
  },
  {
    id: 'x',
    name: 'X (Twitter)',
    category: 'social',
    hostnames: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
    paths: ['/', '/home'],
    strategy: 'spacer',
    spacerTarget: '[data-testid="primaryColumn"] section',
    fetchBlockPatterns: ['HomeTimeline'],
    selectors: [
      '[data-testid="sidebarColumn"]',
      '[data-testid="pillLabel"]',
    ],
  },
  {
    id: 'weibo',
    name: '微博',
    nameIntl: 'Weibo',
    category: 'social',
    hostnames: ['weibo.com', 'www.weibo.com'],
    selectors: [
      '.WB_feed_type',
      '[node-type="feed_list"]',
      '.main-wrap .WB_feed',
    ],
  },
  {
    id: 'zhihu',
    name: '知乎',
    nameIntl: 'Zhihu',
    category: 'social',
    hostnames: ['zhihu.com', 'www.zhihu.com'],
    selectors: [
      '.Topstory-container',
      '[class*="TopstoryItem"]',
      '.css-1yuhvjn',
    ],
  },
  {
    id: 'instagram',
    name: 'Instagram',
    category: 'social',
    hostnames: ['instagram.com', 'www.instagram.com'],
    selectors: [
      'main[role="main"] article',
      '[role="main"] ._aano',
      'section main div[class*="x9f619"]',
    ],
  },
  {
    id: 'facebook',
    name: 'Facebook',
    category: 'social',
    hostnames: ['facebook.com', 'www.facebook.com'],
    selectors: [
      '[role="feed"]',
      '[data-pagelet="FeedUnit"]',
    ],
  },
  {
    id: 'threads',
    name: 'Threads',
    category: 'social',
    hostnames: ['threads.net', 'www.threads.net'],
    selectors: [
      '[role="main"] [class*="x9f619"] > div > div',
      '[data-pressable-container="true"]',
    ],
  },
  {
    id: 'reddit',
    name: 'Reddit',
    category: 'social',
    hostnames: ['reddit.com', 'www.reddit.com'],
    selectors: [
      'shreddit-feed',
      '[data-testid="post-container"]',
      '.feed-unit',
    ],
  },
  {
    id: 'quora',
    name: 'Quora',
    category: 'social',
    hostnames: ['quora.com', 'www.quora.com'],
    selectors: [
      '.q-feed',
      '[class*="FeedItem"]',
      '.puppeteer_test_question_main',
    ],
  },

  // ── 购物 ──────────────────────────────────────────────────────────────────
  {
    id: 'taobao',
    name: '淘宝',
    nameIntl: 'Taobao',
    category: 'shopping',
    hostnames: ['taobao.com', 'www.taobao.com'],
    selectors: [
      '[class*="recommend-products"]',
      '[class*="waterfall"]',
      '#J_recommend_area',
      '.tbh-card-list',
    ],
  },
  {
    id: 'jd',
    name: '京东',
    nameIntl: 'JD.com',
    category: 'shopping',
    hostnames: ['jd.com', 'www.jd.com'],
    selectors: [
      '#J_SaleAndCoupon',
      '.rec-goods-list',
      '[class*="floor-goods"]',
      '.goods-recommend',
    ],
  },

  // ── 其他 ──────────────────────────────────────────────────────────────────
  {
    id: 'baidu',
    name: '百度',
    nameIntl: 'Baidu',
    category: 'other',
    hostnames: ['baidu.com', 'www.baidu.com'],
    selectors: [
      '#s-hotsearch-wrapper',
      '#content_right',
    ],
  },
];
