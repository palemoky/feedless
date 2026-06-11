// To add a new site: append an entry to this array.
// id:        unique key, used in storage
// name:      native display name (shown in zh_CN / zh_TW)
// nameIntl:  (optional) international name shown in all other locales
// category:  'video' | 'social' | 'shopping' | 'other'
// hostnames: list of hostnames (with or without www)
// selectors: CSS selectors for recommendation containers to block. Each entry
//            is a selector string, or { css, paths } to apply that selector
//            only on the given URL paths (e.g. block a feed class on the home
//            page without touching profile pages that reuse the same class).
// paths:     (optional) only apply the whole site config on these URL paths;
//            omit to apply everywhere
// strategy:  'css' (default) hides via CSS display:none
//            'remove' physically removes nodes from the DOM
//            'spacer'  replaces the feed container with a fixed-height placeholder so
//                      the infinite-scroll sentinel stays below the viewport and never
//                      fires. Also blocks feed API calls via window.fetch override.
//                      Use when both hiding and removing collapse the container and
//                      trigger more loads (e.g. X/Twitter).
// spacerTarget:        (spacer only) selector for the feed container to replace.
// fetchBlockPatterns:  (spacer only) URL substrings the MAIN-world fetch blocker
//                      drops while the strategy is active (e.g. ["HomeTimeline"]).
function normalizeHostname(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^www\./, "");
}

function hostnameMatches(hostname, pattern) {
  const host = normalizeHostname(hostname);
  const rule = normalizeHostname(pattern);
  if (!host || !rule) return false;

  if (rule.startsWith("*.")) {
    const base = rule.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }

  return host === rule;
}

function findSiteByHostname(hostname) {
  return SITES.find((site) =>
    site.hostnames.some((rule) => hostnameMatches(hostname, rule)),
  );
}

const SITES = [
  // ── 视频 ──────────────────────────────────────────────────────────────────
 {
    id: "youtube",
    name: "YouTube",
    category: "video",
    hostnames: ["youtube.com", "www.youtube.com"],
    selectors: [
      "#secondary", // Sidebar recommendations on video page
      'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer', // Home feed grid
      "ytd-watch-next-secondary-results-renderer", // Sidebar recommendations on video page
      "ytd-reel-shelf-renderer", // Shorts shelf
      "ytd-rich-section-renderer", // Featured sections (breaking news etc.)
    ],
    // Expand the video column to fill the space left by the hidden sidebar.
    // Constrain #primary to the 16:9 player's natural width given viewport height,
    // then remove the player's max-height cap so it fills that width exactly.
    extraCSS:
      "#columns{max-width:100%!important}ytd-watch-flexy #primary{max-width:min(100%,calc((100vh - 56px)*16/9))!important}ytd-player,#player-container{max-height:none!important}",
  },
  {
    id: "bilibili",
    name: "Bilibili",
    category: "video",
    hostnames: ["bilibili.com", "www.bilibili.com"],
    selectors: [
      ".recommended-container_floor-aside", // Home recommendations
      ".recommend-list-v1", // Video page sidebar recs
    ],
  },
  {
    id: "douyin",
    name: "抖音",
    nameIntl: "Douyin",
    category: "video",
    hostnames: ["douyin.com", "www.douyin.com"],
    selectors: [
      ".discover-tab-container", // 抖音精选首页推荐
      '[class*="recommend-container"]',
      '[class*="videoFeedV2"]',
      '[data-e2e="feed-active-video"]',
    ],
  },
  {
    id: "tiktok",
    name: "TikTok",
    category: "video",
    hostnames: ["tiktok.com", "www.tiktok.com"],
    selectors: [
      '[data-e2e="recommend-list-item-container"]',
      '[class*="DivVideoFeedV2"]',
      '[class*="recommend-feed"]',
    ],
  },
  // ── 社交 ──────────────────────────────────────────────────────────────────
  {
    id: "x",
    name: "X (Twitter)",
    category: "social",
    hostnames: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
    paths: ["/", "/home"],
    strategy: "spacer",
    spacerTarget: '[data-testid="primaryColumn"] section',
    fetchBlockPatterns: ["HomeTimeline"],
    selectors: ['[data-testid="sidebarColumn"]', '[data-testid="pillLabel"]'],
  },
  {
    id: "xiaohongshu",
    name: "小红书",
    nameIntl: "Xiaohongshu",
    category: "social",
    hostnames: ["xiaohongshu.com", "www.xiaohongshu.com"],
    selectors: ["#exploreFeeds"],
  },
  {
    id: "weibo",
    name: "微博",
    nameIntl: "Weibo",
    category: "social",
    hostnames: ["weibo.com", "www.weibo.com"],
    // collapseChildren: selectors target containers whose children should be hidden,
    // but the containers themselves must remain in the DOM to avoid triggering
    // virtual-scroll / IntersectionObserver infinite-load loops.
    collapseChildren: true,
    selectors: [
      // 主页推荐流。个人主页 (/u/...) 的微博列表复用同一个虚拟滚动类名，
      // 所以按路径限定只在首页生效，避免把别人主页的内容也屏蔽掉。
      { css: ".vue-recycle-scroller__item-wrapper", paths: ["/"] },
      ".recommend", // 视频页推荐
      "#__sidebar", // 个人主页右侧热榜与推荐
    ],
  },
  {
    id: "zhihu",
    name: "知乎",
    nameIntl: "Zhihu",
    category: "social",
    hostnames: ["zhihu.com", "www.zhihu.com"],
    selectors: [
      '[class~="woo-box-flex"][class*="_content_"][class*="_noside1_"]', // Home feed
      ".Topstory-container", // Home feed
      ".HotSearchCard", // Hot search card
    ],
  },

  // ── 购物 ──────────────────────────────────────────────────────────────────
  {
    id: "taobao",
    name: "淘宝",
    nameIntl: "Taobao",
    category: "shopping",
    hostnames: ["taobao.com", "www.taobao.com", "*.taobao.com"],
    selectors: [
      ".layer", // Home page recommendations
      ".tb-pick-feeds-container", // Cart and bought page recommendations
    ],
  },
  {
    id: "jd",
    name: "京东",
    nameIntl: "JD.com",
    category: "shopping",
    hostnames: ["jd.com", "www.jd.com", "*.jd.com"],
    selectors: [
      "#J_feeds", // Home page recommendations
      '[class*="_cart-recommend_"]', // Cart recommendation block (dynamic suffix)
    ],
  },

  // ── 其他 ──────────────────────────────────────────────────────────────────
  {
    id: "baidu",
    name: "百度",
    nameIntl: "Baidu",
    category: "other",
    hostnames: ["baidu.com", "www.baidu.com"],
    selectors: ["#s-hotsearch-wrapper", "#content_right"],
  },
];

// Node-only export so build tooling (scripts/gen-manifest.cjs) can read the
// site list. In the browser (content script / service worker) `module` is
// undefined, so this block is skipped and has no runtime effect.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SITES, findSiteByHostname, normalizeHostname, hostnameMatches };
}
