// Canvas pixels are baked in at draw time (see charts.js), so a theme flip
// or a window resize needs an explicit re-draw — this closure is what
// the "resize" / prefers-color-scheme listeners in init() call. Declared
// first so it's assigned well before any TDZ concerns. Only set on views
// that actually draw a canvas (Overview, Analytics > Categories) — the
// site-detail view and the heatmap are plain DOM/CSS and repaint on their
// own for both resize and theme changes.
let _rerender = null;

// Everything on this page — text, charts, spacing — runs about a quarter
// larger than the popup. This is the one knob for the two canvas charts;
// everything else scales through dashboard.css.
const CHART_SCALE = 1.25;

// "overview" | "analytics" | "settings"
let _view = "overview";
// "bysite" | "categories" — only meaningful while _view === "analytics"
let _analyticsSubview = "bysite";
let _selectedSite = null;
let _heatmapYear = new Date().getFullYear();

// Cache of the most recent toolbar-range fetch, so switching between
// Overview/Analytics (or resizing/flipping theme) doesn't need to re-hit
// storage. A full year of one site's daily data is a separate fetch (the
// toolbar range rarely spans a whole year), cached per domain+year.
let _lastAggregate = null;
let _yearDataCache = {};

let _currentFrom = null;
let _currentTo = null;

// ---- theme toggle ---------------------------------------------------------
// theme-init.js (loaded in <head>) already applied any saved choice before
// first paint. This just wires up the button to flip it and remember the
// choice — canvases don't auto-redraw on a manual toggle the way they do
// for an OS-level prefers-color-scheme change, so this also re-fires
// _rerender.

function getEffectiveTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem("theme");
  } catch (e) {
    // fall through to the OS setting
  }
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateThemeIcon() {
  const isDark = getEffectiveTheme() === "dark";
  // Inline style, not the `hidden` attribute — an inline style always wins
  // the cascade over any stylesheet rule, sidestepping the exact class of
  // bug that made `.toolbar[hidden]` and `#pie[hidden]` need a fix earlier.
  document.getElementById("iconSun").style.display = isDark ? "" : "none";
  document.getElementById("iconMoon").style.display = isDark ? "none" : "";
  document.getElementById("themeBtn").title = isDark ? "Switch to light" : "Switch to dark";
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("theme", theme);
  } catch (e) {
    // localStorage can throw in some restricted contexts — the toggle still
    // works for this page load, it just won't be remembered next time.
  }
  updateThemeIcon();
  _rerender && _rerender();
}

document.getElementById("themeBtn").addEventListener("click", () => {
  setTheme(getEffectiveTheme() === "dark" ? "light" : "dark");
});

updateThemeIcon();

// ---- info modal ---------------------------------------------------------

document.getElementById("infoBtn").addEventListener("click", () => {
  document.getElementById("infoModal").showModal();
});

document.getElementById("infoClose").addEventListener("click", () => {
  document.getElementById("infoModal").close();
});

document.getElementById("infoModal").addEventListener("click", (e) => {
  if (e.target.id === "infoModal") e.target.close(); // click on the backdrop
});

// ---- sidebar navigation ----------------------------------------------

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    _view = btn.dataset.view;
    applyView();
    renderCurrentView();
  });
});

document.querySelectorAll(".subtab").forEach((btn) => {
  btn.addEventListener("click", () => {
    _analyticsSubview = btn.dataset.subview;
    applyView();
    renderCurrentView();
  });
});

document.getElementById("siteList").addEventListener("click", (e) => {
  const item = e.target.closest(".site-item");
  if (!item) return;
  const domain = item.dataset.domain;
  if (domain !== _selectedSite) _heatmapYear = new Date().getFullYear();
  _selectedSite = domain;
  applyView();
  renderCurrentView();
});

/** Single place that owns panel/subpanel visibility and active states. */
function applyView() {
  document.getElementById("overview").hidden = _view !== "overview";
  document.getElementById("analytics").hidden = _view !== "analytics";
  document.getElementById("settings").hidden = _view !== "settings";
  document.getElementById("toolbar").hidden = _view === "settings";

  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === _view));

  document.getElementById("analyticsBySite").hidden = _analyticsSubview !== "bysite";
  document.getElementById("analyticsCategories").hidden = _analyticsSubview !== "categories";
  document.querySelectorAll(".subtab").forEach((b) => b.classList.toggle("active", b.dataset.subview === _analyticsSubview));

  document
    .querySelectorAll(".site-item")
    .forEach((b) => b.classList.toggle("active", _analyticsSubview === "bysite" && b.dataset.domain === _selectedSite));

  document.getElementById("siteDetailEmpty").hidden = !!_selectedSite;
  document.getElementById("siteDetailContent").hidden = !_selectedSite;
}

// ---- range handling ---------------------------------------------------

function computeRange(preset, allDays) {
  const today = localDateStr(Date.now());
  switch (preset) {
    case "today":
      return [today, today];
    case "7d":
      return [addDaysStr(today, -6), today];
    case "30d":
      return [addDaysStr(today, -29), today];
    case "year":
      return [`${new Date().getFullYear()}-01-01`, today];
    case "all":
      return allDays.length ? [allDays[0], allDays[allDays.length - 1]] : [today, today];
    default:
      return [today, today];
  }
}

document.querySelectorAll("[data-range]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll("[data-range]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const allDays = await getAllDays();
    const [from, to] = computeRange(btn.dataset.range, allDays);
    document.getElementById("fromDate").value = from;
    document.getElementById("toDate").value = to;
    await loadRange(from, to);
  });
});

document.getElementById("applyCustom").addEventListener("click", async () => {
  document.querySelectorAll("[data-range]").forEach((b) => b.classList.remove("active"));
  const from = document.getElementById("fromDate").value;
  const to = document.getElementById("toDate").value;
  if (from && to) await loadRange(from, to);
});

document.getElementById("refreshBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.classList.add("spinning");
  btn.disabled = true;
  try {
    _yearDataCache = {}; // clear first so a refreshed heatmap (below) re-fetches
    if (_currentFrom && _currentTo) await loadRange(_currentFrom, _currentTo);
    await refreshSiteList();
  } finally {
    btn.classList.remove("spinning");
    btn.disabled = false;
  }
});

// ---- data loading -------------------------------------------------------

async function getAllDays() {
  const got = await chrome.storage.local.get("meta");
  return (got.meta && got.meta.days) || [];
}

/** Sum every domain's time across [fromStr, toStr], and return the raw
 * per-day breakdown too so a site-detail view can slice out one domain's
 * day-by-day history without a second round trip to storage. */
async function aggregateRange(fromStr, toStr) {
  const allDays = await getAllDays();
  const daysInRange = allDays.filter((d) => d >= fromStr && d <= toStr);
  const keys = daysInRange.map(dayKey);
  const got = keys.length ? await chrome.storage.local.get(keys) : {};

  const totals = {}; // domain -> {fg, bg}
  const perDay = {}; // dateStr -> {domain: {fg, bg}}
  for (const d of daysInRange) {
    const day = got[dayKey(d)];
    if (!day) continue;
    perDay[d] = day;
    for (const [domain, v] of Object.entries(day)) {
      if (!totals[domain]) totals[domain] = { fg: 0, bg: 0 };
      totals[domain].fg += v.fg;
      totals[domain].bg += v.bg;
    }
  }
  return { totals, perDay, daysInRange };
}

async function getAllTimeTotals() {
  const allDays = await getAllDays();
  if (!allDays.length) return {};
  const { totals } = await aggregateRange(allDays[0], allDays[allDays.length - 1]);
  return totals;
}

async function loadRange(fromStr, toStr) {
  _currentFrom = fromStr;
  _currentTo = toStr;
  // The background worker only writes accumulated time to storage on
  // tab/window events or a once-a-minute alarm — force it to commit
  // whatever's still sitting in memory before reading, or a range that
  // includes today can look stale (or a Refresh click can look like it
  // did nothing) for up to a minute after the last tab/window switch.
  await chrome.runtime.sendMessage({ type: "flush" }).catch((err) => console.warn("HabitTracker: flush failed —", err));
  _lastAggregate = await aggregateRange(fromStr, toStr);
  renderCurrentView();
}

/** Re-render whichever panel is currently visible from the cached data —
 * no storage round trip. Used after a nav/site/subtab click, and re-armed
 * as the "resize" / theme-change redraw hook for canvas-drawing views. */
function renderCurrentView() {
  if (!_lastAggregate) return;
  const { totals, perDay, daysInRange } = _lastAggregate;

  if (_view === "overview") {
    _rerender = () => renderOverview(totals, daysInRange.length);
    _rerender();
    return;
  }

  if (_view === "analytics") {
    if (_analyticsSubview === "bysite") {
      _rerender = null; // stat tiles + heatmap are DOM/CSS, not canvas
      if (_selectedSite) {
        renderSiteDetail(_selectedSite, totals, perDay);
        renderHeatmap(_selectedSite, _heatmapYear);
      }
      return;
    }
    if (_analyticsSubview === "categories") {
      // Resize/theme-change only needs to repaint the two canvases, not
      // re-read categories from storage and rebuild the manage/assign
      // tables (one <select> per tracked domain) on every drag-resize tick.
      _rerender = () => drawCategoryCharts(_lastCategoryEntries);
      renderCategoriesView(totals);
      return;
    }
  }

  _rerender = null; // settings — nothing to redraw
}

// Sort state for the Overview "All sites" table, and the entries it was
// last rendered from — a header click re-sorts from this cache instead of
// re-fetching or redrawing the (unrelated) charts above it.
let _tableSort = { key: "total", dir: "desc" };
let _lastOverviewEntries = null;

function renderOverview(totals, dayCount) {
  const entries = Object.entries(totals).map(([label, v]) => ({ label, ...v }));
  const totalFg = entries.reduce((s, e) => s + e.fg, 0);
  const totalBg = entries.reduce((s, e) => s + e.bg, 0);

  document.getElementById("statFg").textContent = formatDuration(totalFg);
  document.getElementById("statBg").textContent = formatDuration(totalBg);
  document.getElementById("statSites").textContent = String(entries.length);
  document.getElementById("statDays").textContent = String(dayCount);

  drawPieChart(document.getElementById("pie"), entries, CHART_SCALE);
  drawBarChart(document.getElementById("bar"), entries, CHART_SCALE);

  _lastOverviewEntries = entries;
  renderDurationTable(document.getElementById("tableBody"), entries, "label", true, _tableSort);
  updateSortHeaders();
}

function sortEntries(entries, labelKey, sort) {
  const valueOf = (e) => {
    if (sort.key === "total") return e.fg + e.bg;
    if (sort.key === "label") return e[labelKey];
    return e[sort.key];
  };
  const sorted = entries.slice();
  sorted.sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return sort.dir === "asc" ? cmp : -cmp;
  });
  return sorted;
}

function updateSortHeaders() {
  document.querySelectorAll("#table th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === _tableSort.key;
    th.classList.toggle("sort-active", active);
    if (active) th.dataset.dir = _tableSort.dir;
    else delete th.dataset.dir;
  });
}

document.querySelectorAll("#table th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (_tableSort.key === key) {
      _tableSort = { key, dir: _tableSort.dir === "asc" ? "desc" : "asc" };
    } else {
      // Text starts A→Z; every numeric column starts highest-first.
      _tableSort = { key, dir: key === "label" ? "asc" : "desc" };
    }
    if (_lastOverviewEntries) {
      renderDurationTable(document.getElementById("tableBody"), _lastOverviewEntries, "label", true, _tableSort);
      updateSortHeaders();
    }
  });
});

/** Shared renderer for the Overview "All sites" table and (below) the
 * site-detail day table share this shape closely enough to not bother —
 * kept separate on purpose since their columns differ (site vs date, and
 * only one links out). This one is Overview's. */
function renderDurationTable(tbody, entries, labelKey, linkify, sort) {
  tbody.textContent = "";
  sortEntries(entries, labelKey, sort)
    .forEach((e) => {
      const tr = document.createElement("tr");
      const tdLabel = document.createElement("td");
      if (linkify) {
        const link = document.createElement("a");
        link.href = `https://${e[labelKey]}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = e[labelKey];
        tdLabel.appendChild(link);
      } else {
        tdLabel.textContent = e[labelKey];
      }
      const tdFg = document.createElement("td");
      tdFg.textContent = formatDuration(e.fg);
      const tdBg = document.createElement("td");
      tdBg.textContent = formatDuration(e.bg);
      const tdTotal = document.createElement("td");
      tdTotal.textContent = formatDuration(e.fg + e.bg);
      tr.append(tdLabel, tdFg, tdBg, tdTotal);
      tbody.appendChild(tr);
    });
  if (entries.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "muted";
    td.textContent = "No data for this range yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

// ---- analytics: by site ---------------------------------------------------

function renderSiteDetail(domain, totals, perDay) {
  document.getElementById("siteDetailTitle").textContent = domain;
  document.getElementById("siteDetailLink").href = `https://${domain}`;

  const t = totals[domain] || { fg: 0, bg: 0 };
  document.getElementById("siteStatFg").textContent = formatDuration(t.fg);
  document.getElementById("siteStatBg").textContent = formatDuration(t.bg);

  const rows = Object.entries(perDay)
    .filter(([, day]) => day[domain])
    .map(([date, day]) => ({ date, fg: day[domain].fg, bg: day[domain].bg }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // most recent first

  document.getElementById("siteStatDays").textContent = String(rows.length);
  document.getElementById("siteStatLast").textContent = rows.length ? rows[0].date : "—";

  const tbody = document.getElementById("siteDayTableBody");
  tbody.textContent = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const tdDate = document.createElement("td");
    tdDate.textContent = r.date;
    const tdFg = document.createElement("td");
    tdFg.textContent = formatDuration(r.fg);
    const tdBg = document.createElement("td");
    tdBg.textContent = formatDuration(r.bg);
    const tdTotal = document.createElement("td");
    tdTotal.textContent = formatDuration(r.fg + r.bg);
    tr.append(tdDate, tdFg, tdBg, tdTotal);
    tbody.appendChild(tr);
  });
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "muted";
    td.textContent = "No data for this site in the selected range.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

/** All-time totals per domain, independent of the selected date range, so
 * the sidebar stays stable while you browse different ranges. */
async function refreshSiteList() {
  const list = document.getElementById("siteList");
  const totals = await getAllTimeTotals();
  const entries = Object.entries(totals)
    .map(([domain, v]) => ({ domain, total: v.fg + v.bg }))
    .sort((a, b) => b.total - a.total);

  list.textContent = "";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "site-list-empty";
    empty.textContent = "No sites tracked yet.";
    list.appendChild(empty);
    return;
  }

  entries.forEach(({ domain, total }) => {
    const btn = document.createElement("button");
    btn.className = "site-item";
    btn.dataset.domain = domain;
    if (_analyticsSubview === "bysite" && _selectedSite === domain) btn.classList.add("active");
    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = domain;
    const time = document.createElement("span");
    time.className = "site-time";
    time.textContent = formatDuration(total);
    btn.append(name, time);
    list.appendChild(btn);
  });
}

// ---- analytics: heatmap ----------------------------------------------

async function getSiteYearData(domain, year) {
  const key = `${domain}|${year}`;
  if (_yearDataCache[key]) return _yearDataCache[key];
  const allDays = await getAllDays();
  const yearDays = allDays.filter((d) => d.startsWith(`${year}-`));
  const keys = yearDays.map(dayKey);
  const got = keys.length ? await chrome.storage.local.get(keys) : {};
  const map = {}; // "YYYY-MM-DD" -> total seconds for this domain
  for (const d of yearDays) {
    const day = got[dayKey(d)];
    if (day && day[domain]) map[d] = day[domain].fg + day[domain].bg;
  }
  _yearDataCache[key] = map;
  return map;
}

function heatLevel(seconds) {
  if (seconds <= 0) return 0;
  const minutes = seconds / 60;
  if (minutes < 15) return 1;
  if (minutes < 60) return 2;
  if (minutes < 240) return 3;
  return 4;
}

async function renderHeatmap(domain, year) {
  document.getElementById("heatmapYearLabel").textContent = String(year);
  document.getElementById("heatmapNextYear").disabled = year >= new Date().getFullYear();

  const dayMap = await getSiteYearData(domain, year);
  const container = document.getElementById("heatmap");
  container.textContent = "";

  const jan1 = new Date(year, 0, 1);
  const dec31 = new Date(year, 11, 31);
  // Start the grid on the Sunday on/before Jan 1 so week columns line up
  // with real calendar weeks (verified against Jan 1 landing in the
  // correct day-of-week row before month labels were ever added).
  const cursor = new Date(jan1);
  cursor.setDate(cursor.getDate() - cursor.getDay());

  while (cursor <= dec31) {
    const week = document.createElement("div");
    week.className = "heatmap-week";
    for (let dow = 0; dow < 7; dow++) {
      const cell = document.createElement("div");
      cell.className = "heatmap-cell";
      if (cursor.getFullYear() !== year) {
        cell.dataset.empty = "1";
      } else {
        const dateStr = localDateStr(cursor.getTime());
        const seconds = dayMap[dateStr] || 0;
        const level = heatLevel(seconds);
        if (level > 0) cell.dataset.level = String(level);
        const tip = `${dateStr}\n${seconds ? formatDuration(seconds) : "No activity"}`;
        cell.addEventListener("mousemove", (e) => showTooltip(e.clientX, e.clientY, tip));
        cell.addEventListener("mouseleave", hideTooltip);
      }
      week.appendChild(cell);
      cursor.setDate(cursor.getDate() + 1);
    }
    container.appendChild(week);
  }
}

document.getElementById("heatmapPrevYear").addEventListener("click", () => {
  if (!_selectedSite) return;
  _heatmapYear -= 1;
  renderHeatmap(_selectedSite, _heatmapYear);
});

document.getElementById("heatmapNextYear").addEventListener("click", () => {
  if (!_selectedSite || _heatmapYear >= new Date().getFullYear()) return;
  _heatmapYear += 1;
  renderHeatmap(_selectedSite, _heatmapYear);
});

// ---- analytics: categories ---------------------------------------------

async function getCategories() {
  const got = await chrome.storage.local.get("categories");
  if (got.categories && Array.isArray(got.categories.list)) {
    return { list: got.categories.list, assignments: got.categories.assignments || {} };
  }
  return { list: [...DEFAULT_CATEGORIES], assignments: {} };
}

async function saveCategories(categories) {
  await chrome.storage.local.set({ categories });
}

// Cached so the resize/theme-change redraw hook can repaint the canvases
// without re-reading categories from storage or rebuilding the tables.
let _lastCategoryEntries = null;

async function renderCategoriesView(totals) {
  const { list, assignments } = await getCategories();

  const catTotals = {}; // category -> {fg, bg}
  for (const [domain, v] of Object.entries(totals)) {
    const cat = categoryFor(domain, assignments, list);
    if (!catTotals[cat]) catTotals[cat] = { fg: 0, bg: 0 };
    catTotals[cat].fg += v.fg;
    catTotals[cat].bg += v.bg;
  }
  // "Uncategorized" gets the muted "other" color rather than a categorical
  // hue, even if it's the largest slice — it isn't a real group the user
  // chose, and coloring it like one would overstate it.
  _lastCategoryEntries = Object.entries(catTotals).map(([label, v]) => ({
    label,
    ...v,
    isOther: label === "Uncategorized",
  }));
  drawCategoryCharts(_lastCategoryEntries);

  renderCategoryManageList(list);
  const allTotals = await getAllTimeTotals();
  renderAssignTable(Object.keys(allTotals).sort(), list, assignments);
}

function drawCategoryCharts(entries) {
  if (!entries) return;
  drawPieChart(document.getElementById("categoryPie"), entries, CHART_SCALE);
  drawBarChart(document.getElementById("categoryBar"), entries, CHART_SCALE);
}

function renderCategoryManageList(list) {
  const ul = document.getElementById("categoryManageList");
  ul.textContent = "";
  list.forEach((cat) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = cat;
    const actions = document.createElement("span");
    actions.className = "row-actions";
    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.dataset.action = "rename";
    renameBtn.dataset.cat = cat;
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.dataset.action = "delete";
    delBtn.dataset.cat = cat;
    actions.append(renameBtn, delBtn);
    li.append(span, actions);
    ul.appendChild(li);
  });
  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No categories yet — add one above.";
    ul.appendChild(li);
  }
}

document.getElementById("categoryManageList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const cat = btn.dataset.cat;
  const categories = await getCategories();

  if (btn.dataset.action === "rename") {
    const next = prompt(`Rename "${cat}" to:`, cat);
    const trimmed = next && next.trim();
    if (!trimmed || trimmed === cat) return;
    if (categories.list.includes(trimmed)) {
      alert(`"${trimmed}" already exists.`);
      return;
    }
    categories.list = categories.list.map((c) => (c === cat ? trimmed : c));
    for (const domain of Object.keys(categories.assignments)) {
      if (categories.assignments[domain] === cat) categories.assignments[domain] = trimmed;
    }
    await saveCategories(categories);
    renderCurrentView();
  } else if (btn.dataset.action === "delete") {
    if (!confirm(`Delete category "${cat}"? Sites in it become Uncategorized.`)) return;
    // Assignments pointing at a deleted category are left as-is on disk —
    // categoryFor() only trusts an assignment that's still in `list`, so
    // they fall back to Uncategorized automatically without extra cleanup.
    categories.list = categories.list.filter((c) => c !== cat);
    await saveCategories(categories);
    renderCurrentView();
  }
});

document.getElementById("addCategory").addEventListener("click", async () => {
  const input = document.getElementById("categoryInput");
  const name = input.value.trim();
  if (!name) return;
  const categories = await getCategories();
  if (!categories.list.includes(name)) {
    categories.list.push(name);
    await saveCategories(categories);
  }
  input.value = "";
  renderCurrentView();
});

function renderAssignTable(domains, list, assignments) {
  const tbody = document.getElementById("assignTableBody");
  tbody.textContent = "";
  domains.forEach((domain) => {
    const tr = document.createElement("tr");
    const tdDomain = document.createElement("td");
    tdDomain.textContent = domain;

    const tdCat = document.createElement("td");
    const select = document.createElement("select");
    select.dataset.domain = domain;

    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    const builtin = BUILTIN_DOMAIN_CATEGORIES[domain];
    noneOpt.textContent = builtin && list.includes(builtin) ? `Uncategorized (guess: ${builtin})` : "Uncategorized";
    select.appendChild(noneOpt);

    list.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      select.appendChild(opt);
    });

    select.value = assignments[domain] && list.includes(assignments[domain]) ? assignments[domain] : "";
    tdCat.appendChild(select);
    tr.append(tdDomain, tdCat);
    tbody.appendChild(tr);
  });
  if (domains.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 2;
    td.className = "muted";
    td.textContent = "No sites tracked yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

document.getElementById("assignTableBody").addEventListener("change", async (e) => {
  const select = e.target.closest("select");
  if (!select) return;
  const domain = select.dataset.domain;
  const categories = await getCategories();
  if (select.value) categories.assignments[domain] = select.value;
  else delete categories.assignments[domain];
  await saveCategories(categories);
  renderCurrentView();
});

// ---- settings: exclusion list -------------------------------------------

async function getSettings() {
  const got = await chrome.storage.local.get("settings");
  return got.settings || { excluded: [] };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

async function renderExcludeList() {
  const settings = await getSettings();
  const ul = document.getElementById("excludeList");
  ul.textContent = "";
  settings.excluded.forEach((domain) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = domain;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      const s = await getSettings();
      s.excluded = s.excluded.filter((d) => d !== domain);
      await saveSettings(s);
      renderExcludeList();
      refreshSiteList();
    });
    li.append(span, btn);
    ul.appendChild(li);
  });
}

document.getElementById("addExclude").addEventListener("click", async () => {
  const input = document.getElementById("excludeInput");
  let domain = getDomain(input.value) || input.value.trim().toLowerCase().replace(/^www\./, "");
  if (!domain) return;
  const settings = await getSettings();
  if (!settings.excluded.includes(domain)) {
    settings.excluded.push(domain);
    await saveSettings(settings);
  }
  input.value = "";
  renderExcludeList();
  refreshSiteList();
});

// ---- settings: export / import / clear -----------------------------------

function setMsg(text) {
  document.getElementById("settingsMsg").textContent = text;
}

document.getElementById("exportBtn").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const payload = {};
  for (const [k, v] of Object.entries(all)) {
    if (DAY_KEY_RE.test(k) || k === "meta" || k === "settings" || k === "categories") payload[k] = v;
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `habittracker-export-${localDateStr(Date.now())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setMsg("Exported.");
});

document.getElementById("importInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const toWrite = {};
    let dayCount = 0;

    for (const [k, v] of Object.entries(data)) {
      if (DAY_KEY_RE.test(k) && v && typeof v === "object") {
        toWrite[k] = v;
        dayCount++;
      }
    }
    // merge meta.days
    const existingMeta = await getAllDays();
    const importedDays = (data.meta && data.meta.days) || Object.keys(data).filter((k) => DAY_KEY_RE.test(k)).map((k) => k.slice(2));
    const mergedDays = Array.from(new Set([...existingMeta, ...importedDays])).sort();
    toWrite.meta = { days: mergedDays };

    // merge settings.excluded
    if (data.settings && Array.isArray(data.settings.excluded)) {
      const existingSettings = await getSettings();
      const merged = Array.from(new Set([...existingSettings.excluded, ...data.settings.excluded]));
      toWrite.settings = { excluded: merged };
    }

    // merge categories.list / .assignments
    if (data.categories) {
      const existingCategories = await getCategories();
      const mergedList = Array.from(new Set([...existingCategories.list, ...(data.categories.list || [])]));
      const mergedAssignments = { ...existingCategories.assignments, ...(data.categories.assignments || {}) };
      toWrite.categories = { list: mergedList, assignments: mergedAssignments };
    }

    await chrome.storage.local.set(toWrite);
    setMsg(`Imported ${dayCount} day(s) of data.`);
    renderExcludeList();
    _yearDataCache = {};
    await refreshSiteList();
    if (_currentFrom && _currentTo) await loadRange(_currentFrom, _currentTo);
  } catch (err) {
    setMsg("Import failed: file isn't a valid export.");
  } finally {
    e.target.value = "";
  }
});

document.getElementById("clearBtn").addEventListener("click", async () => {
  if (!confirm("Delete all tracked time data on this device? This can't be undone.")) return;
  // Preserve the excluded-sites list and category setup — "clear data"
  // means wipe tracked time, not silently discard organizational choices.
  const settings = await getSettings();
  const categories = await getCategories();
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ settings, categories });
  await chrome.runtime.sendMessage({ type: "reseed" });
  setMsg("All tracked time data cleared. Your excluded-sites list and categories were kept.");
  renderExcludeList();
  _view = "overview";
  _selectedSite = null;
  _yearDataCache = {};
  applyView();
  await refreshSiteList();
  document.querySelector('[data-range="today"]').click();
});

// ---- init -----------------------------------------------------------------

window.addEventListener("resize", () => _rerender && _rerender());
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  // Only matters when there's no explicit saved choice — updateThemeIcon()
  // and getEffectiveTheme() already fall back to this media query, but
  // without this the sun/moon glyph goes stale when the OS theme flips
  // while the page is open.
  updateThemeIcon();
  _rerender && _rerender();
});

(async function init() {
  applyView();
  renderExcludeList();
  refreshSiteList();
  const allDays = await getAllDays();
  const [from, to] = computeRange("today", allDays);
  document.getElementById("fromDate").value = from;
  document.getElementById("toDate").value = to;
  await loadRange(from, to);
})();
