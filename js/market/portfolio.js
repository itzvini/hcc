// Your collection — the value block at the top of the dashboard (/trade/dashboard).
//
// A holder asked for it on Discord: "a full on dashboard for your HCC collection. Maybe it
// can show 'Your collection value', show the value of the wallet over time." The dashboard
// already said what was waiting on a wallet (offers, listings, bids). This says what the
// wallet is worth: one figure across Creatures and LAND, how it has moved over the last
// year, how it splits between the two, and which pieces carry it.
//
// Every number is the server's (/api/market/portfolio/<address>), priced through the same
// guide the Sell form shows, so this block and that panel cannot disagree about an asset.
// The chart is what the wallet HELD on each day at that day's market, not today's holdings
// drawn backward: see lib/portfolio.js.
//
// State the block owns lives here and nowhere else. What it borrows:
//  - core/state.js  the wallet and the display currency
// The shell paints the block as part of the dashboard. After that the block repaints only
// itself, so its own loads never disturb the offers and history around it.

import { t } from '../i18n.js';
import { esc, root } from './core/dom.js';
import { account, currency, ethUsd, fxRates, tradeTab, setEthUsd, setFxRates } from './core/state.js';
import { COLLECTIONS } from './core/consts.js';
import { shell } from './core/bus.js';
import { fmtEth } from './core/fmt.js';
import { ico } from './core/icons.js';
import { sk, skRegion } from './core/skel.js';

let pf = null;            // the server's reply for `pfFor`, or null
let pfFor = null;         // the address `pf` belongs to: a wallet switch must never show the last one's money
let pfLoading = false;
let pfError = false;
let pfRange = 365;        // days on the chart
let pfChart = null;
let pfKey = '';           // what the reply SAYS, so an identical one changes nothing on screen
let pfRetryTimer = null;
let pfRetryFrom = 0;      // when the current run of "still loading" answers began
let pfStale = false;      // a re-ask came due while the dashboard was not on screen
let pfShownFor = null;    // the wallet whose entrance has played: it plays once, not per answer
let pfShownTotal = null;  // the headline as last painted, so a new figure counts on from it

const PF_RANGES = [
  { d: 30,  k: 'trade.chart.range1m', span: 'trade.pf.span30' },
  { d: 90,  k: 'trade.pf.range3m',    span: 'trade.pf.span90' },
  { d: 183, k: 'trade.chart.range6m', span: 'trade.pf.span180' },
  { d: 365, k: 'trade.chart.range1y', span: 'trade.pf.span365' },
];
/* While part of the collection is still being priced, ask again: soon at first, then every
   half minute, for as long as a cold start can take (reading every parcel's pet after a
   restart takes a few minutes). A re-ask that brings nothing new changes nothing on screen. */
const PF_RETRY_STEPS = [4000, 8000, 15000, 30000];
const PF_RETRY_FOR_MS = 8 * 60 * 1000;
const DAY_MS = 86400000;
const PF_FONT = "'Museo Sans Rounded', sans-serif";
const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrow = () => window.matchMedia('(max-width: 640px)').matches;
const onDash = () => tradeTab === 'dashboard';

/** The reply, but only if it is this wallet's. */
const mine = () => (pf && pfFor === account ? pf : null);

// --- Loading ------------------------------------------------------------------------------

export function maybeLoadPortfolio() {
  if (!account) return;
  if (pfFor !== account) resetPortfolio();
  if ((!pf || pfStale) && !pfLoading && !pfError) loadPortfolio();
}

export function refreshPortfolio() {
  if (!account || pfLoading) return;
  pfError = false; pfRetryFrom = 0;
  loadPortfolio();
}

/** Forget everything. Called on a wallet change; the next dashboard visit loads afresh. */
export function resetPortfolio() {
  pf = null; pfKey = ''; pfFor = account || null; pfLoading = false; pfError = false;
  pfRetryFrom = 0; pfStale = false; pfShownFor = null; pfShownTotal = null;
  clearTimeout(pfRetryTimer);
  destroyChart();
}

/** What a reply says, as one string. Two replies with the same key paint the same block. */
function contentKey(d) {
  const s = d.series;
  return JSON.stringify([
    d.total, d.partial, d.sides,
    (d.top || []).map(a => [a.coll, a.tokenId, a.fairEth, a.fairUsd]),
    s ? [s.points.length, s.points[0], s.points[s.points.length - 1], s.since, s.exact] : null,
  ]);
}

/** Ask again later while part of the collection is still being priced. */
function scheduleRetry(asked, data) {
  clearTimeout(pfRetryTimer);
  const waiting = Object.values(data.sides || {}).some(s => s.state === 'indexing');
  if (!waiting) { pfRetryFrom = 0; return; }
  const now = Date.now();
  if (!pfRetryFrom) pfRetryFrom = now;
  if (now - pfRetryFrom > PF_RETRY_FOR_MS) return;   // the block keeps saying so; Refresh asks again
  const n = Math.round((now - pfRetryFrom) / 1000);
  const step = PF_RETRY_STEPS[Math.min(PF_RETRY_STEPS.length - 1, n < 4 ? 0 : n < 12 ? 1 : n < 30 ? 2 : 3)];
  pfRetryTimer = setTimeout(() => {
    if (account !== asked) return;
    // Off the dashboard nobody is looking: ask when it is next opened instead.
    if (onDash()) loadPortfolio(); else pfStale = true;
  }, step);
}

/* The block repaints ITSELF, and only itself. The first version asked the shell to repaint
   the whole dashboard on every answer, and while LAND's prices were loading that was every
   few seconds: the offers, the listings and the history timeline all played their entrance
   again each time, which read as the page reloading. */
async function loadPortfolio() {
  if (!account || pfLoading) return;
  const asked = account;
  pfFor = asked;
  pfLoading = true; pfStale = false;
  clearTimeout(pfRetryTimer);
  patchPortfolio();   // from a failed state back to "loading"; a no-op when figures are showing
  markRefreshing();
  try {
    const res = await fetch(`/api/market/portfolio/${asked}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`portfolio HTTP ${res.status}`);
    const data = await res.json();
    if (asked !== account) return;   // the wallet changed while this was in flight
    pf = data; pfKey = contentKey(data); pfError = false;
    // Opened straight from a link, nothing else has set a rate yet, and every figure below
    // needs one. This reply carries the same rates from the same place.
    if (ethUsd == null && data.ethUsd != null) setEthUsd(data.ethUsd);
    if (data.fxRates && Object.keys(fxRates).length <= 1) setFxRates(data.fxRates);
    scheduleRetry(asked, data);
  } catch (err) {
    console.error('Collection value failed:', err);
    // Keep the last good answer for this wallet on screen; only an empty block says "failed".
    if (asked === account && !pf) pfError = true;
  } finally {
    if (asked === account) pfLoading = false;
    patchPortfolio();
    markRefreshing();
  }
}

/** The refresh bar, set on the block already on the page: a refresh must not repaint it. */
function markRefreshing() {
  const el = root()?.querySelector('#trade-pf');
  if (el) {
    el.classList.toggle('is-refreshing', pfLoading && !!mine());
    el.setAttribute('aria-busy', pfLoading || sidesPending() ? 'true' : 'false');
  }
  shell.patchDashRefresh();
}

export const portfolioBusy = () => pfLoading;
/** A collection whose prices are still loading: the block is still at work, between asks. */
const sidesPending = () => Object.values(mine()?.sides || {}).some(s => s.state === 'indexing');

/** Replace the block on the page when what it should say has changed. Nothing else moves. */
function patchPortfolio() {
  if (!onDash()) return;
  const el = root()?.querySelector('#trade-pf');
  if (!el || el.dataset.sig === signature()) return;
  let html;
  try { html = portfolioHtml(); } catch (err) { console.error('Collection value failed to paint:', err); return; }
  el.outerHTML = html;
  const fresh = root()?.querySelector('#trade-pf');
  if (fresh) afterPaint(fresh);
}

// --- Money --------------------------------------------------------------------------------

/** A dollar figure and its ETH twin, in the reader's display currency. Null when unknown. */
function inCurrency(usd, ethAmt) {
  if (currency === 'eth') return ethAmt ?? null;
  if (usd == null) return null;
  if (currency === 'usd') return usd;
  const rate = fxRates[currency];
  return rate == null ? null : usd * rate;
}
function fmtMoney(v, { compact = false } = {}) {
  if (v == null) return '—';
  if (currency === 'eth') return fmtEth(v);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: currency.toUpperCase(),
      // Cents under a hundred, where they matter; none on a round zero ("$0", not "$0.00").
      maximumFractionDigits: v !== 0 && Math.abs(v) < 100 ? 2 : 0,
      ...(compact && Math.abs(v) >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 } : {}),
    }).format(v);
  } catch { return `${Math.round(v).toLocaleString()} ${currency.toUpperCase()}`; }
}
// Axis labels are read in a column, so they stay short: "$40K", "$250", "0.5 Ξ".
function fmtAxis(v) {
  if (currency === 'eth') return `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 })} Ξ`;
  const abs = Math.abs(v);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: currency.toUpperCase(),
      notation: abs >= 10000 ? 'compact' : 'standard',
      maximumFractionDigits: abs >= 10000 ? 1 : abs > 0 && abs < 10 ? 2 : 0,
    }).format(v);
  } catch { return fmtMoney(v); }
}

// --- The chart's data -------------------------------------------------------------------

/** The points of the range on screen, as { x, y, n } in the display currency. */
function rangePoints() {
  const pts = mine()?.series?.points || [];
  if (!pts.length) return [];
  const from = pts[pts.length - 1].t - pfRange * DAY_MS;
  return pts.filter(p => p.t >= from)
    .map(p => ({ x: p.t, y: inCurrency(p.usd, p.eth), n: p.n }))
    .filter(p => p.y != null);
}
/** Only the ranges shorter than the data. "1 year" over four months of history draws the same picture. */
function rangeOffers() {
  const pts = mine()?.series?.points || [];
  if (pts.length < 2) return [];
  const span = (pts[pts.length - 1].t - pts[0].t) / DAY_MS;
  const fit = PF_RANGES.filter(r => r.d <= span + 2);
  // Always keep one that shows everything there is.
  return fit.length && fit[fit.length - 1].d >= span - 2 ? fit : [...fit, PF_RANGES[PF_RANGES.length - 1]];
}
/** Is there a line worth drawing? A wallet that held nothing all year has a flat zero. */
const hasChart = () => rangePoints().some(p => p.y > 0) && (mine()?.series?.points?.length || 0) > 2;

/** "Up 4.2% in a month". Null when the range began at nothing, where a percentage means nothing. */
function changeOf(points) {
  if (points.length < 2) return null;
  const a = points[0].y, b = points[points.length - 1].y;
  if (!(a > 0) || b == null) return null;
  return (b - a) / a;
}
function changeHtml() {
  const c = changeOf(rangePoints());
  if (c == null) return '';
  const offers = rangeOffers();
  const r = offers.find(x => x.d === pfRange) || offers[offers.length - 1] || PF_RANGES[PF_RANGES.length - 1];
  // Through Intl, so the sign sits where the reader's language puts it ("%4,2" in Turkish).
  let pct;
  try { pct = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: Math.abs(c) < 0.1 ? 1 : 0 }).format(Math.abs(c)); }
  catch { pct = `${(Math.abs(c) * 100).toFixed(Math.abs(c) < 0.1 ? 1 : 0)}%`; }
  const flat = Math.abs(c) < 0.0005;
  const key = flat ? 'trade.pf.flat' : c > 0 ? 'trade.pf.up' : 'trade.pf.down';
  const cls = flat ? '' : c > 0 ? 'is-up' : 'is-down';
  const text = t(key).replace('{pct}', pct).replace('{span}', t(r.span));
  return `<span class="pf-change ${cls}">${flat ? '' : `<span class="pf-change-arrow" aria-hidden="true">${c > 0 ? '▲' : '▼'}</span>`}${esc(text)}</span>`;
}

// --- Markup -------------------------------------------------------------------------------

function sideCountText(kind, n) {
  return t(`trade.pf.count.${kind}${n === 1 ? '.one' : ''}`).replace('{n}', n.toLocaleString());
}

function sideHtml(kind, s, share) {
  const label = t(COLLECTIONS[kind].labelKey);
  const accent = kind === 'land' ? 'var(--hr-secondary)' : 'var(--hr-primary)';
  // Still pricing: the figure, the share bar and the note all say it is on its way. This was
  // a bare dash, which reads as "nothing here" rather than "a minute more".
  if (s.state === 'indexing') {
    return `<div class="pf-side is-pending" style="--accent:${accent}">
      <div class="pf-side-top">
        <span class="pf-side-name">${ico(kind === 'land' ? 'map' : 'paw', 14)}${esc(label)}</span>
        ${sk('30px', 11, { i: 1 })}
      </div>
      ${sk('58%', 22, { i: 1, cls: 'pf-side-sk' })}
      <span class="pf-side-count">${esc(`${sideCountText(kind, s.count)}${s.truncated ? '+' : ''}`)}</span>
      ${sk('100%', 4, { i: 2, shape: 'pill', cls: 'pf-sk-bar' })}
      <span class="pf-side-note is-waiting">${DOTS}<span>${esc(t('trade.pf.side.indexing'))}</span></span>
    </div>`;
  }
  let value, note = '';
  if (s.state === 'unavailable') {
    value = '—'; note = t('trade.pf.side.unavailable');
  } else if (s.state === 'unpriced') {
    value = '—'; note = t('trade.pf.side.unpriced');
  } else {
    value = fmtMoney(inCurrency(s.fairUsd, s.fairEth));
    if (s.priced < s.count) note = t('trade.pf.side.partPriced').replace('{n}', String(s.count - s.priced));
  }
  const count = s.state === 'unavailable' ? '' : `${sideCountText(kind, s.count)}${s.truncated ? '+' : ''}`;
  const pct = share != null ? Math.round(share * 100) : null;
  return `<div class="pf-side" style="--accent:${accent}">
    <div class="pf-side-top">
      <span class="pf-side-name">${ico(kind === 'land' ? 'map' : 'paw', 14)}${esc(label)}</span>
      ${pct != null ? `<span class="pf-side-pct">${pct}%</span>` : ''}
    </div>
    <span class="pf-side-val">${esc(value)}</span>
    <span class="pf-side-count">${esc(count)}</span>
    ${pct != null ? `<span class="pf-side-bar" aria-hidden="true"><span style="transform:scaleX(${Math.max(0.02, share).toFixed(3)})"></span></span>` : ''}
    ${note ? `<span class="pf-side-note">${esc(note)}</span>` : ''}
  </div>`;
}

function topHtml(top) {
  if (!top?.length) return '';
  const rows = top.map((a, i) => {
    const pet = a.coll === 'land' && Number.isInteger(a.coords?.x) && Number.isInteger(a.coords?.y)
      ? `/api/market/land/pet/${a.coords.x}/${a.coords.y}` : null;
    const src = pet || a.image;
    const art = src
      ? `<img class="${pet ? 'is-pet' : ''}" src="${esc(src)}"${pet && a.image ? ` data-fallback="${esc(a.image)}"` : ''} alt="" loading="lazy" />`
      : `<span class="pf-top-noimg" aria-hidden="true">${ico(a.coll === 'land' ? 'map' : 'paw', 20)}</span>`;
    // What the guide priced it on, when something sets it apart: a tier, or the one trait.
    const why = a.why ? String(a.why.label || '').replace(/^[^:]+:\s*/, '') : '';
    const sub = [a.parcel ? a.parcel.replace(/^Highrise /, '') : '', why].filter(Boolean);
    // The whole row opens the asset, in its own collection (the shell's asset-open).
    return `<li><button type="button" class="pf-top-row" style="animation-delay:${Math.min(i * 45, 300)}ms"
      data-act="asset-open" data-token="${esc(a.tokenId)}" data-coll="${esc(a.coll)}"
      aria-label="${esc(t('trade.dash.openAria').replace('{name}', a.name))}">
      <span class="pf-top-art">${art}</span>
      <span class="pf-top-body">
        <span class="pf-top-name">${esc(a.name)}</span>
        ${sub.length ? `<span class="pf-top-sub">${sub.map((x, k) => (k === sub.length - 1 && why
          ? `<span class="pf-chip ${a.why.kind === 'tier' ? 'is-tier' : ''}">${esc(x)}</span>` : `<span>${esc(x)}</span>`)).join('')}</span>` : ''}
      </span>
      <span class="pf-top-val">${esc(fmtMoney(inCurrency(a.fairUsd, a.fairEth)))}</span>
      <span class="pf-top-go" aria-hidden="true">${ico('chevronRight', 15)}</span>
    </button></li>`;
  }).join('');
  return `<div class="pf-top">
    <h5 class="pf-h">${esc(t('trade.pf.top.h'))}</h5>
    <ol class="pf-top-list">${rows}</ol>
  </div>`;
}

function notesHtml(d) {
  const notes = [];
  for (const kind of ['creatures', 'land']) {
    if (d.sides[kind]?.state === 'unavailable') notes.push(t(`trade.pf.missing.${kind}`));
  }
  if (d.series?.since) {
    let when = '';
    try { when = new Date(d.series.since).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch { /* no date, no clause */ }
    if (when) notes.push(t('trade.pf.since').replace('{date}', when));
  }
  if (d.series && d.series.exact === false) notes.push(t('trade.pf.approx'));
  return notes.map(n => `<p class="pf-warn">${ico('alert', 13)}<span>${esc(n)}</span></p>`).join('');
}

function chartHtml() {
  if (!hasChart()) return '';
  const offers = rangeOffers();
  const active = offers.some(r => r.d === pfRange) ? pfRange : offers[offers.length - 1]?.d;
  return `<div class="pf-chart">
    <div class="pf-chart-head">
      <span class="pf-chart-cap">${esc(t('trade.pf.chart.cap'))}</span>
      ${offers.length > 1 ? `<div class="seg pf-ranges" role="group" aria-label="${esc(t('trade.chart.rangeAria'))}">
        ${offers.map(r => `<button type="button" class="seg-btn ${r.d === active ? 'is-active' : ''}" data-act="pf-range" data-d="${r.d}" aria-pressed="${r.d === active}">${esc(t(r.k))}</button>`).join('')}
      </div>` : ''}
    </div>
    <div class="pf-canvas"><canvas id="pf-canvas" role="img" aria-label="${esc(t('trade.pf.chart.aria'))}"></canvas></div>
  </div>`;
}

/** The whole block, as it stands: loading, failed, empty, or the figures. */
export function portfolioHtml() {
  const d = mine();
  const refreshing = pfLoading && d ? ' is-refreshing' : '';
  const waiting = pfLoading || sidesPending();
  const shell0 = (inner, cls = '') => `<section class="pf${cls}${refreshing}" id="trade-pf" data-sig="${esc(signature())}" aria-label="${esc(t('trade.pf.h'))}" aria-busy="${waiting ? 'true' : 'false'}">
    <span class="pf-aurora" aria-hidden="true"></span>${inner}</section>`;
  const eyebrow = `<span class="pf-eyebrow">${ico('sparkle', 12)}${esc(t('trade.pf.eyebrow'))}</span>`;

  if (!d) {
    if (pfError) {
      return shell0(`${eyebrow}<p class="pf-state">${esc(t('trade.pf.error'))}</p>
        <button class="apply-btn-ghost" type="button" data-act="pf-retry">${esc(t('trade.refresh'))}</button>`);
    }
    return shell0(`${eyebrow}${loadingHtml()}`);
  }

  const sides = d.sides || {};
  const held = d.total.count;
  const anyRead = Object.values(sides).some(s => s.state !== 'unavailable');
  if (anyRead && held === 0 && !hasChart()) {
    return shell0(`${eyebrow}
      <div class="pf-empty">
        <h4 class="pf-empty-h">${esc(t('trade.pf.empty.h'))}</h4>
        <p>${esc(t('trade.pf.empty.p'))}</p>
        <button class="apply-btn-ghost" type="button" data-act="trade-tab" data-tab="buy">${esc(t('trade.pf.empty.cta'))}</button>
      </div>${notesHtml(d)}`);
  }

  const total = inCurrency(d.total.fairUsd, d.total.fairEth);
  const priced = Object.values(sides).some(s => s.state === 'ok');
  // A collection still being priced: the page keeps asking (see scheduleRetry) and says so.
  const pending = Object.values(sides).some(s => s.state === 'indexing');
  // The other money beside the headline: ETH under a fiat figure, nothing under an ETH one.
  const twin = currency === 'eth' || !priced ? '' : fmtEth(d.total.fairEth);
  const pricedEth = ['creatures', 'land'].reduce((n, k) => n + (sides[k]?.state === 'ok' ? sides[k].fairEth : 0), 0);
  const share = k => (sides[k]?.state === 'ok' && pricedEth > 0 ? sides[k].fairEth / pricedEth : null);
  const enter = pfShownFor === pfFor ? '' : ' is-entering';

  return shell0(`
    <div class="pf-head">
      <div class="pf-headline">
        ${eyebrow}
        <span class="pf-total" id="pf-total" data-v="${esc(String(total ?? ''))}">${esc(priced ? fmtMoney(total) : '—')}</span>
        <span class="pf-sub">
          ${twin ? `<span class="pf-twin">${esc(twin)}</span>` : ''}
          ${changeHtml()}
          ${d.partial && priced ? `<span class="pf-partial${pending ? ' is-waiting' : ''}">${pending ? DOTS : ''}${esc(t('trade.pf.partial'))}</span>` : ''}
        </span>
      </div>
      <div class="pf-sides">
        ${sides.creatures ? sideHtml('creatures', sides.creatures, share('creatures')) : ''}
        ${sides.land ? sideHtml('land', sides.land, share('land')) : ''}
      </div>
    </div>
    ${chartHtml() || (pending ? pendingChartHtml() : '')}
    ${topHtml(d.top)}
    ${notesHtml(d)}
    <p class="pf-foot">${esc(t('trade.pf.foot'))}</p>`, enter);
}

// A ghost of a year's line: a calm rise with one dip, filled underneath. It only has to read
// as "a chart goes here", so it never pretends to be anyone's figures.
function ghostChartSvg() {
  return `<svg class="pf-sk-chart" viewBox="0 0 600 200" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="pfSkFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--hr-primary)" stop-opacity=".10"/><stop offset="1" stop-color="var(--hr-primary)" stop-opacity="0"/>
      </linearGradient></defs>
      <g class="pf-sk-grid"><line x1="0" y1="40" x2="600" y2="40"/><line x1="0" y1="90" x2="600" y2="90"/><line x1="0" y1="140" x2="600" y2="140"/><line x1="0" y1="190" x2="600" y2="190"/></g>
      <path class="pf-sk-area" d="M0 170 C60 166 90 150 140 146 S230 120 280 96 S360 70 400 74 S470 104 520 92 S580 70 600 66 L600 200 L0 200 Z" fill="url(#pfSkFill)"/>
      <path class="pf-sk-line" d="M0 170 C60 166 90 150 140 146 S230 120 280 96 S360 70 400 74 S470 104 520 92 S580 70 600 66"/>
    </svg>`;
}

const DOTS = '<span class="sk-dots" aria-hidden="true"><i></i><i></i><i></i></span>';

/* The chart's place while one collection is still being priced. The chart needs both, so it
   is held back, but its room is kept: a ghost line under the real caption, and the year
   arrives into the space it was always going to take. */
function pendingChartHtml() {
  return `<div class="pf-chart pf-chart-pending">
    <div class="pf-chart-head">
      <span class="pf-chart-cap">${esc(t('trade.pf.chart.cap'))}</span>
      ${sk('min(268px, 100%)', 30, { i: 2, shape: 'pill' })}
    </div>
    <div class="pf-canvas pf-sk-canvas">${ghostChartSvg()}</div>
  </div>`;
}

/* The block while its first answer is on its way: the same layout, drawn in skeleton. The
   total, the two collection tiles, a ghost of the year's chart and the first rows of the
   most valuable list, so nothing moves when the figures land on top of them. */
function loadingHtml() {
  const side = (k, n) => `<div class="pf-side" style="--accent:var(${k === 'land' ? '--hr-secondary' : '--hr-primary'})">
      <span class="pf-side-top">${sk('86px', 11, { i: n })}${sk('30px', 11, { i: n })}</span>
      ${sk('62%', 22, { i: n + 1 })}${sk('44%', 12, { i: n + 2 })}${sk('100%', 4, { i: n + 3, shape: 'pill', cls: 'pf-sk-bar' })}
    </div>`;
  const row = n => `<li><span class="pf-top-row pf-sk-row" style="--i:${n}">${sk('42px', 42, { i: n + 4, shape: 'tile' })}
      <span class="pf-top-body">${sk(`${58 - (n % 2) * 14}%`, 13, { i: n + 4 })}${sk('34%', 11, { i: n + 5 })}</span>${sk('58px', 14, { i: n + 4 })}</span></li>`;
  const ghost = ghostChartSvg();
  return skRegion(t('trade.pf.loading'), `
    <div class="pf-head">
      <div class="pf-headline">${sk('min(250px, 72%)', 46, { i: 0 })}
        <span class="pf-sub">${sk('96px', 15, { i: 1 })}${sk('132px', 24, { i: 1, shape: 'pill' })}</span></div>
      <div class="pf-sides">${side('creatures', 0)}${side('land', 1)}</div>
    </div>
    <div class="pf-chart">
      <div class="pf-chart-head">${sk('min(260px, 60%)', 12, { i: 2 })}${sk('min(268px, 100%)', 30, { i: 2, shape: 'pill' })}</div>
      <div class="pf-canvas pf-sk-canvas">${ghost}</div>
    </div>
    <div class="pf-top">${sk('130px', 11, { i: 3, cls: 'pf-sk-h' })}<ol class="pf-top-list">${[0, 1, 2, 3].map(row).join('')}</ol></div>`, 'pf-loading');
}

/* Everything the painted block depends on, as one string. The dashboard rewrites itself
   whole whenever any of its reads lands (offers, listings, history), three or four times in
   the first seconds. When this string has not changed, the block already on the page is
   the block that would be painted, so it is kept: same canvas, same chart, no flicker, and
   a tooltip under the reader's finger stays there. */
function signature() {
  const d = mine();
  const state = d ? `ok:${pfKey}` : pfError ? 'error' : 'loading';
  return [pfFor, state, currency, fxRates[currency] ?? '', pfRange, t('trade.pf.eyebrow')].join('|');
}

/** Before the dashboard is rewritten: the live block, if it is still the right one. */
export function holdPortfolio() {
  const el = root()?.querySelector('#trade-pf');
  return el && el.dataset.sig === signature() ? el : null;
}

// --- After the paint: the chart and the count-up -----------------------------------------

function destroyChart() {
  if (pfChart) { try { pfChart.destroy(); } catch { /* already gone with its canvas */ } pfChart = null; }
}

function drawChart(animate) {
  const cv = root()?.querySelector('#pf-canvas');
  destroyChart();
  if (!cv || typeof Chart === 'undefined') return;
  const pts = rangePoints();
  if (pts.length < 2) return;
  const up = (changeOf(pts) ?? 0) >= 0;
  const line = up ? '#51FFA5' : '#FF5B95';
  const spanDays = (pts[pts.length - 1].x - pts[0].x) / DAY_MS;
  pfChart = new Chart(cv, {
    type: 'line',
    data: { datasets: [{
      data: pts, parsing: false,
      borderColor: line, borderWidth: 2.2, tension: .28, pointRadius: 0,
      pointHoverRadius: 5, pointHoverBackgroundColor: line, pointHoverBorderColor: '#141317', pointHoverBorderWidth: 2,
      fill: true,
      // A fade from the line down to nothing, built per draw so it tracks the chart's height.
      backgroundColor(ctx) {
        const area = ctx.chart.chartArea;
        if (!area) return 'transparent';
        const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, up ? 'rgba(81,255,165,.30)' : 'rgba(255,91,149,.26)');
        g.addColorStop(1, 'rgba(20,19,23,0)');
        return g;
      },
    }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      // Room for the last date label, which is centred on the final point and would
      // otherwise lose its right half to the edge of the canvas.
      layout: { padding: { right: 18 } },
      animation: animate && !still() ? { duration: 650, easing: 'easeOutCubic' } : false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        // The zoom plugin registers itself for every chart on the page; a year of daily
        // points has nothing to zoom into.
        zoom: { pan: { enabled: false }, zoom: { wheel: { enabled: false }, pinch: { enabled: false } } },
        tooltip: {
          displayColors: false, padding: 10,
          titleFont: { family: PF_FONT, weight: '800' }, bodyFont: { family: PF_FONT, weight: '700' },
          callbacks: {
            title: items => {
              const x = items[0]?.parsed?.x;
              try { return x == null ? '' : new Date(x).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
              catch { return ''; }
            },
            label: ctx => fmtMoney(ctx.parsed.y),
            afterLabel: ctx => t('trade.pf.tip.held').replace('{n}', String(ctx.raw?.n ?? 0)),
          },
        },
      },
      scales: {
        x: {
          type: 'linear', min: pts[0].x, max: pts[pts.length - 1].x,
          grid: { display: false }, border: { display: false },
          ticks: {
            font: { family: PF_FONT, size: 10, weight: '700' }, color: '#7D7C88',
            maxTicksLimit: narrow() ? 4 : 7, maxRotation: 0, autoSkip: true,
            callback(v) {
              try {
                // "Nov 25" reads as the 25th of November: spell the year out.
                return new Date(v).toLocaleDateString(undefined, spanDays > 120
                  ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' });
              } catch { return ''; }
            },
          },
        },
        y: {
          // From zero when the wallet was empty for part of the range, so "nothing" sits on
          // the floor; otherwise fitted to the line, so a 5% move is not drawn as a flat one.
          beginAtZero: pts.some(p => p.y === 0),
          grace: '8%',
          grid: { color: 'rgba(255,255,255,.07)' }, border: { display: false },
          ticks: { font: { family: PF_FONT, size: 10, weight: '700' }, color: '#7D7C88', maxTicksLimit: 5, callback: fmtAxis },
        },
      },
    },
  });
}

/** Run the headline number from `from` to its value. Skipped for reduced motion. */
function countUp(from = 0) {
  const el = root()?.querySelector('#pf-total');
  const to = Number(el?.dataset.v);
  if (!el || !Number.isFinite(to) || to <= 0 || still() || !Number.isFinite(from) || from === to) return;
  const final = el.textContent;
  const t0 = performance.now(), DUR = from ? 600 : 900;
  const tick = now => {
    if (!el.isConnected) return;
    const k = Math.min(1, (now - t0) / DUR);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = k < 1 ? fmtMoney(from + (to - from) * eased) : final;
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* After the block is written: draw its chart and settle its headline. The entrance (the
   rise, the bars filling, the line drawing in, the count from zero) plays once per wallet.
   A later answer that changes the figures (LAND's prices arriving) redraws in place and
   counts on from the figure already showing. */
function afterPaint(el) {
  const first = pfShownFor !== pfFor;
  const to = Number(el.querySelector('#pf-total')?.dataset.v);
  drawChart(first);
  if (mine()) {
    countUp(first ? 0 : (pfShownTotal ?? to));
    pfShownFor = pfFor;
    pfShownTotal = Number.isFinite(to) ? to : null;
  }
  if (first) setTimeout(() => el.classList.remove('is-entering'), 1500);
}

/**
 * Call after the dashboard has been written to the page. The canvas is new every time the
 * dashboard repaints, so the chart is rebuilt each time; only the first build for an answer
 * animates, and only then does the total count up. A repaint for some other reason (an
 * offer arriving) must not replay either.
 */
export function mountPortfolio(kept = null) {
  const fresh = root()?.querySelector('#trade-pf');
  if (!fresh) { destroyChart(); return; }
  // The block that was on the page a moment ago says the same thing as the one just
  // written: put the old one back, chart and all.
  if (kept && kept !== fresh && kept.dataset.sig === fresh.dataset.sig) {
    kept.classList.remove('is-entering');   // re-attaching would replay its entrance
    fresh.replaceWith(kept);
    return;
  }
  afterPaint(fresh);
}

/** The block's own clicks. Returns true when it handled one. */
export function onPortfolioClick(act, target) {
  if (act === 'pf-range') {
    const d = Number(target.dataset.d);
    if (!PF_RANGES.some(r => r.d === d) || d === pfRange) return true;
    pfRange = d;
    // Only the chart and the change line depend on the range: patch those, keep the rest.
    const blk = root()?.querySelector('#trade-pf');
    if (blk) {
      blk.querySelectorAll('[data-act="pf-range"]').forEach(b => {
        const on = Number(b.dataset.d) === d;
        b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on));
      });
      const old = blk.querySelector('.pf-change');
      const html = changeHtml();
      if (old) old.outerHTML = html || '<span class="pf-change" hidden></span>';
      else if (html) blk.querySelector('.pf-sub')?.insertAdjacentHTML('beforeend', html);
      drawChart(true);
    }
    return true;
  }
  if (act === 'pf-retry') { refreshPortfolio(); return true; }
  return false;
}
