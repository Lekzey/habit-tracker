# HabitTracker

A local-only time tracker for Brave. Tracks how long you spend on each site —
split into **active** (tab focused, window focused) and **background** (tab
open somewhere but not the one you're looking at) — and shows it as a pie
chart, a bar chart, and a table. Nothing ever leaves your device: no network
requests, no analytics, no accounts.

## Install (unpacked, since this isn't on the Chrome/Brave store)

1. Open `brave://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the "HabitTracker" icon to the toolbar if you want quick access.

Reload the extension from `brave://extensions` after editing any file.

## What it tracks

- Only the **domain** (e.g. `github.com`), never the full URL, path, or query
  string.
- Only in normal windows — Private windows are skipped (and Brave doesn't
  load unpacked extensions into Private windows by default anyway).
- Time keeps accumulating for background tabs even while you're not looking
  at them; it pauses entirely while your system is idle or locked, so
  stepping away doesn't inflate any site's numbers.

Because the install prompt for the `tabs` permission says "Read your browsing
history" — that's just what lets the extension see which domain each open
tab is on; the data still never leaves `chrome.storage.local` on your
machine.

## Excluding sites

Dashboard → Settings → **Excluded sites**. An excluded domain is never
written to storage at all — not the time, not even the domain name.

## Backing up your data

Dashboard → Settings → **Export as JSON** / **Import JSON**. Data is kept
indefinitely (aggregated per day, so even years of history stays small) —
export is just an extra safety net, e.g. before reinstalling Brave.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker — does all the time accounting |
| `common.js` | Shared helpers (domain parsing, date/duration formatting) |
| `charts.js` | Hand-rolled canvas pie + bar chart renderers |
| `popup.html/js/css` | Toolbar popup — today's summary |
| `dashboard.html/js/css` | Full dashboard — charts, table, settings |
| `theme.css` | Shared color tokens (light/dark via `prefers-color-scheme`) |
