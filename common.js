// Shared helpers — used by background.js (service worker, via importScripts)
// and by popup.js / dashboard.js (via <script> tag). No import/export syntax
// on purpose so the same file works unmodified in both contexts.

/** Extract a trackable, privacy-minimal domain from a URL, or null. */
function getDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host || null;
  } catch (e) {
    return null;
  }
}

/** Local (not UTC) YYYY-MM-DD for a timestamp. */
function localDateStr(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Timestamp (ms) of local midnight starting the next day after ts. */
function startOfNextDay(ts) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** Add `days` calendar days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return localDateStr(dt.getTime());
}

/** Seconds -> "2h 14m" / "14m 3s" / "3s" */
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Storage key for a given day string. */
function dayKey(dateStr) {
  return `d:${dateStr}`;
}

const DAY_KEY_RE = /^d:\d{4}-\d{2}-\d{2}$/;

// ---- categories -----------------------------------------------------------
// Categorization is a display-time concern only — background.js never looks
// at this, so it can't affect what gets recorded, only how it's grouped
// afterwards. A domain not covered here (or overridden) is "Uncategorized".

const DEFAULT_CATEGORIES = [
  "News",
  "Entertainment",
  "AI",
  "Video Streaming",
  "Social Media",
  "Shopping",
  "Work/Productivity",
  "Music",
  "Reference",
];

const BUILTIN_DOMAIN_CATEGORIES = {
  // Video Streaming
  "youtube.com": "Video Streaming",
  "netflix.com": "Video Streaming",
  "twitch.tv": "Video Streaming",
  "hulu.com": "Video Streaming",
  "disneyplus.com": "Video Streaming",
  "primevideo.com": "Video Streaming",
  "max.com": "Video Streaming",
  "hbomax.com": "Video Streaming",
  "peacocktv.com": "Video Streaming",
  "vimeo.com": "Video Streaming",
  "dailymotion.com": "Video Streaming",

  // AI
  "chatgpt.com": "AI",
  "openai.com": "AI",
  "claude.ai": "AI",
  "anthropic.com": "AI",
  "gemini.google.com": "AI",
  "bard.google.com": "AI",
  "perplexity.ai": "AI",
  "midjourney.com": "AI",
  "huggingface.co": "AI",
  "copilot.microsoft.com": "AI",

  // News
  "cnn.com": "News",
  "bbc.com": "News",
  "bbc.co.uk": "News",
  "nytimes.com": "News",
  "reuters.com": "News",
  "theguardian.com": "News",
  "foxnews.com": "News",
  "apnews.com": "News",
  "npr.org": "News",
  "washingtonpost.com": "News",
  "news.google.com": "News",
  "news.ycombinator.com": "News",

  // Social Media
  "facebook.com": "Social Media",
  "instagram.com": "Social Media",
  "twitter.com": "Social Media",
  "x.com": "Social Media",
  "reddit.com": "Social Media",
  "tiktok.com": "Social Media",
  "linkedin.com": "Social Media",
  "pinterest.com": "Social Media",
  "snapchat.com": "Social Media",
  "threads.net": "Social Media",
  "mastodon.social": "Social Media",

  // Shopping
  "amazon.com": "Shopping",
  "ebay.com": "Shopping",
  "etsy.com": "Shopping",
  "walmart.com": "Shopping",
  "aliexpress.com": "Shopping",
  "target.com": "Shopping",

  // Work/Productivity
  "github.com": "Work/Productivity",
  "gitlab.com": "Work/Productivity",
  "stackoverflow.com": "Work/Productivity",
  "notion.so": "Work/Productivity",
  "slack.com": "Work/Productivity",
  "docs.google.com": "Work/Productivity",
  "drive.google.com": "Work/Productivity",
  "mail.google.com": "Work/Productivity",
  "outlook.com": "Work/Productivity",
  "trello.com": "Work/Productivity",
  "figma.com": "Work/Productivity",
  "atlassian.com": "Work/Productivity",
  "asana.com": "Work/Productivity",
  "calendar.google.com": "Work/Productivity",

  // Music
  "spotify.com": "Music",
  "soundcloud.com": "Music",
  "music.youtube.com": "Music",
  "music.apple.com": "Music",
  "pandora.com": "Music",

  // Reference
  "wikipedia.org": "Reference",
  "en.wikipedia.org": "Reference",

  // Entertainment (broader than pure video: games, forums, humor)
  "9gag.com": "Entertainment",
  "imgur.com": "Entertainment",
  "tumblr.com": "Entertainment",
  "steampowered.com": "Entertainment",
  "store.steampowered.com": "Entertainment",
  "ign.com": "Entertainment",
};

/**
 * Effective category for a domain: an explicit user assignment wins, then
 * the built-in guess, both only if that category still exists in `list` —
 * a deleted or renamed category must not keep silently labeling sites.
 */
function categoryFor(domain, assignments, list) {
  const c = (assignments && assignments[domain]) || BUILTIN_DOMAIN_CATEGORIES[domain];
  return c && list.includes(c) ? c : "Uncategorized";
}
