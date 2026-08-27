import { t, getCurrentLang } from './i18n.js';

// The three distribution tiles. `dist` and `total` name the fields on /api/holders;
// `total` is the denominator every share on that tile is measured against.
const TILES = [
  { key: 'creatures', dist: 'creatureDistribution', total: 'totalCreatureHolders' },
  { key: 'land',      dist: 'landDistribution',     total: 'totalLandHolders' },
  { key: 'combined',  dist: 'combinedDistribution', total: 'totalUniqueHolders' },
];

let lastData = null;
let lastQuality = null;
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

// Number and percent formatters for the current language, built once per render.
//
// `pct` decimals scale with how small the share is, so a bucket with one wallet in six
// thousand reads "0.02%" rather than a flat "0%" that looks like an empty bucket. `pctFine`
// keeps a decimal much further up the range: 76 Legendaries in 11,111 Creatures is 0.68%,
// and 571 Premium plots in 3,135 is 18.2% — rounding either to a whole number throws away
// the part that makes them worth printing.
function formatters() {
  const lang = getCurrentLang();
  const nf = new Intl.NumberFormat(lang);
  const percent = digits => share => new Intl.NumberFormat(lang, {
    style: 'percent', maximumFractionDigits: digits,
  }).format(share);
  const df = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
  return {
    num: n => nf.format(n),
    // Averages and medians arrive rounded to four places, which prints as "2.077". Two is
    // all anyone reads off a "creatures per wallet" figure.
    dec: n => df.format(n),
    pct: share => percent(share === 0 || share >= 0.1 ? 0 : share >= 0.001 ? 1 : 2)(share),
    pctFine: share => percent(share === 0 || share >= 0.5 ? 0 : share >= 0.01 ? 1 : 2)(share),
  };
}

// One tile's rails. The rail length is the bucket's true share of the collection's
// wallets — no floor, no log scale — and the exact count and share are printed on
// every row, which is what makes a two-pixel tail honest instead of invisible.
function renderRails(data) {
  const { num, pct: pctText } = formatters();

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

    if (denEl) denEl.textContent = t('holders.dist.den').replace('{n}', num(denom));

    body.innerHTML = buckets.map((b, i) => {
      const share = denom ? b.count / denom : 0;
      return `<tr class="dist-row${b.count ? '' : ' is-zero'}" style="--i:${i}">` +
        `<th scope="row" class="dist-key">${esc(b.label)}</th>` +
        `<td class="dist-track-cell"><span class="dist-track">` +
          `<i style="--w:${(share * 100).toFixed(2)}%"></i></span></td>` +
        `<td class="dist-val"><span class="dist-n">${num(b.count)}</span>` +
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

// --- Rarity & tiers -------------------------------------------------------------
// Two cards, one per collection, each built from /api/holders/quality: the tier split
// across the whole supply, then a close-up on who holds the rare tier. The tier names
// (Legendary, Epic, Premium) come straight off the tokens' own metadata and stay in
// English like every other trait value on the site; only the surrounding copy is keyed.
const QUAL = [
  { key: 'creatures', field: 'creatures', hl: 'holders.rare.hl.creatures' },
  { key: 'land',      field: 'land',      hl: 'holders.rare.hl.land' },
];

// A tier's display name. Untraited is ours, not the metadata's, so it gets a key; the
// real rarity words are left exactly as the chain spells them.
const tierLabel = key => (key === 'Untraited' ? t('holders.rare.tier.untraited') : key);

// The shared rail row: label, a fill drawn to its true share, and the exact numbers.
function railRow(label, count, share, i, fmt) {
  return `<tr class="dist-row${count ? '' : ' is-zero'}" style="--i:${i}">` +
    `<th scope="row" class="dist-key">${esc(label)}</th>` +
    `<td class="dist-track-cell"><span class="dist-track">` +
      `<i style="--w:${(share * 100).toFixed(2)}%"></i></span></td>` +
    `<td class="dist-val"><span class="dist-n">${fmt.num(count)}</span>` +
      `<span class="dist-pct">${fmt.pctFine(share)}</span></td>` +
  `</tr>`;
}

function renderRare(q) {
  const wrap = document.getElementById('holders-rare');
  if (!wrap) return;
  // Nothing to draw is not the same as an empty collection: leave the section out.
  if (!q || !q.ready || !(q.creatures || q.land)) { wrap.hidden = true; return; }

  const fmt = formatters();
  let shown = 0;

  for (const spec of QUAL) {
    const data = q[spec.field];
    const tile = document.getElementById(`qual-tile-${spec.key}`);
    if (!tile) continue;
    // One side of the sweep can fail while the other lands — hide just that card.
    if (!data || !data.top) { tile.hidden = true; continue; }
    tile.hidden = false;
    shown++;

    const top = data.top;
    const setText = (id, s) => { const el = document.getElementById(id); if (el) el.textContent = s; };

    setText(`qual-den-${spec.key}`, t('holders.dist.den').replace('{n}', fmt.num(data.wallets)));
    setText(`qual-hl-n-${spec.key}`, fmt.num(top.supply));
    setText(`qual-hl-l-${spec.key}`, top.key);
    setText(`qual-hl-s-${spec.key}`,
      t(spec.hl).replace('{n}', fmt.pctFine(top.share)).replace('{total}', fmt.num(data.supply)));

    const tiers = document.getElementById(`qual-tiers-${spec.key}`);
    if (tiers) tiers.innerHTML = data.tiers
      .map((x, i) => railRow(tierLabel(x.key), x.supply, x.share, i, fmt)).join('');

    setText(`qual-own-hd-${spec.key}`, t('holders.rare.owners').replace('{tier}', top.key));
    setText(`qual-own-den-${spec.key}`, t('holders.rare.ownersDen').replace('{n}', fmt.num(top.holders)));
    setText(`qual-own-col-${spec.key}`, t('holders.rare.col.held').replace('{tier}', top.key));

    // Shares here are measured against the wallets that hold at least one, not against
    // every wallet in the collection — "41 of the 50 Legendary owners hold just one".
    const own = document.getElementById(`qual-own-${spec.key}`);
    if (own) {
      const rows = top.perWallet || [];
      const den = rows.reduce((a, b) => a + b.count, 0) || top.holders;
      own.innerHTML = rows
        .map((b, i) => railRow(b.label, b.count, den ? b.count / den : 0, i, fmt)).join('');
    }

    const foot = [t('holders.rare.mostHeld').replace('{n}', fmt.num(top.mostHeld))];
    if (data.rarest) {
      foot.push(t('holders.rare.rarest')
        .replace('{n}', fmt.num(data.rarest.n)).replace('{m}', fmt.num(data.rarest.holders)));
    }
    if (data.estates?.live) {
      foot.push(t('holders.rare.estates')
        .replace('{n}', fmt.num(data.estates.live))
        .replace('{m}', fmt.num(data.estates.parcelsLocked))
        .replace('{o}', fmt.num(data.estates.owners)));
    }
    setText(`qual-foot-${spec.key}`, foot.join(' · '));
  }

  const updated = document.getElementById('holders-rare-updated');
  if (updated && q.fetchedAt) {
    const d = new Date(q.fetchedAt);
    updated.textContent = t('holders.rare.asOf')
      .replace('{date}', d.toLocaleString(getCurrentLang(), { dateStyle: 'medium', timeStyle: 'short' }));
  }
  wrap.hidden = shown === 0;
}

// --- Concentration --------------------------------------------------------------
// One column per collection. Every row is a plain number with the share it represents
// underneath, because the share is the part that answers the question.
const CONC_COLS = [
  { field: 'creatures', label: 'holders.conc.creatures', accent: 'var(--hr-primary)',   soft: 'var(--hr-primary-25)' },
  { field: 'land',      label: 'holders.conc.land',      accent: 'var(--hr-banana)',    soft: 'var(--hr-banana-25)' },
  { field: 'combined',  label: 'holders.conc.combined',  accent: 'var(--hr-secondary)', soft: 'var(--hr-secondary-25)' },
];

function concRows(c, fmt) {
  const ofSupply = share => t('holders.conc.ofSupply').replace('{p}', fmt.pctFine(share));
  return [
    [t('holders.conc.largest'), fmt.num(c.largest), ofSupply(c.largestShare)],
    [t('holders.conc.top10'), fmt.pctFine(c.top10Share), ''],
    [t('holders.conc.topPct'), fmt.pctFine(c.topPercentShare), t('holders.conc.walletsN').replace('{n}', fmt.num(c.topPercentWallets))],
    [t('holders.conc.median'), fmt.dec(c.median), ''],
    [t('holders.conc.average'), fmt.dec(c.average), ''],
    [t('holders.conc.singles'), fmt.num(c.singles), t('holders.conc.ofWallets').replace('{p}', fmt.pctFine(c.wallets ? c.singles / c.wallets : 0))],
  ];
}

function renderConcentration(data) {
  const wrap = document.getElementById('holders-conc');
  const grid = document.getElementById('conc-grid');
  if (!wrap || !grid) return;
  const conc = data.concentration;
  const cols = conc ? CONC_COLS.filter(col => conc[col.field]) : [];
  if (!cols.length) { wrap.hidden = true; return; }
  wrap.hidden = false;

  const fmt = formatters();
  grid.innerHTML = cols.map((col, ci) => {
    const c = conc[col.field];
    const rows = concRows(c, fmt).map(([label, value, sub], i) => `
      <div class="conc-row" style="--i:${i}">
        <span class="conc-l">${esc(label)}</span>
        <span class="conc-v"><span class="conc-n">${esc(value)}</span>` +
          (sub ? `<span class="conc-s">${esc(sub)}</span>` : '') +
        `</span>
      </div>`).join('');
    return `<div class="conc-card" style="--accent:${col.accent};--accent-soft:${col.soft};--i:${ci}">` +
      `<div class="eyebrow">${esc(t(col.label))}</div>` +
      `<p class="dist-den">${esc(t('holders.conc.den').replace('{m}', fmt.num(c.wallets)))}</p>` +
      `<div class="conc-rows">${rows}</div>` +
    `</div>`;
  }).join('');
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
  renderConcentration(data);
}

export function rerenderHolders() {
  if (lastData) renderHolders(lastData);
  if (lastQuality) renderRare(lastQuality);
}

// The rarity sweep runs on a 12-hour clock and takes a couple of minutes to build from
// cold, so the page never waits on it: the snapshot above renders first and this fills in
// behind it. `ready: false` means the first sweep is still running — try a few more times,
// spacing the tries out, then give up quietly and leave the section out. Nothing here is
// load-bearing, so a failure is silent by design.
const QUALITY_TRIES = [8000, 20000, 45000];
async function loadQuality(attempt = 0) {
  try {
    const res = await fetch('/api/holders/quality');
    const q = await res.json();
    if (q.ready) {
      lastQuality = q;
      renderRare(q);
      return;
    }
  } catch { /* fall through to the retry */ }
  if (attempt < QUALITY_TRIES.length) {
    setTimeout(() => loadQuality(attempt + 1), QUALITY_TRIES[attempt]);
  }
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
    loadQuality();

  } catch (err) {
    clearInterval(poll);
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorMsg.textContent = err.message || t('holders.error');
  }
}
