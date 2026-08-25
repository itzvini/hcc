import { t, getCurrentLang } from './i18n.js';

const FONT = "'Museo Sans Rounded', sans-serif";

// Same helper as holders.js — translated strings go into innerHTML below.
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Phone-width chart tuning. Matches the mobile layout breakpoint in styles.css —
// change one and change the other. Read at chart-build time, so a rotate or a resize
// picks up the new value on the next render().
const isNarrow = () => window.matchMedia('(max-width: 1150px)').matches;
const RANGE_DAYS = { '1m': 30, '3m': 90, '6m': 180, '1y': 365, 'all': Infinity };
const DAY = 86400000;
const SUM_METRICS = new Set(['count', 'volume']); // totalled per interval, not averaged

let lastData = null;
let currency = 'usd';      // 'eth' or any fiat code in fxRates ('usd','eur',… )
let metric   = 'low';      // 'low' | 'high' | 'floor' — which series to plot
let interval = 'daily';    // 'daily' | 'weekly' | 'biweekly' | 'monthly' — bucket size, averaged
let range    = 'all';      // key of RANGE_DAYS, or 'custom' when a From/To window is set
let customFrom = null;     // 'YYYY-MM-DD' lower bound when range === 'custom'
let customTo   = null;     // 'YYYY-MM-DD' upper bound when range === 'custom'
let fxRates  = { usd: 1 }; // USD-relative display rates from the API
let chart    = null;
let wired    = false;

// The series currently plotted, kept in module scope so the "total for the
// period in view" readout can re-sum them on zoom/pan without re-bucketing.
let plotDates = [];
let plotC = [];
let plotL = [];

// Format a number in the active currency. ETH is native; fiats use the locale's
// own currency formatting (symbol, grouping) via Intl.
function fmtMoney(v) {
  if (currency === 'eth') return `${Number(v).toFixed(3)} ETH`;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${Math.round(v).toLocaleString()} ${currency.toUpperCase()}`;
  }
}

function fmtPrice(v) { return v == null ? '—' : fmtMoney(v); }

// Format a chart value for the active metric: the sales count is a plain integer;
// every other metric (price/volume) is money in the active currency.
function fmtMetric(v) { return metric === 'count' ? Math.round(v).toLocaleString() : fmtMoney(v); }
function fmtAxis(v)  {
  if (metric === 'count') return Math.round(v).toLocaleString();
  return currency === 'eth' ? `${v} Ξ` : fmtMoney(v);
}

function fmtDate(iso) {
  // Parse as a LOCAL calendar date, not UTC. `new Date('2026-06-06')` is UTC
  // midnight, which renders a day earlier in timezones behind UTC (e.g. Brazil),
  // shifting every label back one day. Buckets are UTC days, so show them verbatim.
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Convert an (ETH, USD) pair into the active currency. ETH is native; USD is
// stored; other fiats scale the USD value by the latest USD→currency rate.
function inCurrency(eth, usd) {
  if (currency === 'eth') return eth;
  if (currency === 'usd') return usd;
  const rate = fxRates[currency];
  return usd != null && rate != null ? usd * rate : null;
}

// The value to plot for a daily point, given the active metric + currency.
// 'count' is unitless; 'volume' and the price metrics resolve to the active currency.
function pickValue(p) {
  if (metric === 'count') return p.count;
  if (metric === 'volume') return inCurrency(p.volEth, p.volUsd);
  const eth = metric === 'high' ? p.highEth : metric === 'low' ? p.lowEth : p.floorEth;
  const usd = metric === 'high' ? p.highUsd : metric === 'low' ? p.lowUsd : p.floorUsd;
  return inCurrency(eth, usd);
}

// Which bucket a date falls in. Weekly / bi-weekly are fixed windows anchored to
// the epoch so both collections share boundaries; monthly is the calendar month.
function bucketKey(date) {
  if (interval === 'daily') return date;
  if (interval === 'monthly') return date.slice(0, 7); // 'YYYY-MM'
  const dayIdx = Math.floor(new Date(date).getTime() / DAY);
  return String(Math.floor(dayIdx / (interval === 'weekly' ? 7 : 14)));
}
function bucketStart(key) {
  if (interval === 'daily') return key;
  if (interval === 'monthly') return `${key}-01`;
  const dayIdx = Number(key) * (interval === 'weekly' ? 7 : 14);
  return new Date(dayIdx * DAY).toISOString().slice(0, 10);
}

// Aggregate the active metric over each interval → Map(bucketStartDate -> value).
// Count and volume are summed (totals); prices and floor are averaged. Days with
// no value for the metric are skipped, so the result reflects real data only.
function bucketSeries(daily) {
  const total = SUM_METRICS.has(metric);
  const acc = new Map();
  for (const p of daily) {
    const v = pickValue(p);
    if (v == null) continue;
    const k = bucketKey(p.date);
    const a = acc.get(k) || { sum: 0, n: 0 };
    a.sum += v; a.n++;
    acc.set(k, a);
  }
  const out = new Map();
  for (const [k, a] of acc) out.set(bucketStart(k), total ? a.sum : a.sum / a.n);
  return out;
}

// Trim a sorted list of bucket dates to the active range. 'custom' clips to the
// explicit [From, To] window; the presets clip to the last N days.
function sliceRange(dates) {
  if (!dates.length) return dates;
  if (range === 'custom') {
    const from = customFrom ? new Date(customFrom).getTime() : -Infinity;
    const to   = customTo ? new Date(customTo).getTime() + DAY : Infinity; // include the whole 'To' day
    return dates.filter(d => { const t = new Date(d).getTime(); return t >= from && t < to; });
  }
  const days = RANGE_DAYS[range];
  if (days === Infinity) return dates;
  const last = new Date(dates[dates.length - 1]).getTime();
  const cutoff = last - days * DAY;
  return dates.filter(d => new Date(d).getTime() >= cutoff);
}

function lineDataset(label, data, color, fillBg, showPoints) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: fillBg,
    borderWidth: 2.5,
    pointRadius: showPoints ? 2.5 : 0, // dots help when the series is just a few days old
    pointHoverRadius: 5,
    pointHoverBackgroundColor: color,
    tension: 0.3,
    fill: !!fillBg,
    spanGaps: true,
  };
}

function renderChart() {
  if (!lastData) return;
  // Bucket+average each collection independently (shared boundaries keep them
  // aligned), then plot both on the union of bucket dates within the range.
  const cBuckets = bucketSeries(((lastData.creatures || {}).history || []).filter(Boolean));
  const lBuckets = bucketSeries((((lastData.land || {}).history) || []).filter(Boolean));

  const dates = sliceRange([...new Set([...cBuckets.keys(), ...lBuckets.keys()])].sort());
  const labels = dates.map(fmtDate);
  const showPoints = dates.length > 0 && dates.length <= 60;
  const cData = dates.map(d => (cBuckets.has(d) ? cBuckets.get(d) : null));
  const lData = dates.map(d => (lBuckets.has(d) ? lBuckets.get(d) : null));
  plotDates = dates; plotC = cData; plotL = lData;

  const datasets = [];
  if (cData.some(v => v != null)) datasets.push(lineDataset(t('market.chart.creatures'), cData, '#51FFA5', 'rgba(81,255,165,0.10)', showPoints));
  if (lData.some(v => v != null)) datasets.push(lineDataset(t('market.chart.land'), lData, '#FFF95F', null, showPoints));

  if (chart) chart.destroy();
  chart = new Chart(document.getElementById('market-price-chart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            font: { family: FONT, size: 11, weight: '700' },
            color: '#CCCADC',
            padding: 18,
            usePointStyle: true,
            pointStyleWidth: 14,
          },
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              if (ctx.parsed.y == null) return null;
              return `  ${ctx.dataset.label}: ${fmtMetric(ctx.parsed.y)}`;
            },
          },
        },
        // Scroll / pinch to zoom and drag to pan along the timeline. Options are
        // inert unless chartjs-plugin-zoom registered (it self-registers via its
        // CDN UMD build), so this degrades cleanly if the plugin fails to load.
        zoom: {
          pan: { enabled: true, mode: 'x', onPanComplete: onViewChange },
          zoom: {
            wheel: { enabled: true, speed: 0.08 },
            pinch: { enabled: true },
            mode: 'x',
            onZoomComplete: onViewChange,
          },
          limits: { x: { min: 'original', max: 'original' } },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          // Eight date labels do not fit across a phone, so Chart.js tilted them to ~50°
          // and they came out as an unreadable cascade — worse in the languages that spell
          // the month out ("19 de ago."). Four flat labels beat eight tilted ones; the
          // tooltip carries the exact date for any point anyway.
          ticks: {
            font: { family: FONT, size: isNarrow() ? 10.5 : 10, weight: '700' },
            color: '#7D7C88',
            maxTicksLimit: isNarrow() ? 4 : 8,
            autoSkip: true,
            maxRotation: isNarrow() ? 0 : 50,
            autoSkipPadding: isNarrow() ? 12 : 3,
          },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.08)' },
          border: { display: false },
          ticks: { font: { family: FONT, size: 10, weight: '700' }, color: '#7D7C88', maxTicksLimit: 6, precision: metric === 'count' ? 0 : undefined, callback: fmtAxis },
        },
      },
    },
  });
  updateResetBtn(); // a fresh chart starts unzoomed — keep the reset button in sync
  renderTotal();
}

// Zoom/pan changed the visible window — keep the reset pill and the "period in
// view" total both in sync with what's actually on screen.
function onViewChange() {
  updateResetBtn();
  renderTotal();
}

// Indices of the buckets currently visible on the x-axis. Chart.js reports the
// category scale's min/max as (possibly fractional) data indices; when unzoomed
// they span the whole series. Round inward so a bucket counts once its label is
// on screen. Returns null when there's nothing plotted.
function visibleRange() {
  const n = plotDates.length;
  if (!n) return null;
  const xs = chart && chart.scales && chart.scales.x;
  let lo = 0, hi = n - 1;
  if (xs && isFinite(xs.min) && isFinite(xs.max)) {
    lo = Math.max(0, Math.round(xs.min));
    hi = Math.min(n - 1, Math.round(xs.max));
  }
  return lo > hi ? null : { lo, hi };
}

// Sum a plotted series across the visible index window, skipping empty buckets.
// Returns null when no bucket in the window carries a value for that series.
function sumVisible(series, lo, hi) {
  let sum = 0, seen = false;
  for (let i = lo; i <= hi; i++) {
    const v = series[i];
    if (v == null) continue;
    sum += v; seen = true;
  }
  return seen ? sum : null;
}

// The "total for the period in view" readout. Only meaningful for the summable
// metrics (volume, sales count) — for average metrics (floor/low/high) a total
// is nonsense, so the strip is hidden. Recomputed on every view change.
function renderTotal() {
  const el = document.getElementById('market-total');
  if (!el) return;
  const rng = SUM_METRICS.has(metric) ? visibleRange() : null;
  if (!rng) { el.hidden = true; el.innerHTML = ''; return; }

  const { lo, hi } = rng;
  const cTot = sumVisible(plotC, lo, hi);
  const lTot = sumVisible(plotL, lo, hi);
  if (cTot == null && lTot == null) { el.hidden = true; el.innerHTML = ''; return; }

  const label = metric === 'count' ? t('market.total.sales') : t('market.total.volume');
  const span  = `${fmtDate(plotDates[lo])} – ${fmtDate(plotDates[hi])}`;
  const chip = (name, color, total) => total == null ? '' :
    `<span class="market-total-chip"><span class="dot" style="background:${color};color:${color}"></span>` +
    `<span class="ttl-name">${name}</span><span class="ttl-val">${fmtMetric(total)}</span></span>`;

  el.innerHTML =
    `<span class="market-total-label">${label} <span class="market-total-span">· ${span}</span></span>` +
    `<span class="market-total-chips">${chip(t('market.chart.creatures'), '#51FFA5', cTot)}` +
    `${chip(t('market.chart.land'), '#FFF95F', lTot)}</span>`;
  el.hidden = false;
}

// Show the "Reset zoom" pill only while the view is zoomed/panned away from the
// full series. getZoomLevel is absent if the zoom plugin didn't load.
function updateResetBtn() {
  const btn = document.getElementById('market-reset-zoom');
  if (!btn) return;
  const zoomed = !!(chart && chart.getZoomLevel && chart.getZoomLevel() > 1.0001);
  btn.hidden = !zoomed;
}

// Bound the From/To pickers to the available data so users can't pick empty dates.
function setDateBounds() {
  const fromEl = document.getElementById('market-from');
  const toEl   = document.getElementById('market-to');
  if (!fromEl || !toEl || !lastData) return;
  const dates = [];
  for (const k of ['creatures', 'land']) {
    const h = ((lastData[k] || {}).history) || [];
    if (h.length) dates.push(h[0].date, h[h.length - 1].date);
  }
  if (!dates.length) return;
  dates.sort();
  fromEl.min = toEl.min = dates[0];
  fromEl.max = toEl.max = dates[dates.length - 1];
}

// Enable only the currency options we have a rate for (ETH + USD always work);
// if the active currency lost its rate, fall back to USD.
function updateCurrencyOptions() {
  const sel = document.getElementById('market-currency');
  if (!sel) return;
  for (const opt of sel.options) {
    const v = opt.value;
    opt.disabled = !(v === 'eth' || v === 'usd' || fxRates[v] != null);
  }
  if (sel.options[sel.selectedIndex]?.disabled) { currency = 'usd'; }
  sel.value = currency;
}

function renderStats() {
  const c = lastData.creatures || {};
  const l = lastData.land || null;
  const lang = getCurrentLang();
  document.getElementById('stat-creature-floor').textContent = fmtPrice(inCurrency(c.floor, c.floorUsd));
  document.getElementById('stat-land-floor').textContent     = fmtPrice(l ? inCurrency(l.floor, l.floorUsd) : null);
  // Grouping separators follow the language the reader chose, not their browser's —
  // otherwise an English page on a Brazilian phone prints "5.360" for 5,360.
  document.getElementById('stat-creature-sales').textContent = (c.sales30d ?? 0).toLocaleString(lang);
  document.getElementById('stat-land-sales').textContent     = l && l.sales30d != null ? l.sales30d.toLocaleString(lang) : '—';
}

// "Data as of <date>", the same line and the same key the Holders sub-tab uses.
// This has to run from render(), not once from the fetch: a deep link to /market
// starts the fetch before initI18n() resolves, and a t() call that early gets the
// raw key back. render() is what a language switch re-runs, so the line is built
// with whatever dictionary is loaded now and rebuilt when a new one arrives.
function renderUpdated() {
  const el = document.getElementById('market-updated');
  if (!el || !lastData) return;
  const d = new Date(lastData.lastFetched);
  const dateStr = d.toLocaleString(getCurrentLang(), { dateStyle: 'medium', timeStyle: 'short' });
  el.innerHTML = `${esc(t('holders.asOf').replace('{date}', dateStr))}` +
    `${lastData.stale ? ` <span class="stale-badge">${esc(t('stale.badge'))}</span>` : ''}`;
}

function render() {
  if (!lastData) return;
  fxRates = lastData.fxRates || { usd: 1 };
  updateCurrencyOptions();
  renderStats();
  renderUpdated();
  const cHist = ((lastData.creatures || {}).history || []).filter(Boolean);
  const lHist = (((lastData.land || {}).history) || []).filter(Boolean);
  const hasChart = cHist.length > 0 || lHist.length > 0;
  document.getElementById('market-chart-card').hidden = !hasChart;
  document.getElementById('market-land-note').hidden = lHist.length > 0;
  if (hasChart) { setDateBounds(); renderChart(); }
}

function setActive(groupSel, btn) {
  document.querySelectorAll(`${groupSel} button`).forEach(b => b.classList.toggle('is-active', b === btn));
}

function wireControls() {
  if (wired) return;
  wired = true;
  const fromEl = document.getElementById('market-from');
  const toEl   = document.getElementById('market-to');
  const datesGroup = document.getElementById('market-dates');

  const curEl = document.getElementById('market-currency');
  curEl?.addEventListener('change', () => { currency = curEl.value; render(); });

  document.querySelectorAll('#market-metric [data-metric]').forEach(btn =>
    btn.addEventListener('click', () => { metric = btn.dataset.metric; setActive('#market-metric', btn); renderChart(); }));

  document.querySelectorAll('#market-interval [data-interval]').forEach(btn =>
    btn.addEventListener('click', () => { interval = btn.dataset.interval; setActive('#market-interval', btn); renderChart(); }));

  // Presets clear any custom window and reset the From/To pickers.
  document.querySelectorAll('#market-range [data-range]').forEach(btn =>
    btn.addEventListener('click', () => {
      range = btn.dataset.range;
      customFrom = customTo = null;
      if (fromEl) fromEl.value = '';
      if (toEl) toEl.value = '';
      datesGroup?.classList.remove('is-active');
      setActive('#market-range', btn);
      renderChart();
    }));

  // Setting either date switches to the custom window and deactivates the presets.
  const applyCustom = () => {
    customFrom = fromEl?.value || null;
    customTo   = toEl?.value || null;
    if (customFrom || customTo) {
      range = 'custom';
      document.querySelectorAll('#market-range button').forEach(b => b.classList.remove('is-active'));
      datesGroup?.classList.add('is-active');
    }
    renderChart();
  };
  fromEl?.addEventListener('change', applyCustom);
  toEl?.addEventListener('change', applyCustom);

  document.getElementById('market-reset-zoom')?.addEventListener('click', () => {
    chart?.resetZoom?.();
    onViewChange();
  });
}

// Re-render after a language change so the legend picks up the new locale.
export function rerenderMarket() {
  if (lastData) render();
}

export async function loadMarketChart() {
  const loadingEl = document.getElementById('market-loading');
  const errorEl   = document.getElementById('market-error');
  const errorMsg  = document.getElementById('market-error-msg');
  const contentEl = document.getElementById('market-content');

  try {
    const res = await fetch('/api/market');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    lastData = data;

    loadingEl.hidden = true;
    contentEl.hidden = false;
    wireControls();
    render();
  } catch (err) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorMsg.textContent = err.message || t('market.error');
  }
}
