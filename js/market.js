import { t } from './i18n.js';

const FONT = "'Museo Sans Rounded', sans-serif";
const RANGE_DAYS = { '1m': 30, '3m': 90, '6m': 180, '1y': 365, 'all': Infinity };

let lastData = null;
let currency = 'usd';   // 'usd' | 'eth' — default USD per request
let range    = 'all';   // key of RANGE_DAYS
let chart    = null;
let wired    = false;

function fmtPrice(v) {
  if (v == null) return '—';
  return currency === 'usd' ? `$${Math.round(v).toLocaleString()}` : `${Number(v).toFixed(3)} ETH`;
}

function fmtAxis(v) {
  return currency === 'usd' ? `$${Math.round(v).toLocaleString()}` : `${v} Ξ`;
}

function fmtWeek(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const pickLow = p => (currency === 'usd' ? p.usdLow : p.ethLow);

// Trim a weekly series to the active range. Both series share one timeline,
// so filtering each by date keeps them aligned.
function sliceRange(history) {
  const days = RANGE_DAYS[range];
  if (!history.length || days === Infinity) return history;
  const last = new Date(history[history.length - 1].date).getTime();
  const cutoff = last - days * 86400000;
  return history.filter(p => new Date(p.date).getTime() >= cutoff);
}

function lineDataset(label, history, color, fillBg) {
  return {
    label,
    data: history.map(pickLow),
    borderColor: color,
    backgroundColor: fillBg,
    borderWidth: 2.5,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHoverBackgroundColor: color,
    tension: 0.3,
    fill: !!fillBg,
    spanGaps: true,
  };
}

function renderChart() {
  if (!lastData) return;
  const c = lastData.creatures || {};
  const l = lastData.land || null;
  const cHist = sliceRange((c.history || []).filter(Boolean));
  const lHist = sliceRange(((l && l.history) || []).filter(Boolean));

  const base = cHist.length ? cHist : lHist;
  const labels = base.map(p => fmtWeek(p.date));

  const datasets = [];
  if (cHist.length) datasets.push(lineDataset(t('market.chart.creatures'), cHist, '#51FFA5', 'rgba(81,255,165,0.10)'));
  if (lHist.length) datasets.push(lineDataset(t('market.chart.land'), lHist, '#FFF95F', null));

  if (chart) chart.destroy();
  const usd = currency === 'usd';
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
              const v = ctx.parsed.y;
              return `  ${ctx.dataset.label}: ${usd ? '$' + Math.round(v).toLocaleString() : v.toFixed(3) + ' ETH'}`;
            },
          },
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
          ticks: { font: { family: FONT, size: 10, weight: '700' }, color: '#7D7C88', maxTicksLimit: 6, callback: fmtAxis },
        },
      },
    },
  });
}

function renderStats() {
  const c = lastData.creatures || {};
  const l = lastData.land || null;
  document.getElementById('stat-creature-floor').textContent = fmtPrice(currency === 'usd' ? c.floorUsd : c.floor);
  document.getElementById('stat-land-floor').textContent     = fmtPrice(l ? (currency === 'usd' ? l.floorUsd : l.floor) : null);
  document.getElementById('stat-creature-sales').textContent = (c.sales30d ?? 0).toLocaleString();
  document.getElementById('stat-land-sales').textContent     = l && l.sales30d != null ? l.sales30d.toLocaleString() : '—';
}

function render() {
  if (!lastData) return;
  renderStats();
  const cHist = ((lastData.creatures || {}).history || []).filter(Boolean);
  const lHist = (((lastData.land || {}).history) || []).filter(Boolean);
  const hasChart = cHist.length > 0 || lHist.length > 0;
  document.getElementById('market-chart-card').hidden = !hasChart;
  document.getElementById('market-land-note').hidden = lHist.length > 0;
  if (hasChart) renderChart();
}

function setActive(groupSel, btn) {
  document.querySelectorAll(`${groupSel} button`).forEach(b => b.classList.toggle('is-active', b === btn));
}

function wireControls() {
  if (wired) return;
  wired = true;
  document.querySelectorAll('#market-currency [data-cur]').forEach(btn =>
    btn.addEventListener('click', () => { currency = btn.dataset.cur; setActive('#market-currency', btn); render(); }));
  document.querySelectorAll('#market-range [data-range]').forEach(btn =>
    btn.addEventListener('click', () => { range = btn.dataset.range; setActive('#market-range', btn); renderChart(); }));
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
