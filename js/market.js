import { t } from './i18n.js';

const FONT = "'Museo Sans Rounded', sans-serif";
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
          pan: { enabled: true, mode: 'x', onPanComplete: updateResetBtn },
          zoom: {
            wheel: { enabled: true, speed: 0.08 },
            pinch: { enabled: true },
            mode: 'x',
            onZoomComplete: updateResetBtn,
          },
          limits: { x: { min: 'original', max: 'original' } },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { font: { family: FONT, size: 10, weight: '700' }, color: '#7D7C88', maxTicksLimit: 8, autoSkip: true },
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
  document.getElementById('stat-creature-floor').textContent = fmtPrice(inCurrency(c.floor, c.floorUsd));
  document.getElementById('stat-land-floor').textContent     = fmtPrice(l ? inCurrency(l.floor, l.floorUsd) : null);
  document.getElementById('stat-creature-sales').textContent = (c.sales30d ?? 0).toLocaleString();
  document.getElementById('stat-land-sales').textContent     = l && l.sales30d != null ? l.sales30d.toLocaleString() : '—';
}

function render() {
  if (!lastData) return;
  fxRates = lastData.fxRates || { usd: 1 };
  updateCurrencyOptions();
  renderStats();
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
    updateResetBtn();
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

    const d = new Date(data.lastFetched);
    const dateStr = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    document.getElementById('market-updated').innerHTML =
      `Data as of ${dateStr}${data.stale ? ` <span class="stale-badge">${t('stale.badge')}</span>` : ''}`;

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
