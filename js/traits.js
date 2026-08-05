import { t, getCurrentLang } from './i18n.js';

// Creature Traits — the Collections tab's second view, beside the release archive.
//
// The archive answers "what did the club put out"; this answers "what are the Creatures
// made of". Every Eyes, Hair, Outfit and Aura in the collection, grouped by slot, each with
// how many Creatures wear it, how many are for sale right now, and a way straight into the
// marketplace filtered to it. The club asked for it so trait hunting stops meaning scrolling
// 11,111 tokens, and the same view will carry Gen 2's traits the day that collection is
// indexed — nothing here is hand-maintained.
//
// No trait has art of its own anywhere, so a tile is a crop of a real Creature that wears
// it. /api/market/creatures/traits picks the Creature (the plainest wearer, so nothing
// crowds the trait) and hands over the window for each slot; tools/build-trait-art.py bakes
// those crops to img/traits so a grid of hundreds of tiles costs a few hundred KB instead of
// hundreds of MB. A trait with no baked tile falls back to framing the full render live.

let data = null;
let ready = false;          // a good payload has landed and the grid is on screen
let retry = null;           // pending re-check while the server is still cataloguing

// Head to toe, because that's how you'd describe a face — not alphabetical, and not by how
// many traits each slot holds. Anything the API adds later lands after these, in its own order.
const SLOTS = ['Eyes', 'Mouth', 'Nose', 'Ears', 'Hair', 'Head Accessory', 'Glasses',
  'Face Accessory', 'Outfit', 'Body', 'Body Accessory', 'Aura', 'Background Color'];
// Garment slots (kind 'item') are the Outfit trait broken into the pieces it's made of. They sit
// behind their own chips rather than in "every slot": showing both a look and its four garments at
// once would say the same thing twice, and the count of real traits would stop meaning anything.
const RENDER_PX = 666;      // every Creature render is this square
const SALES_SHOWN = 4;      // recent sales listed in the inspect card

// UI state
let slot = '';              // '' = every slot, grouped
let query = '';
let sort = 'rare';          // rare | common | az | sale
let saleOnly = false;

// Sales per trait, fetched when its card opens: key -> 'loading' | [] | [{…}]
const salesCache = new Map();
let salesTimer = null;      // debounce, so arrowing through a slot doesn't fetch every trait

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function num(n) {
  return new Intl.NumberFormat(getCurrentLang()).format(n);
}

// 0.0037 → "0.37%", 0.996 → "99.6%" — the share of the collection wearing a trait. Tiny
// shares are the interesting ones here, so they keep the digits that say how tiny; a decimal
// stays on the big end too, because 43 Creatures carry no traits at all and rounding a slot
// everything else wears to a flat "100%" would quietly write them out.
function pct(share) {
  const digits = share < 0.001 ? 3 : share < 0.01 ? 2 : 1;
  return new Intl.NumberFormat(getCurrentLang(),
    { style: 'percent', maximumFractionDigits: digits }).format(share);
}

function eth(v) {
  return `${new Intl.NumberFormat(getCurrentLang(), { maximumFractionDigits: 4 }).format(v)} ETH`;
}

function usd(v) {
  return new Intl.NumberFormat(getCurrentLang(), { style: 'currency', currency: 'USD',
    maximumFractionDigits: v < 100 ? 2 : 0 }).format(v);
}

function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  return new Intl.DateTimeFormat(getCurrentLang(), { day: 'numeric', month: 'short' }).format(d);
}

/* ------------------------------------------------------------------- loading */

export async function loadTraits() {
  const box = document.getElementById('traits-app');
  try {
    const res = await fetch('/api/market/creatures/traits');
    if (!res.ok) throw new Error();
    data = await res.json();
    if (data.indexing) throw new Error('indexing');
  } catch (err) {
    const indexing = err?.message === 'indexing';
    ready = false;
    if (box) {
      box.setAttribute('aria-busy', 'false');
      box.innerHTML = `<div class="col-empty"><span class="col-empty-ico" aria-hidden="true">🧬</span>
        <p>${esc(t(indexing ? 'ctr.indexing' : 'ctr.error'))}</p></div>`;
    }
    // A freshly booted server is still sweeping the collection, and that finishes in a minute
    // or two. Check back on its own rather than leaving the page on a dead end nobody knows
    // to reload.
    if (indexing && !retry) retry = setTimeout(() => { retry = null; loadTraits(); }, 20000);
    return;
  }
  clearTimeout(retry);
  retry = null;
  ready = true;
  render();
}

export function rerenderTraits() { if (ready) render(); }

/* ----------------------------------------------------------------- filtering */

// Slots in reading order, with anything unexpected appended rather than dropped.
function slots() {
  if (!data?.types) return [];
  const traits = data.types.filter(ty => ty.kind !== 'item');
  const known = SLOTS.map(s => traits.find(ty => ty.type === s)).filter(Boolean);
  const rest = traits.filter(ty => !SLOTS.includes(ty.type));
  return [...known, ...rest];
}

// The garment slots, in the order the API sent them (head to toe).
function garments() {
  return data?.types?.filter(ty => ty.kind === 'item') || [];
}

function typeOf(name) {
  return data?.types?.find(ty => ty.type === name) || null;
}

// A slot's label: the API names garment slots itself ("Tops"), traits carry the collection's own
// English, and both fall back to what came over the wire.
function slotName(type) {
  const ty = typeOf(type);
  const key = `ctr.slot.${type.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const label = t(key);
  if (label !== key) return label;
  return ty?.label || type;
}

const SORTS = {
  rare:   (a, b) => a.val.n - b.val.n || a.val.v.localeCompare(b.val.v),
  common: (a, b) => b.val.n - a.val.n || a.val.v.localeCompare(b.val.v),
  az:     (a, b) => a.val.v.localeCompare(b.val.v),
  sale:   (a, b) => (b.val.listed - a.val.listed)
    || ((a.val.floorEth ?? Infinity) - (b.val.floorEth ?? Infinity))
    || a.val.n - b.val.n,
};

// Every visible trait, flattened, carrying its slot and its place in the payload so a tile
// can point back at the exact row however the list is sorted. The order here IS the order on
// screen, slot blocks included — the grid walks this list and the inspect card's arrow keys
// step along it, so the two can never disagree about what comes next.
function visible() {
  const shown = slot ? [typeOf(slot)].filter(Boolean) : slots();
  const out = [];
  shown.forEach(ty => {
    const ti = data.types.indexOf(ty);
    ty.values.forEach((val, vi) => {
      if (saleOnly && !val.listed) return;
      if (query && !val.v.toLowerCase().includes(query)
          && !slotName(ty.type).toLowerCase().includes(query)) return;
      out.push({ ty, val, ti, vi });
    });
  });
  const cmp = SORTS[sort] || SORTS.rare;
  if (slot) return out.sort(cmp);
  const order = new Map(shown.map((ty, i) => [ty.type, i]));
  return out.sort((a, b) => order.get(a.ty.type) - order.get(b.ty.type) || cmp(a, b));
}

/* -------------------------------------------------------------------- pieces */

// The stat band, chips, search box and empty state are the archive's own (.col-*). Both
// views live in the same tab, so they should read as one page rather than two designs — and
// borrowing them means one place to change the look, and motion safety for free.
function statTiles() {
  // Counts the traits only. The garment slots are the Outfit trait taken apart, not more traits,
  // and folding them in would inflate the number the collection is actually described by.
  const tiles = [
    { k: 'traits',    raw: slots().reduce((s, ty) => s + ty.count, 0) },
    { k: 'slots',     raw: slots().length },
    { k: 'creatures', raw: data.total },
    { k: 'listed',    raw: data.listedTotal },
  ];
  return `<div class="col-stats">${tiles.map((tile, i) => `
    <div class="col-stat col-reveal" style="--d:${i * 60}ms">
      <span class="col-stat-v" data-count="${tile.raw}">${esc(num(tile.raw))}</span>
      <span class="col-stat-k">${esc(t(`ctr.stat.${tile.k}`))}</span>
    </div>`).join('')}</div>`;
}

function chip(ty) {
  const on = slot === ty.type;
  return `<button class="col-chip${on ? ' is-on' : ''}" type="button" data-slot="${esc(ty.type)}" aria-pressed="${on}">
    <span>${esc(slotName(ty.type))}</span>
    <span class="col-chip-n">${num(ty.count)}</span>
  </button>`;
}

function controls() {
  const allOn = !slot;
  const sorts = ['rare', 'common', 'az', 'sale'];
  const pieces = garments();
  return `
  <div class="col-controls">
    <div class="col-chips" role="group" aria-label="${esc(t('ctr.a11y.slots'))}">
      <button class="col-chip is-all${allOn ? ' is-on' : ''}" type="button" data-slot="" aria-pressed="${allOn}">
        <span>${esc(t('ctr.slot.all'))}</span>
        <span class="col-chip-n">${num(slots().reduce((s, ty) => s + ty.count, 0))}</span>
      </button>
      ${slots().map(chip).join('')}
      ${pieces.length ? `<span class="ctr-chip-sep" aria-hidden="true"></span>
        <span class="ctr-chip-lbl">${esc(t('ctr.pieces'))}</span>
        ${pieces.map(chip).join('')}` : ''}
    </div>
    <div class="col-tools">
      <div class="col-search">
        <span class="col-search-ico" aria-hidden="true">🔍</span>
        <input type="search" id="ctr-q" class="col-search-in" value="${esc(query)}"
          placeholder="${esc(t('ctr.search.ph'))}" aria-label="${esc(t('ctr.a11y.search'))}">
      </div>
      <button class="ctr-toggle${saleOnly ? ' is-on' : ''}" type="button" id="ctr-sale" aria-pressed="${saleOnly}">
        <span class="ctr-toggle-dot" aria-hidden="true"></span>
        <span>${esc(t('ctr.saleOnly'))}</span>
      </button>
      <label class="ctr-sortwrap">
        <span class="ctr-sortlbl">${esc(t('ctr.sort.label'))}</span>
        <select class="ctr-sort" id="ctr-sort" aria-label="${esc(t('ctr.sort.label'))}">
          ${sorts.map(s => `<option value="${s}"${s === sort ? ' selected' : ''}>${esc(t(`ctr.sort.${s}`))}</option>`).join('')}
        </select>
      </label>
    </div>
  </div>`;
}

// Blow the slot's window up to fill the square tile and pull its centre onto the tile's.
// The render is square and so is the window, so scaling both axes together can't stretch
// anything. No window means the trait isn't in one place (an aura wraps the whole body), so
// the render shows whole.
function frameStyle(frame) {
  if (!frame) return '';
  const [cx, cy, side] = frame;
  const scale = (RENDER_PX / side) * 100;
  return `width:${scale.toFixed(2)}%;height:${scale.toFixed(2)}%;left:50%;top:50%;transform:translate(` +
         `${(-cx / RENDER_PX * 100).toFixed(2)}%,${(-cy / RENDER_PX * 100).toFixed(2)}%)`;
}

// The trait's picture: its baked crop where the build made one, else the full render framed
// live. Both land in the same square, so the grid stays even either way.
function traitShot(ty, val, { lazy = true } = {}) {
  const attrs = `alt=""${lazy ? ' loading="lazy"' : ''} decoding="async"`;
  if (val.art) {
    // `art` is a hash of the tile's own bytes, so the URL names nothing and the server caches
    // it forever — the same deal as the release archive's pictures, out of the same route.
    return `<span class="ctr-shot"><img src="/api/collections/art/trait/${
      encodeURIComponent(val.art)}.webp" ${attrs}></span>`;
  }
  if (!val.image) return `<span class="ctr-shot is-empty"><span aria-hidden="true">?</span></span>`;
  const style = frameStyle(ty.frame);
  return `<span class="ctr-shot${style ? ' is-framed' : ''}">
    <img src="${esc(val.image)}" ${attrs}${style ? ` style="${style}"` : ''}></span>`;
}

// How rare this one is inside its own slot, as a bar. Log-scaled because supply spans three
// orders of magnitude — a 3-copy trait and a 3,000-copy one would otherwise both sit at an
// end with everything else piled against them. The slot's range is worked out once per slot,
// not once per tile.
const scarcitySpan = new WeakMap();
function scarcityBar(ty, val) {
  let span = scarcitySpan.get(ty);
  if (!span) {
    const counts = ty.values.map(v => v.n);
    span = [Math.log(Math.min(...counts)), Math.log(Math.max(...counts))];
    scarcitySpan.set(ty, span);
  }
  const [lo, hi] = span;
  const f = hi > lo ? 1 - (Math.log(val.n) - lo) / (hi - lo) : 1;
  return `<span class="ctr-bar" aria-hidden="true"><i style="width:${(f * 100).toFixed(1)}%"></i></span>`;
}

function tile(entry, i) {
  const { ty, val, ti, vi } = entry;
  const share = data.total ? val.n / data.total : 0;
  return `
  <button class="ctr-tile col-reveal" type="button" data-ti="${ti}" data-vi="${vi}"
    style="--d:${Math.min(i, 12) * 35}ms">
    <span class="ctr-fig">
      ${traitShot(ty, val)}
      ${val.listed ? `<span class="ctr-onsale">${esc(t('ctr.tile.sale').replace('{n}', num(val.listed)))}</span>` : ''}
    </span>
    <span class="ctr-cap">
      <span class="ctr-name" title="${esc(val.v)}">${esc(val.v)}</span>
      <span class="ctr-meta">
        <span class="ctr-n"><b>${num(val.n)}</b> ${esc(t('ctr.tile.wearers'))}</span>
        <span class="ctr-pct">${esc(pct(share))}</span>
      </span>
      ${scarcityBar(ty, val)}
    </span>
  </button>`;
}

// The garments an Outfit is made of, as a strip of small tiles under its stats. This is the whole
// point of the breakdown: a look called "Super Belted Trench Dress Outfit" is a trench dress, a
// pair of clogs, fishnet socks and undies, and until now the card showed one crop and said nothing
// about any of them.
function piecesHtml(val) {
  if (!val.items?.length) return '';
  return `<div class="ctr-pieces">
    <span class="ctr-pieces-h">${esc(t('ctr.insp.pieces').replace('{n}', num(val.items.length)))}</span>
    <div class="ctr-pieces-row">${val.items.map(pieceHtml).join('')}</div>
  </div>`;
}

// A garment has a slot of its own, so its tile opens it. A 1/1 character's bespoke parts — eyes,
// mouth, horns, aura — have none: their tokens never carried those attributes, so the collection
// has no trait to browse. Those are shown and not clickable, rather than a button that goes
// nowhere.
function pieceHtml(x) {
  const jump = !!typeOf(x.c);
  const tag = jump ? 'button' : 'span';
  return `<${tag} class="ctr-piece${jump ? '' : ' is-static'}" title="${esc(x.n)}"${jump
    ? ` type="button" data-piece="${esc(x.c)}" data-piece-v="${esc(x.n)}"` : ''}>
    <span class="ctr-shot">${x.art
      ? `<img src="/api/collections/art/trait/${encodeURIComponent(x.art)}.webp" alt="" loading="lazy" decoding="async">`
      : '<span class="ctr-piece-none" aria-hidden="true">?</span>'}</span>
    <span class="ctr-piece-n">${esc(x.n)}</span>
    <span class="ctr-piece-c">${esc(slotName(x.c))}</span>
  </${tag}>`;
}

// One block per slot when browsing everything, so the grid reads as a face rather than a
// heap. A single chosen slot needs no header — the chip already says which. The heading
// counts what's showing, not what the slot holds, so a search never claims 63 tiles above 3.
function groupHead(ty, shown) {
  const worn = data.total ? ty.worn / data.total : 0;
  return `<section class="ctr-group">
    <header class="ctr-group-h">
      <h3 class="ctr-group-t">${esc(slotName(ty.type))}</h3>
      <p class="ctr-group-m">${esc(t(ty.kind === 'item' ? 'ctr.group.pieces' : 'ctr.group.meta')
        .replace('{n}', num(shown)).replace('{pct}', pct(worn)))}</p>
      <span class="ctr-group-rule"></span>
    </header>
    <div class="ctr-grid">`;
}

function grid(list) {
  if (!list.length) {
    return `<div class="col-empty"><span class="col-empty-ico" aria-hidden="true">🔍</span>
      <p>${esc(t('ctr.none'))}</p>
      <button class="col-reset" type="button" id="ctr-reset">${esc(t('ctr.reset'))}</button></div>`;
  }
  if (slot) {
    return `<div class="ctr-groups"><div class="ctr-grid">${list.map(tile).join('')}</div></div>`;
  }
  const shown = new Map();
  list.forEach(e => shown.set(e.ty, (shown.get(e.ty) || 0) + 1));
  let html = '<div class="ctr-groups">';
  let open = null;
  list.forEach((e, i) => {
    if (e.ty !== open) {
      if (open) html += '</div></section>';
      open = e.ty;
      html += groupHead(e.ty, shown.get(e.ty));
    }
    html += tile(e, i);
  });
  return `${html}</div></section></div>`;
}

/* -------------------------------------------------------------------- render */

function render() {
  const box = document.getElementById('traits-app');
  if (!box) return;
  box.setAttribute('aria-busy', 'false');
  box.innerHTML = statTiles() + controls() + grid(visible());
  wire(box);
  countUp(box);
  reveal(box);
}

// Re-render only the grid, so typing in the search box keeps focus and caret.
function renderGrid() {
  const box = document.getElementById('traits-app');
  const old = box?.querySelector('.ctr-groups, .col-empty');
  if (!box || !old) { render(); return; }
  const holder = document.createElement('div');
  holder.innerHTML = grid(visible());
  old.replaceWith(holder.firstElementChild);
  wire(box);
  reveal(box);
}

function wire(box) {
  box.querySelectorAll('[data-slot]').forEach(chip => {
    if (chip.dataset.wired) return;
    chip.dataset.wired = '1';
    chip.addEventListener('click', () => { slot = chip.dataset.slot; render(); });
  });

  const q = box.querySelector('#ctr-q');
  if (q && !q.dataset.wired) {
    q.dataset.wired = '1';
    let timer;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { query = q.value.trim().toLowerCase(); renderGrid(); }, 160);
    });
  }

  const s = box.querySelector('#ctr-sort');
  if (s && !s.dataset.wired) {
    s.dataset.wired = '1';
    s.addEventListener('change', () => { sort = s.value; renderGrid(); });
  }

  const sale = box.querySelector('#ctr-sale');
  if (sale && !sale.dataset.wired) {
    sale.dataset.wired = '1';
    sale.addEventListener('click', () => { saleOnly = !saleOnly; render(); });
  }

  box.querySelector('#ctr-reset')?.addEventListener('click', () => {
    slot = ''; query = ''; saleOnly = false; render();
  });

  // One delegated listener covers every tile, including the ones a re-sort builds later.
  if (!box.dataset.inspectWired) {
    box.dataset.inspectWired = '1';
    box.addEventListener('click', e => {
      const el = e.target.closest('[data-ti]');
      if (el) openInspect(Number(el.dataset.ti), Number(el.dataset.vi));
    });
  }
}

// Count the stat numbers up once, on first paint.
function countUp(box) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  box.querySelectorAll('.col-stat-v').forEach(el => {
    const target = Number(el.dataset.count);
    if (!target) return;
    const t0 = performance.now();
    function step(now) {
      const p = Math.min(1, (now - t0) / 900);
      el.textContent = num(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

// Stagger tiles in as they scroll into view. The enormous top rootMargin is deliberate and
// the reasoning is spelled out on the same trick in js/collections.js.
function reveal(box) {
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-in');
      obs.unobserve(e.target);
    });
  }, { rootMargin: '100000px 0px 0px 0px' });
  box.querySelectorAll('.col-reveal:not(.is-in)').forEach(el => io.observe(el));
}

/* -------------------------------------------------------------- inspect card */

// Click a trait to open it: the crop blown up, the Creature it was framed from, what the
// trait is worth right now, its last few sales, and two ways into the marketplace with the
// filter already applied. Arrow keys walk the rest of the list without closing.
let inspecting = null;   // { ti, vi }

function inspectDialog() {
  let dlg = document.getElementById('ctr-inspect');
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.id = 'ctr-inspect';
  dlg.className = 'ctr-modal';
  dlg.setAttribute('aria-labelledby', 'ctr-modal-h');
  document.body.appendChild(dlg);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  // Arrow keys walk the list. The listener sits on the document, not the dialog: every step
  // re-renders the card's innerHTML, which destroys the focused button and drops focus back
  // to the body, so a dialog-scoped handler goes quiet after the first click of ‹ or ›.
  document.addEventListener('keydown', e => {
    if (!dlg.open) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); stepInspect(1); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); stepInspect(-1); }
  });
  dlg.addEventListener('close', () => { inspecting = null; clearTimeout(salesTimer); });
  return dlg;
}

// Step through what's on screen, in the order it's on screen — not through the payload.
function stepInspect(delta) {
  if (!inspecting) return;
  const list = visible();
  const at = list.findIndex(e => e.ti === inspecting.ti && e.vi === inspecting.vi);
  if (at < 0) return;
  const next = list[(at + delta + list.length) % list.length];
  openInspect(next.ti, next.vi);
}

// Where the marketplace opens with this trait already picked. `scope=all` shows every
// Creature wearing it; without it Browse stays on what's listed. A garment has no trait of its
// own to filter on, so it hands over the outfit it belongs to — which selects exactly the same
// Creatures, since a piece appears in one look and nowhere else.
function tradeLink(ty, val, all) {
  const filter = ty.kind === 'item' ? `Outfit:${val.of}` : `${ty.type}:${val.v}`;
  const p = new URLSearchParams({ coll: 'creatures', t: filter });
  if (all) p.set('scope', 'all');
  return `/trade?${p}`;
}

// The key the sales feed is asked for: a garment borrows its outfit's, same reasoning as above.
function salesKey(ty, val) {
  return ty.kind === 'item' ? `Outfit:${val.of}` : `${ty.type}:${val.v}`;
}

// Jump from a piece back to the slot it lives in, with it open.
function openPiece(category, value) {
  const ti = data.types.findIndex(t => t.type === category);
  if (ti < 0) return;
  const vi = data.types[ti].values.findIndex(v => v.v === value);
  if (vi < 0) return;
  slot = category;
  render();
  openInspect(ti, vi);
}

// Nothing cached yet reads the same as in flight — the request is coming, so show the
// spinner. Only an answered request can leave the block empty, and that answer is [].
function salesHtml(ty, val) {
  const rows = salesCache.get(salesKey(ty, val));
  if (!rows || rows === 'loading') return `<div class="ctr-sales is-loading"><div class="apply-spinner"></div></div>`;
  if (!rows.length) return `<p class="ctr-sales-none">${esc(t('ctr.insp.nosales'))}</p>`;
  return `<div class="ctr-sales">
    <span class="ctr-sales-h">${esc(t('ctr.insp.sales'))}</span>
    ${rows.slice(0, SALES_SHOWN).map(s => `
      <a class="ctr-sale-row" href="/trade?coll=creatures&amp;token=${encodeURIComponent(s.tokenId)}">
        <span class="ctr-sale-n">${esc(s.name)}</span>
        <span class="ctr-sale-p">${esc(s.currency === 'usdc' ? usd(s.priceAmt) : eth(s.priceAmt))}</span>
        <span class="ctr-sale-d">${esc(shortDate(s.at))}</span>
      </a>`).join('')}
  </div>`;
}

// The trait's own sales, once — the same feed the marketplace's Sales History tab runs on,
// asked for one trait at a time. Swaps just the sales block when they land, and only if the
// card is still showing this trait: re-rendering the whole card instead would drop focus out
// of the dialog (innerHTML replaces the focused button) and the arrow keys would go dead.
async function loadSales(ti, vi) {
  const ty = data.types[ti];
  const val = ty.values[vi];
  const key = salesKey(ty, val);
  if (salesCache.has(key)) return;
  salesCache.set(key, 'loading');
  try {
    const res = await fetch(`/api/market/creatures/sales?t=${encodeURIComponent(key)}`);
    if (!res.ok) throw new Error();
    const body = await res.json();
    salesCache.set(key, Array.isArray(body.items) ? body.items : []);
  } catch {
    salesCache.set(key, []);   // no history to show is the same outcome for the reader
  }
  if (!inspecting || inspecting.ti !== ti || inspecting.vi !== vi) return;
  const wrap = document.querySelector('#ctr-inspect .ctr-sales-wrap');
  if (wrap) wrap.innerHTML = salesHtml(ty, val);
}

function openInspect(ti, vi) {
  const ty = data.types[ti];
  const val = ty?.values[vi];
  if (!val) return;
  const dlg = inspectDialog();
  inspecting = { ti, vi };
  // Hold the sales request until the card has settled on this trait. Holding an arrow key
  // down would otherwise fire one per trait walked past, and the market API's per-IP budget
  // is 90 a minute — a fast walk through a 64-trait slot would spend most of it on cards
  // nobody stopped to read.
  clearTimeout(salesTimer);
  salesTimer = setTimeout(() => loadSales(ti, vi), 300);
  const share = data.total ? val.n / data.total : 0;
  const usdFloor = val.floorEth != null && data.ethUsd ? val.floorEth * data.ethUsd : null;

  const rows = [
    // A garment leads with the look it belongs to: that's the thing the collection actually
    // records, and the only handle the marketplace can filter on.
    ty.kind === 'item' && val.of
      ? [t('ctr.insp.partof'), `<b>${esc(val.of)}</b>`] : null,
    ty.kind === 'item' && val.r
      ? [t('ctr.insp.rarityOf'), esc(t(`ctr.rarity.${val.r}`))] : null,
    [t('ctr.insp.wearers'), `<b>${num(val.n)}</b> <span class="ctr-insp-sub">${
      esc(t('ctr.insp.ofTotal').replace('{total}', num(data.total)))}</span>`],
    [t('ctr.insp.share'), `<b>${esc(pct(share))}</b>`],
    [t('ctr.insp.forsale'), val.listed
      ? `<b>${num(val.listed)}</b>` : `<span class="ctr-insp-dim">${esc(t('ctr.insp.nonelisted'))}</span>`],
    val.floorEth != null
      ? [t('ctr.insp.floor'), `<b>${esc(eth(val.floorEth))}</b>${
        usdFloor ? `<span class="ctr-insp-sub">≈ ${esc(usd(usdFloor))}</span>` : ''}`]
      : null,
  ].filter(Boolean);

  dlg.innerHTML = `
    <div class="ctr-insp">
      <span class="ctr-insp-glow" aria-hidden="true"></span>
      <button class="ctr-insp-x" type="button" data-close aria-label="${esc(t('ctr.insp.close'))}">✕</button>
      <div class="ctr-insp-stage">
        ${traitShot(ty, val, { lazy: false })}
      </div>
      <div class="ctr-insp-body">
        <span class="ctr-insp-slot">${esc(slotName(ty.type))}</span>
        <h3 class="ctr-insp-h" id="ctr-modal-h">${esc(val.v)}</h3>
        <dl class="ctr-insp-dl">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
        ${piecesHtml(val)}
        <div class="ctr-sales-wrap">${salesHtml(ty, val)}</div>
        <div class="ctr-insp-cta">
          ${val.listed ? `<a class="ctr-btn is-primary" href="${tradeLink(ty, val, false)}">${
            esc(t('ctr.insp.cta.sale').replace('{n}', num(val.listed)))}</a>` : ''}
          <a class="ctr-btn" href="${tradeLink(ty, val, true)}">${esc(t('ctr.insp.cta.all'))}</a>
        </div>
        <div class="ctr-insp-nav">
          <button class="ctr-insp-step" type="button" data-step="-1" aria-label="${esc(t('ctr.insp.prev'))}">‹</button>
          <span class="ctr-insp-count">${esc(t('ctr.insp.rank')
            .replace('{n}', num(ty.values.indexOf(val) + 1)).replace('{total}', num(ty.count)))}</span>
          <button class="ctr-insp-step" type="button" data-step="1" aria-label="${esc(t('ctr.insp.next'))}">›</button>
        </div>
      </div>
    </div>`;

  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('[data-step]').forEach(b =>
    b.addEventListener('click', () => stepInspect(Number(b.dataset.step))));
  dlg.querySelectorAll('[data-piece]').forEach(b =>
    b.addEventListener('click', () => openPiece(b.dataset.piece, b.dataset.pieceV)));
  if (!dlg.open) dlg.showModal();
}
