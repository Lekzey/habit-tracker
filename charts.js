// Hand-rolled canvas charts — no libraries (MV3 CSP blocks remote scripts
// anyway). Colors are read from CSS custom properties at draw time — pixels
// are baked into the bitmap on fill(), so a theme flip or container resize
// after drawing does NOT update the canvas on its own. Callers must re-invoke
// drawPieChart/drawBarChart on "resize" and prefers-color-scheme changes.

function getThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    surface: v("--surface-1"),
    text: v("--text-primary"),
    textSecondary: v("--text-secondary"),
    muted: v("--text-muted"),
    grid: v("--gridline"),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)),
    other: v("--series-other"),
    bg: v("--series-bg"),
  };
}

function font(scale, size = 12) {
  return `${Math.round(size * scale)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

function drawEmpty(ctx, w, h, theme, message, scale = 1) {
  ctx.fillStyle = theme.muted;
  ctx.font = font(scale);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(message || "No data for this range yet", w / 2, h / 2);
  ctx.textAlign = "left";
}

const MAX_SLOTS = 8;

function totalOf(item) {
  return typeof item.value === "number" ? item.value : (item.fg || 0) + (item.bg || 0);
}

/**
 * Sort by total desc and cap at 8 items; anything past that folds into one
 * "Other" bucket (summing every numeric field) rather than generating a 9th
 * hue. Both charts call this so they always describe the same site set.
 */
function capForDisplay(items) {
  const sorted = [...items].sort((a, b) => totalOf(b) - totalOf(a));
  // A caller can pre-mark an entry (e.g. "Uncategorized") isOther: true so it
  // always renders in the muted "other" color even when it lands in the top
  // slots, rather than claiming a categorical hue as if it were a real group.
  const top = sorted.slice(0, MAX_SLOTS).map((it) => ({ ...it, isOther: it.isOther === true }));
  const rest = sorted.slice(MAX_SLOTS);
  if (!rest.length) return top;
  const numericKeys = new Set();
  rest.forEach((it) =>
    Object.keys(it).forEach((k) => {
      if (typeof it[k] === "number") numericKeys.add(k);
    })
  );
  const other = { label: `Other (${rest.length} sites)`, isOther: true };
  numericKeys.forEach((k) => {
    other[k] = rest.reduce((s, it) => s + (it[k] || 0), 0);
  });
  return [...top, other];
}

// ---- Pie chart --------------------------------------------------------

function drawPieChart(canvas, rawItems, scale = 1) {
  const theme = getThemeColors();
  const items = capForDisplay(rawItems);
  const total = items.reduce((s, it) => s + totalOf(it), 0);
  const legendRowH = 30 * scale;

  // Fixed circle budget plus one legend row per item, so the legend never
  // gets clipped whether there are 2 items or the full 8 + "Other".
  const neededHeight = total > 0 ? Math.max(160 * scale, items.length * legendRowH + 16 * scale) : 160 * scale;
  canvas.style.height = neededHeight + "px";

  const ctx = setupCanvas(canvas);
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (total <= 0) return drawEmpty(ctx, w, h, theme, undefined, scale);

  items.forEach((it, i) => {
    it.color = it.isOther ? theme.other : theme.series[i];
  });
  const legendW = Math.min(220 * scale, w * 0.42);
  const plotW = w - legendW;
  const cx = plotW / 2;
  const cy = h / 2;
  const r = Math.max(10 * scale, Math.min(cx, cy) - 14 * scale);

  let angle = -Math.PI / 2;
  const boundaries = [angle];
  for (const item of items) {
    const sweep = (totalOf(item) / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = item.color;
    ctx.fill();
    angle += sweep;
    boundaries.push(angle);
  }
  // 2px surface-color gap between adjacent slices
  ctx.strokeStyle = theme.surface;
  ctx.lineWidth = 2;
  for (const a of boundaries) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }

  drawLegend(ctx, items, plotW + 12 * scale, 8 * scale, legendW - 16 * scale, theme, total, scale);

  canvas._hitAreas = { type: "pie", cx, cy, r, items, total, boundaries: null };
  attachPieHover(canvas);
}

function drawLegend(ctx, items, x, y, maxW, theme, total, scale = 1) {
  const rowH = 30 * scale;
  const swatch = 10 * scale;
  ctx.textBaseline = "alphabetic";
  items.forEach((item, i) => {
    const ry = y + i * rowH;
    ctx.fillStyle = item.color;
    roundRect(ctx, x, ry, swatch, swatch, 2 * scale);
    ctx.fill();
    ctx.fillStyle = theme.text;
    ctx.font = font(scale, 12);
    // Available legend width doesn't grow with scale (it's capped as a
    // fraction of the card), but the glyphs do — shrink the character
    // budget so bigger text doesn't run past the card edge.
    ctx.fillText(truncate(item.label, Math.floor(22 / scale)), x + swatch + 6 * scale, ry + swatch - 1);
    const val = totalOf(item);
    const pct = total ? Math.round((val / total) * 100) : 0;
    ctx.fillStyle = theme.textSecondary;
    ctx.font = font(scale, 11);
    ctx.fillText(`${pct}% · ${formatDuration(val)}`, x + swatch + 6 * scale, ry + swatch + 12 * scale);
  });
}

/** r is either a uniform radius, or {tl,tr,bl,br} per-corner radii. */
function roundRect(ctx, x, y, w, h, r) {
  const { tl, tr, br, bl } = typeof r === "number" ? { tl: r, tr: r, br: r, bl: r } : r;
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

function attachPieHover(canvas) {
  if (canvas._pieHoverBound) return;
  canvas._pieHoverBound = true;
  canvas.addEventListener("mousemove", (e) => {
    const hit = canvas._hitAreas;
    if (!hit || hit.type !== "pie") return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left - hit.cx;
    const my = e.clientY - rect.top - hit.cy;
    const dist = Math.sqrt(mx * mx + my * my);
    if (dist > hit.r) {
      hideTooltip();
      return;
    }
    // Slices are drawn starting at -90° (12 o'clock) and sweeping clockwise.
    // Rotate the pointer angle by the same +90° and wrap into [0, 2π) so it
    // lines up with an accumulator that also starts at 0.
    let a = Math.atan2(my, mx) + Math.PI / 2;
    if (a < 0) a += Math.PI * 2;
    let acc = 0;
    for (const item of hit.items) {
      const val = totalOf(item);
      const sweep = (val / hit.total) * Math.PI * 2;
      if (a >= acc && a < acc + sweep) {
        showTooltip(e.clientX, e.clientY, `${item.label}: ${formatDuration(val)}`);
        return;
      }
      acc += sweep;
    }
    hideTooltip();
  });
  canvas.addEventListener("mouseleave", hideTooltip);
}

// ---- Horizontal stacked bar chart (active vs. background per domain) ---

function drawBarChart(canvas, rawItems, scale = 1) {
  // rawItems: [{label, fg, bg}]
  const theme = getThemeColors();
  const items = capForDisplay(rawItems); // same cap+sort as the pie, so both describe the same site set

  const barH = Math.round(16 * scale);
  const gap = Math.round(14 * scale);
  const topPad = Math.round(8 * scale);
  // Size the canvas to the data — a fixed height would clip rows past
  // whatever count the attribute happened to assume.
  const neededHeight = items.length === 0 ? 80 * scale : topPad * 2 + items.length * (barH + gap) - gap;
  canvas.style.height = neededHeight + "px";

  const ctx = setupCanvas(canvas);
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (items.length === 0) return drawEmpty(ctx, w, h, theme, undefined, scale);

  const labelW = 96 * scale;
  const leftPad = labelW + 8 * scale;
  const rightPad = 66 * scale;
  const chartW = Math.max(20, w - leftPad - rightPad);
  const maxTotal = Math.max(1, ...items.map((i) => i.fg + i.bg));
  const cornerR = Math.round(4 * scale);

  ctx.font = font(scale);
  const rects = [];
  items.forEach((item, i) => {
    const y = topPad + i * (barH + gap);
    ctx.fillStyle = theme.textSecondary;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(truncate(item.label, 15), leftPad - 8 * scale, y + barH / 2);
    ctx.textAlign = "left";

    const fgW = (item.fg / maxTotal) * chartW;
    const bgW = (item.bg / maxTotal) * chartW;
    const gapPx = fgW > 0 && bgW > 0 ? 2 : 0;

    if (fgW > 0) {
      roundRect(ctx, leftPad, y, fgW, barH, bgW > 0 ? { tl: cornerR, bl: cornerR, tr: 0, br: 0 } : cornerR);
      ctx.fillStyle = theme.series[0];
      ctx.fill();
    }
    if (bgW > 0) {
      roundRect(ctx, leftPad + fgW + gapPx, y, bgW, barH, fgW > 0 ? { tr: cornerR, br: cornerR, tl: 0, bl: 0 } : cornerR);
      ctx.fillStyle = theme.bg;
      ctx.fill();
    }

    ctx.fillStyle = theme.text;
    ctx.textBaseline = "middle";
    ctx.fillText(formatDuration(item.fg + item.bg), leftPad + fgW + gapPx + bgW + 8 * scale, y + barH / 2);

    rects.push({ x: leftPad, y, w: fgW + gapPx + bgW, h: barH, item });
  });

  canvas._hitAreas = { type: "bar", rects };
  attachBarHover(canvas);
}

function attachBarHover(canvas) {
  if (canvas._barHoverBound) return;
  canvas._barHoverBound = true;
  canvas.addEventListener("mousemove", (e) => {
    const hit = canvas._hitAreas;
    if (!hit || hit.type !== "bar") return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const found = hit.rects.find((r) => mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h);
    if (found) {
      const { item } = found;
      showTooltip(
        e.clientX,
        e.clientY,
        `${item.label}\nActive: ${formatDuration(item.fg)}\nBackground: ${formatDuration(item.bg)}`
      );
    } else {
      hideTooltip();
    }
  });
  canvas.addEventListener("mouseleave", hideTooltip);
}

// ---- shared floating tooltip -------------------------------------------

let _tooltipEl = null;
function showTooltip(clientX, clientY, text) {
  if (!_tooltipEl) {
    _tooltipEl = document.createElement("div");
    _tooltipEl.className = "qt-tooltip";
    document.body.appendChild(_tooltipEl);
  }
  _tooltipEl.textContent = "";
  text.split("\n").forEach((line, i) => {
    if (i > 0) _tooltipEl.appendChild(document.createElement("br"));
    _tooltipEl.appendChild(document.createTextNode(line));
  });
  _tooltipEl.style.left = clientX + 14 + "px";
  _tooltipEl.style.top = clientY + 14 + "px";
  _tooltipEl.style.display = "block";
}
function hideTooltip() {
  if (_tooltipEl) _tooltipEl.style.display = "none";
}
