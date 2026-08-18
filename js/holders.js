import { t, getCurrentLang } from './i18n.js';

// The three distribution tiles. `dist` and `total` name the fields on /api/holders;
// `total` is the denominator every share on that tile is measured against.
const TILES = [
  { key: 'creatures', dist: 'creatureDistribution', total: 'totalCreatureHolders' },
  { key: 'land',      dist: 'landDistribution',     total: 'totalLandHolders' },
  { key: 'combined',  dist: 'combinedDistribution', total: 'totalUniqueHolders' },
];

let lastData = null;
let doughnut = null;

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function getProgressMessage(p) {
  if (p.phase === 'computing') return t('progress.computing');
  if (p.phase === 'fetching') {
    const c = p.creaturePages, l = p.landPages;
    if (c > 0 && l > 0) return t('progress.both').replace('{c}', c).replace('{l}', l);
    if (c > 0) return t('progress.creatures').replace('{n}', c);
    if (l > 0) return t('progress.land').replace('{n}', l);
    return t('progress.connecting');
  }
  return t('holders.loading');
}

// One tile's rails. The rail length is the bucket's true share of the collection's
// wallets — no floor, no log scale — and the exact count and share are printed on
// every row, which is what makes a two-pixel tail honest instead of invisible.
function renderRails(data) {
  const lang = getCurrentLang();
  const num = new Intl.NumberFormat(lang);
  // Decimals scale with how small the share is, so a bucket with one wallet in six
  // thousand reads "0.02%" rather than a flat "0%" that looks like an empty bucket.
  const pctText = share => new Intl.NumberFormat(lang, {
    style: 'percent',
    maximumFractionDigits: share === 0 || share >= 0.1 ? 0 : share >= 0.001 ? 1 : 2,
  }).format(share);

  for (const tile of TILES) {
    const body = document.getElementById(`dist-rows-${tile.key}`);
    const denEl = document.getElementById(`dist-den-${tile.key}`);
    if (!body) continue;

    const buckets = Array.isArray(data[tile.dist]) ? data[tile.dist] : [];
    const bucketSum = buckets.reduce((a, b) => a + b.count, 0);
    const denom = data[tile.total] || bucketSum;
    // Shares are only true if the buckets add up to the headline holder count. If the
    // server's two numbers ever drift apart, say so here rather than quietly rescaling.
    if (denom !== bucketSum) {
      console.warn(`[holders] ${tile.key}: buckets sum to ${bucketSum} but ${tile.total} is ${denom}`);
    }

    if (denEl) denEl.textContent = t('holders.dist.den').replace('{n}', num.format(denom));

    body.innerHTML = buckets.map((b, i) => {
      const share = denom ? b.count / denom : 0;
      return `<tr class="dist-row${b.count ? '' : ' is-zero'}" style="--i:${i}">` +
        `<th scope="row" class="dist-key">${esc(b.label)}</th>` +
        `<td class="dist-track-cell"><span class="dist-track">` +
          `<i style="--w:${(share * 100).toFixed(2)}%"></i></span></td>` +
        `<td class="dist-val"><span class="dist-n">${num.format(b.count)}</span>` +
          `<span class="dist-pct">${pctText(share)}</span></td>` +
      `</tr>`;
    }).join('');
  }
}

function renderDoughnut(data) {
  // Rebuilt on every language switch, so the old instance has to go first — Chart.js 4
  // throws "Canvas is already in use" otherwise.
  if (doughnut) doughnut.destroy();
  doughnut = new Chart(document.getElementById('holders-chart'), {
    type: 'doughnut',
    data: {
      labels: [t('chart.creaturesOnly'), t('chart.landOnly'), t('chart.both')],
      datasets: [{
        data: [data.creaturesOnly, data.landOnly, data.both],
        backgroundColor: ['#51FFA5', '#FFF95F', '#8561FF'],
        borderColor: '#141317',
        borderWidth: 3,
        hoverOffset: 10,
      }],
    },
    options: {
      animation: { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700 },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            font: { family: "'Museo Sans Rounded', sans-serif", size: 11, weight: '700' },
            color: '#CCCADC',
            padding: 22,
            usePointStyle: true,
            pointStyleWidth: 14,
          },
        },
        tooltip: {
          backgroundColor: 'rgba(20,19,23,0.95)',
          borderColor: 'rgba(255,255,255,0.14)',
          borderWidth: 1,
          cornerRadius: 12,
          padding: 10,
          titleFont: { family: "'Museo Sans Rounded', sans-serif", size: 12, weight: '800' },
          bodyFont: { family: "'Museo Sans Rounded', sans-serif", size: 12, weight: '700' },
          callbacks: {
            label(ctx) {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = ((ctx.parsed / total) * 100).toFixed(1);
              return `  ${ctx.parsed.toLocaleString(getCurrentLang())} ${t('chart.wallets')} (${pct}%)`;
            },
          },
        },
      },
      cutout: '58%',
      radius: '88%',
    },
  });
}

function renderHolders(data) {
  const lang = getCurrentLang();
  document.getElementById('stat-creature-holders').textContent = data.totalCreatureHolders.toLocaleString(lang);
  document.getElementById('stat-land-holders').textContent = data.totalLandHolders.toLocaleString(lang);
  document.getElementById('stat-total-holders').textContent = data.totalUniqueHolders.toLocaleString(lang);

  const d = new Date(data.lastFetched);
  const dateStr = d.toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
  const updatedEl = document.getElementById('holders-updated');
  updatedEl.innerHTML = `${esc(t('holders.asOf').replace('{date}', dateStr))}` +
    `${data.stale ? ` <span class="stale-badge">${esc(t('stale.badge'))}</span>` : ''}`;

  renderDoughnut(data);
  renderRails(data);
}

export function rerenderHolders() {
  if (lastData) renderHolders(lastData);
}

export async function loadHoldersChart() {
  const loadingEl   = document.getElementById('holders-loading');
  const loadingMsg  = document.getElementById('holders-loading-msg');
  const errorEl     = document.getElementById('holders-error');
  const errorMsg    = document.getElementById('holders-error-msg');
  const chartWrapEl = document.getElementById('holders-chart-wrap');

  const poll = setInterval(async () => {
    try {
      const r = await fetch('/api/holders/progress');
      const p = await r.json();
      loadingMsg.textContent = getProgressMessage(p);
    } catch {}
  }, 600);

  try {
    const res = await fetch('/api/holders');
    clearInterval(poll);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    loadingEl.hidden = true;
    chartWrapEl.hidden = false;

    lastData = data;
    renderHolders(data);

  } catch (err) {
    clearInterval(poll);
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorMsg.textContent = err.message || t('holders.error');
  }
}
