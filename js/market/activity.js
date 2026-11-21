// Your activity — the dashboard's history of what this wallet has done, in BOTH collections.
//
// It used to show one collection at a time: whichever the switcher at the top was on, so a
// holder with Creatures and LAND had to flip the whole page to read half their history, and
// a list of eighty rows had nothing to narrow it with. Now one list carries both, each row
// says which collection it belongs to, and three filters cut it down: collection, what
// happened (bought, sold, sent...), and a search over names, numbers, pet names and
// coordinates. Every row opens the asset it is about.
//
// State the list owns lives here and nowhere else, keyed to the wallet it was read for, so
// switching collection keeps it and switching wallet drops it. What it borrows:
//  - core/state.js  the wallet, the active view, the display currency
//  - core/bus.js    the shell's listing-amount formatter (one wording for every price)
// The shell paints the list inside the dashboard; after that the list repaints only itself,
// and filtering repaints only the rows, so the search box keeps its focus while you type.

import { t } from '../i18n.js';
import { esc, root } from './core/dom.js';
import { account, currency, tradeTab } from './core/state.js';
import { COLLECTIONS, COLL_ICONS, EXPLORER } from './core/consts.js';
import { fmtEth, fmtSaleFiat, shortWallet } from './core/fmt.js';
import { shell } from './core/bus.js';
import { ico } from './core/icons.js';
import { sk, skRegion } from './core/skel.js';

const COLLS = ['creatures', 'land'];
const ACT_PAGE = 30;          // rows painted at a time; "Show more" adds the next lot
const SEARCH_DEBOUNCE_MS = 120;

// What happened, in the order the filter chips read: trades, then moves, then listings
// that ended without a trade.
const KINDS = ['bought', 'sold', 'received', 'sent', 'minted', 'cancelled', 'expired'];
const KIND_CLS = {
  bought: 'is-bought', sold: 'is-sold', received: 'is-received', sent: 'is-sent',
  minted: 'is-minted', cancelled: 'is-cancelled', expired: 'is-expired',
};

let act = freshState(null);
let flt = { coll: 'all', kinds: new Set(), q: '' };
let shown = ACT_PAGE;
let enteredAt = 0;            // the read whose rows have already made their entrance
let searchTimer = null;

function freshState(wallet) {
  return {
    for: wallet, items: null, loading: false, at: 0,
    failed: { creatures: false, land: false },   // that side could not be read
    capped: { creatures: false, land: false },   // that side has older moves than it sent
  };
}

const onDash = () => tradeTab === 'dashboard';
/** The list, but only if it is this wallet's. */
const mine = () => (act.for === account ? act : null);

// --- Loading ------------------------------------------------------------------------------

export function maybeLoadActivity() {
  if (!account) return;
  if (act.for !== account) resetActivity();
  if (act.items === null && !act.loading) loadActivity();
}

export function refreshActivity() {
  if (!account || act.loading) return;
  loadActivity();
}

/** Forget everything about the last wallet. The filters are a reader's choice and stay. */
export function resetActivity() {
  act = freshState(account || null);
  shown = ACT_PAGE;
  enteredAt = 0;
}

export const activityBusy = () => !!mine()?.loading;

async function loadActivity() {
  if (!account || act.loading) return;
  const asked = account;
  if (act.for !== asked) act = freshState(asked);
  act.loading = true;
  // First read: the skeleton. A refresh with rows already showing keeps them, under a bar.
  if (act.items === null) patchActivity(); else markRefreshing();
  const read = async c => {
    const res = await fetch(`${COLLECTIONS[c].api}/history/${asked}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${c} history HTTP ${res.status}`);
    const d = await res.json();
    if (!Array.isArray(d.items)) throw new Error(`${c} history: no items`);
    return { items: d.items.map(it => ({ ...it, coll: c })), more: !!d.more };
  };
  // Each collection is read on its own and fails on its own: LAND's history comes from
  // OpenSea and the Creatures' from Immutable, and one being down must cost its own rows
  // and nothing else.
  const results = await Promise.allSettled(COLLS.map(read));
  if (act.for !== asked || asked !== account) return;   // the wallet changed meanwhile
  const items = [];
  results.forEach((r, i) => {
    const c = COLLS[i];
    act.failed[c] = r.status !== 'fulfilled';
    act.capped[c] = r.status === 'fulfilled' && r.value.more;
    if (r.status === 'fulfilled') items.push(...r.value.items);
    else console.error(`Activity (${c}) failed:`, r.reason);
  });
  // A refresh that read nothing keeps the rows it already had rather than blanking them.
  const allFailed = COLLS.every(c => act.failed[c]);
  if (!allFailed || act.items === null) {
    act.items = items.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)
      || String(a.coll).localeCompare(String(b.coll)) || String(a.tokenId).localeCompare(String(b.tokenId)));
  }
  act.at = Date.now();
  act.loading = false;
  shown = ACT_PAGE;
  patchActivity();
  markRefreshing();
}

/** The refresh bar, set on the section already on the page. */
function markRefreshing() {
  const el = root()?.querySelector('#trade-act');
  if (el) {
    el.classList.toggle('is-refreshing', !!(act.loading && act.items));
    el.setAttribute('aria-busy', act.loading ? 'true' : 'false');
  }
  shell.patchDashRefresh();
}

// --- Filtering ------------------------------------------------------------------------------

/** Everything a row can be found by: its name, its pet, its number, its coordinates. */
function haystack(h) {
  const c = h.coords;
  return `${h.slimeName || ''} ${h.name || ''} ${h.parcel || ''} ${h.tokenId} ${c ? `${c.x},${c.y} ${c.x} ${c.y}` : ''}`.toLowerCase();
}

/** The rows the filters let through. `skip` leaves one filter out, for the counts on it. */
function filtered(skip = null) {
  const items = mine()?.items || [];
  const q = flt.q.toLowerCase();
  return items.filter(h =>
    (skip === 'coll' || flt.coll === 'all' || h.coll === flt.coll)
    && (skip === 'kind' || !flt.kinds.size || flt.kinds.has(h.kind))
    && (!q || haystack(h).includes(q)));
}

const filtersOn = () => flt.coll !== 'all' || flt.kinds.size > 0 || !!flt.q;

// --- Formatting -----------------------------------------------------------------------------

const txUrl = (hash, c) => (c === 'land' ? `https://etherscan.io/tx/${hash}` : `${EXPLORER}/tx/${hash}`);
const petUrl = h => (Number.isInteger(h?.coords?.x) && Number.isInteger(h?.coords?.y)
  ? `/api/market/land/pet/${h.coords.x}/${h.coords.y}` : null);

/**
 * What a past trade was worth, in the money it settled in and in the reader's currency AT
 * THE TIME: "0.1266 ETH (≈ US$ 313)" where the 313 is July's dollars, not today's. The server
 * values each entry on its own day; no rate for that day means no dollar figure.
 */
function fmtPrice(h) {
  const native = h.currency
    ? shell.fmtListingAmt({ currency: h.currency, totalAmt: h.priceAmt ?? h.priceEth, totalEth: h.priceEth })
    : fmtEth(h.priceEth);
  const fiat = fmtSaleFiat(h.priceUsd);
  return fiat ? `${native} (${fiat})` : native;
}

function fmtDate(iso) {
  const ts = Date.parse(iso || '');
  if (!Number.isFinite(ts)) return '';
  try { return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return ''; }
}
function monthOf(iso) {
  const ts = Date.parse(iso || '');
  if (!Number.isFinite(ts)) return '';
  try { return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'long' }); }
  catch { return ''; }
}

const collLabel = c => t(COLLECTIONS[c].labelKey);
const collMark = c => `<img class="trade-coll-ico" src="${COLL_ICONS[c]}" alt="" aria-hidden="true" />`;

// --- Markup -------------------------------------------------------------------------------

/**
 * One row. The left of the card is a button that opens the asset; the badge, the
 * collection and the transaction link sit beside it, outside the button, because a link
 * cannot live inside a button.
 */
function rowHtml(h, i, anim) {
  const cls = KIND_CLS[h.kind] || '';
  const isLand = h.coll === 'land';
  const pet = isLand ? petUrl(h) : null;
  const art = pet
    ? `<img class="is-pet" src="${esc(pet)}" ${h.image ? `data-fallback="${esc(h.image)}"` : ''} alt="" loading="lazy" />`
    : h.image ? `<img src="${esc(h.image)}" alt="" loading="lazy" />`
    : `<span class="trade-tile-noimg" aria-hidden="true">${ico(isLand ? 'map' : 'paw', 24)}</span>`;
  const title = h.slimeName || h.name || `#${h.tokenId}`;
  // A parcel is known by its pet; the coordinates say which parcel it is.
  const where = h.slimeName && h.parcel ? `<span class="act-where">${esc(String(h.parcel).replace(/^Highrise /, ''))}</span>` : '';
  let sub = '';
  if ((h.priceAmt ?? h.priceEth) != null) {
    sub = `<span class="trade-mine-price ${h.currency === 'usdc' ? 'is-usdc' : ''}">${esc(fmtPrice(h))}</span>`;
  } else if (h.with) {
    const lbl = t(h.kind === 'sent' ? 'trade.history.to' : 'trade.history.from');
    sub = `<span class="trade-history-with">${esc(lbl)} <code>${esc(shortWallet(h.with))}</code></span>`;
  }
  const when = fmtDate(h.at);
  const tx = h.tx
    ? `<a href="${esc(txUrl(h.tx, h.coll))}" target="_blank" rel="noopener" class="trade-history-tx">${esc(t('trade.history.tx'))} ${ico('external', 12)}</a>`
    : '';
  const style = anim === 'enter' ? ` style="animation-delay:${Math.min(i * 35, 350)}ms"` : '';
  return `
    <li class="trade-tl-item act-row is-${anim}"${style}>
      <span class="trade-tl-dot ${cls}" aria-hidden="true"></span>
      <div class="trade-mine-card trade-history-card act-card">
        <button type="button" class="act-open" data-act="asset-open" data-token="${esc(h.tokenId)}" data-coll="${esc(h.coll)}"
          aria-label="${esc(t('trade.dash.openAria').replace('{name}', title))}">
          <span class="act-art">${art}</span>
          <span class="trade-mine-info">
            <span class="trade-mine-name">${esc(title)}</span>
            ${where}
            ${sub}
            ${when ? `<span class="trade-history-when">${esc(when)}</span>` : ''}
          </span>
          <span class="act-go" aria-hidden="true">${ico('chevronRight', 16)}</span>
        </button>
        <div class="act-side">
          <span class="trade-history-badge ${cls}">${esc(t(`trade.history.kind.${h.kind}`))}</span>
          <span class="act-coll is-${esc(h.coll)}">${collMark(h.coll)}${esc(collLabel(h.coll))}</span>
          ${tx}
        </div>
      </div>
    </li>`;
}

/** The rows on screen, with a month heading wherever the month changes. */
function rowsHtml(rows, anim, enterFrom = 0) {
  let month = '';
  const out = [];
  rows.forEach((h, i) => {
    const m = monthOf(h.at);
    if (m && m !== month) {
      month = m;
      out.push(`<li class="act-month"><span>${esc(m)}</span></li>`);
    }
    out.push(rowHtml(h, i - enterFrom, i < enterFrom ? 'still' : anim));
  });
  return out.join('');
}

function notesHtml(a) {
  const notes = [];
  for (const c of COLLS) {
    if (a.failed[c]) {
      notes.push(`<p class="act-note is-warn">${ico('alert', 13)}<span>${esc(t(`trade.act.missing.${c}`))}</span>
        <button type="button" class="trade-flt-clearall" data-act="act-retry">${esc(t('trade.refresh'))}</button></p>`);
    }
  }
  if (COLLS.some(c => a.capped[c])) notes.push(`<p class="act-note">${esc(t('trade.act.capped'))}</p>`);
  return notes.join('');
}

/* The list while its first read is on the way: a ghost of the filters, a month heading and
   five rows on the timeline's own rail, each the shape of a real one. */
function loadingHtml() {
  const rows = [0, 1, 2, 3, 4].map(n => `
    <li class="trade-tl-item act-sk-item" style="animation-delay:${n * 70}ms">
      <span class="trade-tl-dot act-sk-dot" aria-hidden="true"></span>
      <div class="trade-mine-card trade-history-card act-card act-sk-card">
        <span class="act-open">${sk('46px', 46, { i: n, shape: 'tile' })}
          <span class="trade-mine-info">${sk(`${48 - (n % 3) * 8}%`, 13, { i: n })}${sk(`${30 + (n % 2) * 10}%`, 11, { i: n + 1 })}${sk('22%', 10, { i: n + 2 })}</span></span>
        <span class="act-side">${sk('78px', 22, { i: n, shape: 'pill' })}${sk('64px', 10, { i: n + 1 })}</span>
      </div>
    </li>`).join('');
  return skRegion(t('trade.history.loading'), `
    <div class="act-bar act-sk-bar">${sk('min(300px, 100%)', 36, { shape: 'pill' })}${sk('100%', 38, { shape: 'pill', cls: 'act-sk-search' })}</div>
    <div class="act-kinds">${[88, 96, 80].map((w, n) => sk(`${w}px`, 30, { i: n, shape: 'pill' })).join('')}</div>
    <ol class="trade-timeline act-list"><li class="act-month">${sk('116px', 10, { i: 1 })}</li>${rows}</ol>`, 'act-loading');
}

function listHtml(anim = 'enter', enterFrom = 0) {
  const a = mine();
  if (!a || a.items === null) return loadingHtml();
  if (!a.items.length) {
    const allFailed = COLLS.every(c => a.failed[c]);
    return allFailed
      ? `<p class="trade-form-p">${esc(t('trade.history.error'))}</p>
         <button class="apply-btn-ghost" type="button" data-act="act-retry">${esc(t('trade.refresh'))}</button>`
      : `${notesHtml(a)}<p class="trade-form-p">${esc(t('trade.history.none'))}</p>`;
  }
  const rows = filtered();
  if (!rows.length) {
    return `${notesHtml(a)}<div class="act-empty">
      <span class="act-empty-ico" aria-hidden="true">${ico('search', 22)}</span>
      <p>${esc(t('trade.act.none'))}</p>
      <button type="button" class="apply-btn-ghost" data-act="act-clear">${esc(t('trade.filter.clear'))}</button>
    </div>`;
  }
  const visible = rows.slice(0, shown);
  const left = rows.length - visible.length;
  return `${notesHtml(a)}
    <ol class="trade-timeline act-list">${rowsHtml(visible, anim, enterFrom)}</ol>
    ${left > 0 ? `<div class="act-more-wrap"><button type="button" class="apply-btn-ghost act-more" data-act="act-more">${esc(t('trade.act.more').replace('{n}', String(Math.min(ACT_PAGE, left))))}</button></div>` : ''}`;
}

function collSegHtml() {
  const counts = { all: 0, creatures: 0, land: 0 };
  for (const h of filtered('coll')) { counts.all++; counts[h.coll]++; }
  return ['all', ...COLLS].map(c => {
    const on = flt.coll === c;
    const label = c === 'all' ? t('trade.coll.all') : collLabel(c);
    return `<button type="button" class="seg-btn act-coll-btn ${on ? 'is-active' : ''}" data-act="act-coll" data-c="${c}" aria-pressed="${on}">
      ${c === 'all' ? '' : collMark(c)}<span>${esc(label)}</span><span class="act-n">${counts[c]}</span></button>`;
  }).join('');
}

function kindChipsHtml() {
  const counts = new Map();
  for (const h of filtered('kind')) counts.set(h.kind, (counts.get(h.kind) || 0) + 1);
  // Only what this wallet has actually done, plus anything already picked.
  const all = new Set((mine()?.items || []).map(h => h.kind));
  return KINDS.filter(k => all.has(k) || flt.kinds.has(k)).map(k => {
    const on = flt.kinds.has(k);
    const n = counts.get(k) || 0;
    return `<button type="button" class="act-kind ${KIND_CLS[k]} ${on ? 'is-on' : ''}" data-act="act-kind" data-k="${k}"
      aria-pressed="${on}" ${n === 0 && !on ? 'disabled' : ''}>
      <span class="act-kind-dot" aria-hidden="true"></span>${esc(t(`trade.history.kind.${k}`))}<span class="act-n">${n}</span></button>`;
  }).join('');
}

function countHtml() {
  const a = mine();
  if (!a?.items?.length) return '';
  const n = filtered().length;
  if (!filtersOn()) return `<span class="act-count">${esc(String(a.items.length))}</span>`;
  return `<span class="act-count">${esc(t('trade.filter.invCount').replace('{n}', String(n)).replace('{total}', String(a.items.length)))}</span>
    <button type="button" class="trade-flt-clearall" data-act="act-clear">${esc(t('trade.filter.clear'))}</button>`;
}

function toolbarHtml() {
  if (!mine()?.items?.length) return '';
  return `
    <div class="act-bar">
      <div class="seg act-colls" id="act-colls" role="group" aria-label="${esc(t('trade.act.collAria'))}">${collSegHtml()}</div>
      <label class="trade-flt-search act-search">
        <svg class="trade-flt-sico" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input id="act-q" type="search" autocomplete="off" enterkeyhint="search" value="${esc(flt.q)}"
          placeholder="${esc(t('trade.act.search'))}" aria-label="${esc(t('trade.act.search'))}" />
      </label>
    </div>
    <div class="act-kinds" id="act-kinds" role="group" aria-label="${esc(t('trade.act.kindsAria'))}">${kindChipsHtml()}</div>`;
}

/* Everything the painted section depends on, as one string. When it has not changed, the
   section already on the page is the section that would be painted, and the dashboard keeps
   it through its own rewrites rather than replaying every row's entrance. */
function signature() {
  const a = mine();
  const state = !a ? 'none' : a.items === null ? (a.loading ? 'loading' : 'empty') : `${a.at}:${JSON.stringify(a.failed)}`;
  return [account, state, flt.coll, [...flt.kinds].sort().join(','), flt.q, shown, currency, t('trade.history.h')].join('|');
}

/** The whole section, as the dashboard paints it. */
export function activityHtml() {
  const a = mine();
  const anim = a && a.at && enteredAt !== a.at ? 'enter' : 'still';
  if (anim === 'enter' && a?.items) enteredAt = a.at;
  return `
    <section class="trade-dash-sec act${a?.loading && a.items ? ' is-refreshing' : ''}" id="trade-act" data-sig="${esc(signature())}"
      aria-labelledby="act-h" aria-busy="${a?.loading ? 'true' : 'false'}">
      <div class="act-head">
        <h4 class="trade-dash-h" id="act-h">${esc(t('trade.history.h'))}</h4>
        <div class="act-counts" id="act-counts" role="status">${countHtml()}</div>
      </div>
      ${toolbarHtml()}
      <div id="act-list">${listHtml(anim)}</div>
    </section>`;
}

// --- Repainting -----------------------------------------------------------------------------

/** Replace the whole section when what it shows has changed. */
function patchActivity() {
  if (!onDash()) return;
  const el = root()?.querySelector('#trade-act');
  if (!el || el.dataset.sig === signature()) return;
  const hadFocus = el.contains(document.activeElement);
  try { el.outerHTML = activityHtml(); } catch (err) { console.error('Activity failed to paint:', err); return; }
  if (hadFocus) root()?.querySelector('#act-q')?.focus();
}

/**
 * The filters moved: repaint the counts, the chips and the rows, and leave the search box
 * alone so it keeps its focus and caret. Rows that replace rows fade in rather than making
 * an entrance; "Show more" gives only the new rows one.
 */
function patchResults({ anim = 'swap', enterFrom = 0 } = {}) {
  const el = root()?.querySelector('#trade-act');
  if (!el) return;
  const set = (sel, html) => { const n = el.querySelector(sel); if (n) n.innerHTML = html; };
  set('#act-counts', countHtml());
  set('#act-colls', collSegHtml());
  set('#act-kinds', kindChipsHtml());
  set('#act-list', listHtml(anim, enterFrom));
  el.dataset.sig = signature();
}

/** Before the dashboard is rewritten: the live section, if it is still the right one. */
export function holdActivity() {
  const el = root()?.querySelector('#trade-act');
  if (!el || el.dataset.sig !== signature()) return null;
  const input = el.querySelector('#act-q');
  const focus = input && document.activeElement === input
    ? { start: input.selectionStart, end: input.selectionEnd } : null;
  return { el, focus };
}

/** After the dashboard is rewritten: put the kept section back, focus and caret included. */
export function mountActivity(kept) {
  const fresh = root()?.querySelector('#trade-act');
  if (!fresh || !kept?.el || kept.el === fresh || kept.el.dataset.sig !== fresh.dataset.sig) return;
  fresh.replaceWith(kept.el);
  if (kept.focus) {
    const input = kept.el.querySelector('#act-q');
    input?.focus();
    try { input?.setSelectionRange(kept.focus.start, kept.focus.end); } catch { /* search inputs may refuse */ }
  }
}

// --- Events ---------------------------------------------------------------------------------

/** The section's own clicks. Returns true when it handled one. */
export function onActivityClick(act_, target) {
  switch (act_) {
    case 'act-coll': {
      const c = target.dataset.c;
      if (!['all', ...COLLS].includes(c) || c === flt.coll) return true;
      flt.coll = c; shown = ACT_PAGE;
      patchResults();
      return true;
    }
    case 'act-kind': {
      const k = target.dataset.k;
      if (!KINDS.includes(k)) return true;
      if (flt.kinds.has(k)) flt.kinds.delete(k); else flt.kinds.add(k);
      shown = ACT_PAGE;
      patchResults();
      return true;
    }
    case 'act-clear': {
      flt = { coll: 'all', kinds: new Set(), q: '' }; shown = ACT_PAGE;
      const q = root()?.querySelector('#act-q'); if (q) q.value = '';
      patchResults();
      return true;
    }
    case 'act-more': {
      const from = shown;
      shown += ACT_PAGE;
      patchResults({ anim: 'enter', enterFrom: from });
      // Keep the reader's place: the button they pressed is gone, so focus the first new row.
      const rows = root()?.querySelectorAll('#act-list .act-open');
      rows?.[from]?.focus({ preventScroll: true });
      return true;
    }
    case 'act-retry': refreshActivity(); return true;
    default: return false;
  }
}

/** Typing in the search box. Returns true when the event was ours. */
export function onActivityInput(e) {
  if (e.target?.id !== 'act-q') return false;
  flt.q = e.target.value.trim();
  shown = ACT_PAGE;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => patchResults(), SEARCH_DEBOUNCE_MS);
  return true;
}
