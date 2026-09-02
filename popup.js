async function main() {
  const today = localDateStr(Date.now());
  const got = await chrome.storage.local.get(dayKey(today));
  const day = got[dayKey(today)] || {};

  const items = Object.entries(day).map(([label, v]) => ({ label, fg: v.fg, bg: v.bg }));
  const totalFg = Object.values(day).reduce((s, v) => s + v.fg, 0);
  const totalBg = Object.values(day).reduce((s, v) => s + v.bg, 0);

  document.getElementById("totals").textContent =
    items.length === 0 ? "" : `active ${formatDuration(totalFg)} · bg ${formatDuration(totalBg)}`;

  const canvas = document.getElementById("pie");
  const empty = document.getElementById("empty");
  if (items.length === 0) {
    canvas.hidden = true;
    empty.hidden = false;
  } else {
    canvas.hidden = false;
    empty.hidden = true;
    // Canvas colors are baked in at draw time — redraw on a live theme flip.
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => drawPieChart(canvas, items));
    drawPieChart(canvas, items);
  }

  document.getElementById("openDashboard").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });
}

main();
