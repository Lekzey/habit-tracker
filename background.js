// HabitTracker — background service worker.
//
// Event-driven time accounting: on every relevant browser event we compute
// the elapsed time since the last event and attribute it to whichever
// domain(s) were open, then move the clock forward. We never run a live
// setInterval — MV3 service workers get killed after ~30s idle, so all
// "current" state lives in chrome.storage.session (in-memory, survives
// worker restarts) and gets re-seeded from chrome.tabs.query() if lost.

importScripts("common.js");

const ALARM_NAME = "tick";
const ALARM_PERIOD_MINUTES = 1;
const IDLE_DETECTION_SECONDS = 60;
const MAX_DELTA_MS = 2 * ALARM_PERIOD_MINUTES * 60 * 1000; // clamp for sleep/hibernate gaps

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// All event handlers below read-modify-write the same session state and day
// buckets. Chrome can fire several of them back-to-back before the first
// handler's awaits resolve, which would let two handlers read the same
// stale `lastTick` and double-count elapsed time. Serialize everything
// through one queue so handlers never interleave.
let _chain = Promise.resolve();
function enqueue(task) {
  _chain = _chain.then(task, task).catch((err) => console.error("HabitTracker:", err));
  return _chain;
}

async function init() {
  await enqueue(seedState);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
}

// ---- session state (ephemeral, survives service-worker restarts) --------

async function getSessionState() {
  const got = await chrome.storage.session.get("state");
  if (got.state) return got.state;
  return seedState();
}

async function setSessionState(state) {
  await chrome.storage.session.set({ state });
}

async function seedState() {
  const tabsList = await chrome.tabs.query({});
  const tabs = {};
  for (const t of tabsList) {
    if (t.incognito) continue;
    const d = getDomain(t.url || t.pendingUrl || "");
    if (d) tabs[t.id] = d;
  }
  let activeTabId = null;
  let windowFocused = false;
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win && win.focused) {
      windowFocused = true;
      const [activeTab] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (activeTab) activeTabId = activeTab.id;
    }
  } catch (e) {
    // no focused window (e.g. all windows closed) — leave defaults
  }
  const state = { lastTick: Date.now(), activeTabId, windowFocused, tabs, idle: false };
  await setSessionState(state);
  return state;
}

// ---- time accounting ------------------------------------------------------

async function flush() {
  const state = await getSessionState();
  const now = Date.now();
  let elapsed = now - state.lastTick;
  if (elapsed > 0) {
    if (elapsed > MAX_DELTA_MS) elapsed = MAX_DELTA_MS; // discard sleep/hibernate gaps
    if (!state.idle) {
      await distribute(state, state.lastTick, state.lastTick + elapsed);
    }
  }
  state.lastTick = now;
  await setSessionState(state);
}

/** Split [fromTs, toTs) at local-midnight boundaries and apply each segment. */
async function distribute(state, fromTs, toTs) {
  let cursor = fromTs;
  while (cursor < toTs) {
    const dayStr = localDateStr(cursor);
    const segEnd = Math.min(toTs, startOfNextDay(cursor));
    await applySegment(state, dayStr, segEnd - cursor);
    cursor = segEnd;
  }
}

async function applySegment(state, dayStr, ms) {
  if (ms <= 0) return;
  const tabs = state.tabs || {};
  const domains = new Set(Object.values(tabs).filter(Boolean));
  if (domains.size === 0) return;

  const fgDomain =
    state.windowFocused && state.activeTabId != null ? tabs[state.activeTabId] : null;

  const excluded = await getExcludedList();
  const updates = {};
  for (const d of domains) {
    if (!d || isExcluded(d, excluded)) continue;
    const bucket = d === fgDomain ? "fg" : "bg";
    if (!updates[d]) updates[d] = { fg: 0, bg: 0 };
    updates[d][bucket] += ms / 1000;
  }
  if (Object.keys(updates).length) await mergeIntoDay(dayStr, updates);
}

async function getExcludedList() {
  const got = await chrome.storage.local.get("settings");
  return (got.settings && got.settings.excluded) || [];
}

/** Excluding "example.com" also excludes "mail.example.com", etc. */
function isExcluded(domain, excludedList) {
  return excludedList.some((ex) => domain === ex || domain.endsWith("." + ex));
}

async function mergeIntoDay(dayStr, updates) {
  const key = dayKey(dayStr);
  const got = await chrome.storage.local.get(key);
  const day = got[key] || {};
  for (const [domain, delta] of Object.entries(updates)) {
    if (!day[domain]) day[domain] = { fg: 0, bg: 0 };
    day[domain].fg += delta.fg;
    day[domain].bg += delta.bg;
  }
  await chrome.storage.local.set({ [key]: day });
  await ensureDayIndexed(dayStr);
}

async function ensureDayIndexed(dayStr) {
  const got = await chrome.storage.local.get("meta");
  const meta = got.meta || { days: [] };
  if (!meta.days.includes(dayStr)) {
    meta.days.push(dayStr);
    meta.days.sort();
    await chrome.storage.local.set({ meta });
  }
}

// ---- tab / window / idle event listeners ----------------------------------

chrome.tabs.onActivated.addListener(({ tabId, windowId }) =>
  enqueue(async () => {
    await flush();
    const state = await getSessionState();
    state.activeTabId = tabId;
    try {
      const win = await chrome.windows.get(windowId);
      state.windowFocused = !!win.focused;
    } catch (e) {
      /* window may already be gone */
    }
    if (!(tabId in state.tabs)) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.incognito) {
          const d = getDomain(tab.url || tab.pendingUrl || "");
          if (d) state.tabs[tabId] = d;
        }
      } catch (e) {
        /* tab may already be gone */
      }
    }
    await setSessionState(state);
  })
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
  enqueue(async () => {
    if (!changeInfo.url && changeInfo.status !== "complete") return;
    await flush();
    const state = await getSessionState();
    if (tab.incognito) {
      delete state.tabs[tabId];
    } else {
      const d = getDomain(tab.url || "");
      if (d) state.tabs[tabId] = d;
      else delete state.tabs[tabId];
    }
    await setSessionState(state);
  })
);

chrome.tabs.onCreated.addListener((tab) =>
  enqueue(async () => {
    await flush();
    const state = await getSessionState();
    if (!tab.incognito) {
      const d = getDomain(tab.url || tab.pendingUrl || "");
      if (d) state.tabs[tab.id] = d;
    }
    await setSessionState(state);
  })
);

chrome.tabs.onRemoved.addListener((tabId) =>
  enqueue(async () => {
    await flush();
    const state = await getSessionState();
    delete state.tabs[tabId];
    if (state.activeTabId === tabId) state.activeTabId = null;
    await setSessionState(state);
  })
);

chrome.windows.onFocusChanged.addListener((windowId) =>
  enqueue(async () => {
    await flush();
    const state = await getSessionState();
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      // All Brave windows lost OS focus — the previously-active tab is no
      // longer "in front of the user", so it must fall back to background
      // accounting rather than keep counting as foreground.
      state.windowFocused = false;
    } else {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, windowId });
        state.windowFocused = true;
        if (activeTab) state.activeTabId = activeTab.id;
      } catch (e) {
        state.windowFocused = false;
      }
    }
    await setSessionState(state);
  })
);

chrome.idle.onStateChanged.addListener((newState) =>
  enqueue(async () => {
    const state = await getSessionState();
    if (newState === "active") {
      // Coming back: don't attribute the idle gap to anything.
      state.idle = false;
      state.lastTick = Date.now();
      await setSessionState(state);
    } else {
      // 'idle' or 'locked': chrome only tells us the user crossed the idle
      // threshold now, but they actually went idle ~IDLE_DETECTION_SECONDS
      // ago. Flush up to that earlier point, then stop the clock.
      const backdated = Date.now() - IDLE_DETECTION_SECONDS * 1000;
      if (backdated > state.lastTick) {
        await distribute(state, state.lastTick, backdated);
      }
      state.lastTick = Date.now();
      state.idle = true;
      await setSessionState(state);
    }
  })
);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) enqueue(flush);
});

// Let the dashboard ask us to drop in-memory state after "clear all data",
// or to commit whatever time has accumulated in memory right now — the
// normal flush only runs on tab/window events or the once-a-minute alarm,
// so without this a Refresh clicked seconds after opening the dashboard
// can legitimately show no change yet.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "reseed") {
    enqueue(seedState).then(() => sendResponse({ ok: true }));
    return true; // keep the message channel open for the async response
  }
  if (msg && msg.type === "flush") {
    enqueue(flush).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
