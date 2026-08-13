import { t } from './i18n.js';

// Public holder profile — the opt-in collection showcase, rendered INSIDE the
// marketplace (js/marketplace.js owns the #profile-app container and calls
// loadProfile when its profile view opens; /profile/{slug} deep links land there).
//
// Identity (name, avatar, wallet, counts) comes from /api/profile/{slug}; the
// holdings grid reuses the public marketplace browse endpoints in wallet mode
// (?q=<address>), so "Listed for sale" vs "All assets" is the same scope toggle
// the Trade tab already has. Everything here is public-by-consent: the server
// only answers for holders who turned their profile on, and a disabled profile
// 404s on the very next load.
//
// In-view navigation (the rental warning's "true owner" link, the 404 browse CTA)
// is dispatched as custom events — marketplace.js listens and swaps the view;
// importing it here would be a module cycle.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const root = () => document.getElementById('profile-app');

// --- state ---
let slug = null;        // slug this panel currently shows
let data = null;        // identity payload, or 'notfound' after a 404
let identityLoading = false;

let coll = 'creatures'; // 'creatures' | 'land'
let scope = 'all';      // 'all' (default: it's a showcase) | 'listed'
let walletFilter = 'all'; // 'all' (union of every wallet) | a specific wallet address
let items = [];
let page = 0;
let hasMore = false;
let ownedTotal = null;  // total holdings in this collection (pre-filter, across the selection)
let ownedListed = null; // how many of those are listed for sale
let gridLoading = false;
let gridError = false;
let gridIndexing = false; // server catalogues still warming (traits/names incomplete)
let indexingTimer = null; // quiet re-poll while gridIndexing
let reqId = 0;          // guards a slow stale response against a newer view
let delegated = false;

// --- filters (mirror the marketplace Browse filters; same server params + facets) ---
// The profile hits the same /browse endpoint, which already accepts min/max/t/sort and
// returns facets + priceRange — the showcase just filters within one holder's collection.
let flt = { min: '', max: '', traits: new Map(), sort: 'rarity' };
let facets = null;       // [{type, values:[{v,n,pct}]}] from the last response, or null
let priceRange = null;   // {min,max} across the shown selection
let openFacet = null;    // which trait dropdown is expanded
let fltSheetOpen = false; // mobile filter sheet
let fltDebounce = null;

// Creatures only come in two tiers — Legendary and Epic. (Rare/Uncommon/Common never
// existed in the collection; listing them just showed permanently-disabled chips.)
const RARITY_TIERS = ['Legendary', 'Epic'];
const TIER_VALUES = ['Standard', 'Premium'];

function fmtTraitPct(p) {
  if (p == null || !Number.isFinite(Number(p))) return '';
  const v = Number(p) * 100;
  if (v > 0 && v < 0.1) return '<0.1%';
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}
function traitSelected(type, v) { return flt.traits.get(type)?.has(v) || false; }
function toggleTrait(type, v) {
  const cur = flt.traits.get(type) || new Set();
  if (cur.has(v)) cur.delete(v); else cur.add(v);
  if (cur.size) flt.traits.set(type, cur); else flt.traits.delete(type);
}
function fltActive() { return !!(flt.min || flt.max || flt.traits.size); }
function fltCount() {
  let n = (flt.min ? 1 : 0) + (flt.max ? 1 : 0);
  for (const vals of flt.traits.values()) n += vals.size;
  return n;
}
function resetFilters() {
  flt.min = ''; flt.max = ''; flt.traits = new Map();
  openFacet = null;
}

// Every showcase wallet the profile exposes, [{wallet, highriseLinked, verified, verifiedElsewhere}].
// Falls back to the single primary wallet for profiles created before multi-wallet shipped.
function profileWallets() {
  if (data && data !== 'notfound' && Array.isArray(data.wallets) && data.wallets.length) return data.wallets;
  return data && data.wallet ? [{ wallet: data.wallet, highriseLinked: true, verified: false }] : [];
}
// A wallet's short filter-chip label: Highrise anchor by name, others by short address.
function sourceLabel(w) {
  return w.highriseLinked ? t('profile.walletHighrise') : shortWallet(w.wallet);
}
// Trust tier for a wallet → { key, label, tone } for the per-tile / per-chip badge.
function walletTrust(w) {
  if (w.verified) return { key: 'verified', label: t('profile.trustVerified'), tone: 'verified' };
  if (w.verifiedElsewhere) return { key: 'elsewhere', label: t('profile.trustElsewhere'), tone: 'warn' };
  return { key: 'linked', label: t('profile.trustLinked'), tone: 'linked' };
}
function walletByAddr(addr) {
  return profileWallets().find(w => String(w.wallet).toLowerCase() === String(addr || '').toLowerCase()) || null;
}

const PAGE_URL = () => `${location.origin}/profile/${slug}`;

// --- data ---

async function fetchIdentity() {
  identityLoading = true;
  render();
  try {
    const res = await fetch(`/api/profile/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json' } });
    data = res.ok ? await res.json() : 'notfound';
  } catch {
    data = 'notfound';
  } finally {
    identityLoading = false;
  }
  render();
  if (data && data !== 'notfound') loadHoldings(true);
}

async function loadHoldings(reset = true, opts = {}) {
  if (!data || data === 'notfound' || !profileWallets().length) return;
  if (!reset && (!hasMore || gridLoading)) return;
  const p = reset ? 0 : page + 1;
  // quiet: refresh in place (the indexing re-poll) — keep the current tiles up instead
  // of flashing skeletons; the response replaces them wholesale.
  if (reset) { page = 0; hasMore = false; gridError = false; if (!opts.quiet) items = []; }
  const rid = ++reqId;
  gridLoading = true;
  patchGrid();
  try {
    const api = coll === 'land' ? '/api/market/land/browse' : '/api/market/creatures/browse';
    // "All wallets" resolves server-side to the union of the profile's wallets (via the
    // slug); a specific filter narrows to one wallet address. Either way the server tags
    // each item with its wallet + source and paginates the union correctly.
    // Rarity sort: with scope=all most rows have no price, so a price sort would just dump
    // the unlisted majority at the end — rank reads better on a showcase.
    const target = walletFilter === 'all' ? slug : walletFilter;
    const qs = new URLSearchParams({ q: target, scope, page: String(p), sort: flt.sort });
    if (flt.min) qs.set('min', flt.min);
    if (flt.max) qs.set('max', flt.max);
    for (const [type, vals] of flt.traits) for (const v of vals) qs.append('t', `${type}:${v}`);
    const res = await fetch(`${api}?${qs}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('http ' + res.status);
    const d = await res.json();
    if (rid !== reqId) return; // superseded — a newer request owns the grid
    items = reset ? (d.items || []) : items.concat(d.items || []);
    page = d.page ?? p;
    hasMore = !!d.hasMore;
    ownedTotal = d.ownedTotal ?? null;
    ownedListed = d.ownedListed ?? null;
    // Facets/priceRange are computed over the whole owned pool (scope-filtered, NOT
    // trait-filtered) — so they stay populated while a trait/price filter narrows the
    // grid, and only go empty when the collection/scope itself is empty. Take them
    // verbatim on a reset load; keep the last set while paging (page>0 omits them).
    if (reset && Array.isArray(d.facets)) facets = d.facets;
    if (reset) priceRange = d.priceRange || null;
    // Server catalogues still warming (creature traits / LAND slimes): traits, names and
    // facets are incomplete — quietly re-poll until they're not. The rid guard drops the
    // timer the moment any newer request (filter change, coll switch) supersedes it.
    gridIndexing = !!d.indexing;
    clearTimeout(indexingTimer);
    if (gridIndexing) {
      indexingTimer = setTimeout(() => { if (rid === reqId) loadHoldings(true, { quiet: true }); }, 5000);
    }
  } catch (err) {
    if (rid !== reqId) return;
    console.error('Profile holdings load failed:', err);
    if (reset) gridError = true;
  } finally {
    if (rid === reqId) { gridLoading = false; patchGrid(); patchFilters(); }
  }
}

// --- rendering ---

function shortWallet(w) { return w ? `${w.slice(0, 6)}…${w.slice(-4)}` : ''; }

// Brand marks for the stat chips (same assets the marketplace collection switcher uses).
const STAT_ICONS = {
  creatures: '/img/brands/icon_hcc.png',
  land:      'https://cdn.discordapp.com/emojis/974503320414744626.webp?size=128',
};

// One compact identity band: avatar (aurora ring) · name + trust badge + wallet ·
// inline stat chips · share CTA, with the safety note as a slim full-width footer.
// Everything above the grid fits in one strip so the collection is what you see.
function heroHtml() {
  // The initial is interpolated into an inline onerror JS string — strip anything that
  // could interact with either the attribute or the JS string context (quotes, backslash,
  // angle brackets). Non-letter first chars fall back to a neutral glyph.
  const initial = ((data.name || '').trim().slice(0, 1).toUpperCase().replace(/['"\\<>&`]/g, '')) || '?';
  const totalAssets = (data.creatureCount || 0) + (data.landCount || 0);
  const wallets = profileWallets();
  const trustChip = wallets.length > 1
    ? `<span class="hp-wallet-more">${esc(t('profile.walletsMore').replace('{n}', String(wallets.length)).replace('{v}', String(wallets.filter(w => w.verified).length)))}</span>`
    : (wallets[0]?.verified ? `<span class="hp-badge hp-badge-verified">${esc(t('profile.trustVerified'))}</span>` : '');
  const chip = (icon, count, key, extra = '') => `
    <div class="hp-statchip ${extra}" role="listitem">
      ${icon}
      <span class="hp-statchip-txt"><b data-hp-count="${count}">0</b><span>${esc(t(key))}</span></span>
    </div>`;
  return `
  <header class="hp-hero">
    <div class="hp-hero-glow" aria-hidden="true"></div>
    <div class="hp-avatar-wrap" aria-hidden="true">
      <div class="hp-avatar">
        ${data.avatar
          ? `<img src="${esc(data.avatar)}" alt="" loading="lazy"
               onerror="this.closest('.hp-avatar').textContent='${esc(initial)}'" />`
          : esc(initial)}
      </div>
    </div>
    <div class="hp-who">
      <div class="eyebrow">${esc(t('profile.eyebrow'))}</div>
      <h2 class="hp-name">${esc(data.name)}</h2>
      <div class="hp-wallet">
        <code class="hp-wallet-addr" title="${esc(data.wallet)}">${esc(shortWallet(data.wallet))}</code>
        <button type="button" class="hp-chipbtn" data-act="hp-copy" data-copy="${esc(data.wallet)}">${esc(t('profile.copyWallet'))}</button>
        ${trustChip}
      </div>
    </div>
    <div class="hp-statchips" role="list">
      ${chip(`<img class="hp-statchip-ico" src="${STAT_ICONS.creatures}" alt="" />`, data.creatureCount || 0, 'profile.statCreatures')}
      ${chip(`<img class="hp-statchip-ico" src="${STAT_ICONS.land}" alt="" />`, data.landCount || 0, 'profile.statLand')}
      ${chip(`<span class="hp-statchip-ico hp-statchip-total" aria-hidden="true">✦</span>`, totalAssets, 'profile.statTotal', 'is-total')}
    </div>
    <button type="button" class="hp-share" data-act="hp-share">${esc(t('profile.share'))}</button>
    <p class="hp-safety">${esc(t('profile.safety'))}</p>
  </header>`;
}

function controlsHtml() {
  // No collection seg here — the marketplace command bar's Creatures⟷LAND switcher is
  // the single switcher and drives this grid (loadProfile receives its coll).
  const scopeBtn = (id, key) => `
    <button type="button" role="tab" class="seg-btn ${scope === id ? 'is-active' : ''}"
      aria-selected="${scope === id}" data-act="hp-scope" data-scope="${id}">${esc(t(key))}</button>`;
  // Wallet filter only appears once a profile shows more than one wallet.
  const wallets = profileWallets();
  const walletChip = (id, label) => `
    <button type="button" role="tab" class="seg-btn ${walletFilter === id ? 'is-active' : ''}"
      aria-selected="${walletFilter === id}" data-act="hp-wallet" data-wallet="${esc(id)}">${esc(label)}</button>`;
  const walletSeg = wallets.length > 1 ? `
    <div class="seg hp-seg hp-wallet-seg" role="tablist" aria-label="${esc(t('profile.walletAria'))}">
      ${walletChip('all', t('profile.walletAll'))}
      ${wallets.map(w => walletChip(w.wallet, sourceLabel(w))).join('')}
    </div>` : '';
  // Sort + filter toggle sit on the right; the sidebar (rarity/tier, price, traits) opens
  // beside the grid on desktop and as a sheet on mobile — same controls as the marketplace.
  const sorts = [['price-asc', 'sortPriceAsc'], ['price-desc', 'sortPriceDesc'], ['rarity', 'sortRarity'], ['newest', 'sortNewest']];
  return `
  <div class="hp-controls">
    <div class="seg hp-seg" role="tablist" aria-label="${esc(t('profile.scopeAria'))}">
      ${scopeBtn('all', 'profile.scopeAll')}${scopeBtn('listed', 'profile.scopeListed')}
    </div>
    ${walletSeg}
    <div class="hp-controls-right">
      <select id="hp-sort" class="seg-select trade-flt-sort" aria-label="${esc(t('trade.filter.sortAria'))}">
        ${sorts.map(([v, k]) => `<option value="${v}" ${flt.sort === v ? 'selected' : ''}>${esc(t('trade.filter.' + k))}</option>`).join('')}
      </select>
      <button type="button" class="apply-btn-ghost trade-flt-toggle hp-flt-toggle" data-act="hpf-drawer" aria-expanded="${fltSheetOpen}" aria-controls="hp-side">
        ${esc(t('trade.filter.toggle'))}${fltCount() ? `<span class="trade-flt-badge">${fltCount()}</span>` : ''}
      </button>
    </div>
  </div>`;
}

function metaHtml() {
  if (ownedTotal == null) return '';
  const shown = items.length.toLocaleString();
  const total = (scope === 'listed' ? (ownedListed ?? 0) : ownedTotal).toLocaleString();
  const listed = (ownedListed ?? 0).toLocaleString();
  return `${t('profile.meta').replace('{shown}', shown).replace('{total}', total)}
    ${ownedListed != null ? ` · ${t('profile.metaListed').replace('{n}', listed)}` : ''}
    ${gridIndexing ? `<span class="hp-meta-note">${esc(t('profile.indexing'))}</span>` : ''}`;
}

// --- filter UI (same server params + facets as the marketplace Browse, same .trade-flt-*
// / .trade-side styling; the handlers are hpf-* so they don't collide with the marketplace's
// own flt-* delegation). Rarity (creatures) and Tier (LAND) are just trait facets. ---

function rarityFacet() {
  const f = (facets || []).find(x => /rarity/i.test(x.type));
  return { type: f?.type || 'Rarity', counts: new Map((f?.values || []).map(({ v, n }) => [v, n])) };
}
function rarityChipsHtml() {
  const { type, counts } = rarityFacet();
  return RARITY_TIERS.map(tier => {
    const sel = traitSelected(type, tier);
    const n = facets ? (counts.get(tier) ?? 0) : null; // unknown before first response → enabled
    return `<button type="button" class="trade-flt-rchip ${sel ? 'is-on' : ''}" data-r="${tier.toLowerCase()}"
      data-act="hpf-val" data-type="${esc(type)}" data-val="${esc(tier)}" aria-pressed="${sel}" ${n === 0 && !sel ? 'disabled' : ''}>
      <span class="trade-flt-rdot" aria-hidden="true"></span>${esc(tier)}${n != null ? `<span class="trade-flt-n">${n}</span>` : ''}
    </button>`;
  }).join('');
}
function tierFacet() { return (facets || []).find(x => x.type === 'Tier') || null; }
// Plot-type chips carry the holder's COUNT per tier (how many Standard / Premium plots
// this profile has) — same treatment as the Creature rarity chips beside them.
function tierChipsHtml() {
  const vals = new Map((tierFacet()?.values || []).map(o => [o.v, o]));
  return TIER_VALUES.map(name => {
    const o = vals.get(name);
    const sel = traitSelected('Tier', name);
    const n = facets ? (o?.n ?? 0) : null;
    return `<button type="button" class="trade-flt-rchip ${sel ? 'is-on' : ''}" data-tier="${esc(name.toLowerCase())}"
      data-act="hpf-val" data-type="Tier" data-val="${esc(name)}" aria-pressed="${sel}" ${n === 0 && !sel ? 'disabled' : ''}>
      <span class="trade-flt-rdot" aria-hidden="true"></span>${esc(name)}${n != null ? `<span class="trade-flt-n">${n}</span>` : ''}
    </button>`;
  }).join('');
}
function fTraitPopHtml(f) {
  return `<div class="trade-flt-pop" role="listbox" aria-label="${esc(f.type)}">
    ${f.values.map(({ v, n, pct }) => {
      const sel = traitSelected(f.type, v);
      const pctStr = fmtTraitPct(pct);
      return `<button type="button" class="trade-flt-opt ${sel ? 'is-on' : ''}" role="option" aria-selected="${sel}"
        data-act="hpf-val" data-type="${esc(f.type)}" data-val="${esc(v)}" ${n === 0 && !sel ? 'disabled' : ''}>
        <span class="trade-flt-check" aria-hidden="true">${sel ? '✓' : ''}</span>
        <span class="trade-flt-optv">${esc(v)}</span>${pctStr ? `<span class="trade-flt-pct" title="${esc(t('trade.filter.rarityPct'))}">${esc(pctStr)}</span>` : ''}<span class="trade-flt-n">${n}</span>
      </button>`;
    }).join('')}
  </div>`;
}
function traitDropsHtml() {
  if (!facets) return `<span class="trade-flt-loading">${esc(t('trade.filter.loading'))}</span>`;
  return facets.filter(f => !/rarity/i.test(f.type) && f.type !== 'Tier').map(f => {
    const selCount = flt.traits.get(f.type)?.size || 0;
    const open = openFacet === f.type;
    return `
    <div class="trade-flt-dd ${open ? 'is-open' : ''}">
      <button type="button" class="trade-flt-ddbtn ${selCount ? 'has-sel' : ''}" data-act="hpf-open" data-type="${esc(f.type)}"
        aria-expanded="${open}" aria-haspopup="listbox">
        ${esc(f.type)}${selCount ? `<span class="trade-flt-badge">${selCount}</span>` : ''}<span class="trade-flt-caret" aria-hidden="true">▾</span>
      </button>
      ${open ? fTraitPopHtml(f) : ''}
    </div>`;
  }).join('');
}
function filterSideHtml() {
  const pr = priceRange;
  return `
  <aside class="trade-side ${fltSheetOpen ? 'is-open' : ''}" id="hp-side" aria-label="${esc(t('trade.filter.toggle'))}">
    <div class="trade-side-backdrop" data-act="hpf-drawer"></div>
    <div class="trade-side-card">
      <div class="trade-side-head">
        <h3 class="trade-side-title">${esc(t('trade.filter.toggle'))}</h3>
        <button type="button" class="trade-flt-clearall" data-act="hpf-clear">${esc(t('trade.filter.clear'))}</button>
        <button type="button" class="trade-side-x" data-act="hpf-drawer" aria-label="${esc(t('trade.modal.close'))}">×</button>
      </div>
      ${coll === 'creatures' ? `<div class="trade-side-sec">
        <h4 class="trade-side-h">${esc(t('trade.filter.rarityH'))}</h4>
        <div class="trade-flt-rar" id="hp-flt-rar" role="group" aria-label="${esc(t('trade.filter.rarityAria'))}">${rarityChipsHtml()}</div>
      </div>` : ''}
      ${coll === 'land' ? `<div class="trade-side-sec">
        <h4 class="trade-side-h">${esc(t('trade.filter.tierH'))}</h4>
        <div class="trade-flt-rar" id="hp-flt-tier" role="group" aria-label="${esc(t('trade.filter.tierAria'))}">${tierChipsHtml()}</div>
      </div>` : ''}
      <div class="trade-side-sec">
        <h4 class="trade-side-h">${esc(t('trade.filter.priceH'))}</h4>
        <div class="trade-flt-price" role="group" aria-label="${esc(t('trade.filter.priceAria'))}">
          <input id="hp-flt-min" inputmode="decimal" autocomplete="off" placeholder="${pr ? esc(String(pr.min)) : 'min'}" value="${esc(flt.min)}" aria-label="${esc(t('trade.filter.minAria'))}" />
          <span class="trade-flt-dash" aria-hidden="true">–</span>
          <input id="hp-flt-max" inputmode="decimal" autocomplete="off" placeholder="${pr ? esc(String(pr.max)) : 'max'}" value="${esc(flt.max)}" aria-label="${esc(t('trade.filter.maxAria'))}" />
          <span class="trade-flt-eth" aria-hidden="true">ETH</span>
        </div>
      </div>
      <div class="trade-side-sec">
        <h4 class="trade-side-h">${esc(t('trade.filter.traitsH'))}</h4>
        <div class="trade-flt-traits" id="hp-flt-traits">${traitDropsHtml()}</div>
      </div>
      <button type="button" class="trade-send trade-side-done" data-act="hpf-drawer">${esc(t('trade.filter.done'))}</button>
    </div>
  </aside>`;
}
// Result meta + active-filter chips, above the grid (mirrors the marketplace toolbar's
// active row). The count meta always shows; chips + clear appear once a filter is on.
function activeRowHtml() {
  const chips = [];
  if (flt.min) chips.push({ k: 'min', label: `≥ ${flt.min} ETH` });
  if (flt.max) chips.push({ k: 'max', label: `≤ ${flt.max} ETH` });
  for (const [type, vals] of flt.traits) for (const v of vals) chips.push({ k: 't', type, v, label: `${type}: ${v}` });
  const meta = `<span class="hp-meta" id="hp-meta">${metaHtml()}</span>`;
  if (!chips.length) return meta;
  return `${meta}${chips.map(c => `
    <button type="button" class="trade-flt-chip" data-act="hpf-rm" data-kind="${c.k}"
      ${c.type ? `data-type="${esc(c.type)}" data-val="${esc(c.v)}"` : ''} aria-label="${esc(t('trade.filter.removeAria').replace('{f}', c.label))}">
      ${esc(c.label)}<span class="trade-flt-x" aria-hidden="true">×</span>
    </button>`).join('')}
    <button type="button" class="trade-flt-clearall" data-act="hpf-clear">${esc(t('trade.filter.clear'))}</button>`;
}

function tileHtml(it, i) {
  const isLand = coll === 'land';
  const img = isLand
    ? (Number.isInteger(it.coords?.x) && Number.isInteger(it.coords?.y)
        ? `/api/market/land/pet/${it.coords.x}/${it.coords.y}` : null)
    : (it.image || null);
  const name = isLand ? (it.slimeName || it.parcelName || `#${it.tokenId}`) : (it.name || `#${it.tokenId}`);
  const sub = isLand
    ? (it.coords ? `(${it.coords.x}, ${it.coords.y})` : '')
    : (it.rarity || '');
  const price = it.listed && (it.totalEth ?? it.priceEth) != null
    ? `${(it.totalEth ?? it.priceEth)} ETH` : null;
  // Every tile carries its market state: listed (mint, with the asking price) or not
  // listed (neutral). Shown on every asset so a visitor sees at a glance what's for sale.
  const status = it.listed
    ? `<span class="hp-tile-status is-listed">${esc(t('profile.listed'))}${price ? ` · ${esc(price)}` : ''}</span>`
    : `<span class="hp-tile-status is-unlisted">${esc(t('profile.unlisted'))}</span>`;
  // Per-tile trust badge (Verified / Highrise-linked / verified-elsewhere warning) — the
  // ownership signal. Shown in the union view; a specific-wallet filter already conveys it.
  const wRec = walletByAddr(it.wallet) || (it.verified != null ? { wallet: it.wallet, verified: it.verified, highriseLinked: it.highriseLinked } : null);
  const trust = wRec ? walletTrust(wRec) : null;
  const badge = (profileWallets().length > 1 && walletFilter === 'all' && trust)
    ? `<span class="hp-tile-wallet hp-trust-${trust.tone}">${esc(trust.label)}</span>`
    : '';
  // A full-cover button opens this token in the marketplace (its buy/offer view) — works
  // for listed and unlisted assets alike. The tile's spans are non-interactive, so nesting
  // them under the button is fine for a11y; the visible hint animates in on hover/focus.
  const label = t('profile.viewInMarket').replace('{name}', name);
  return `
  <article class="hp-tile" style="--hp-d:${Math.min(i, 24) * 30}ms">
    <div class="hp-tile-media">
      ${img ? `<img src="${esc(img)}" alt="${esc(name)}" loading="lazy" />` : `<span class="hp-tile-noimg" aria-hidden="true">✦</span>`}
      ${status}
      ${badge}
      <button type="button" class="hp-tile-view" data-act="hp-view" data-token="${esc(it.tokenId)}" data-coll="${coll}" data-listed="${it.listed ? '1' : '0'}" aria-label="${esc(label)}">
        <span class="hp-tile-view-hint">${esc(t('profile.viewInMarketShort'))} <span aria-hidden="true">→</span></span>
      </button>
    </div>
    <div class="hp-tile-body">
      <span class="hp-tile-name">${esc(name)}</span>
      ${sub ? `<span class="hp-tile-sub" ${!isLand ? `data-rar="${esc(String(sub).toLowerCase())}"` : ''}>${esc(sub)}</span>` : ''}
      ${it.rank ? `<span class="hp-tile-rank">#${esc(String(it.rank))}</span>` : ''}
    </div>
  </article>`;
}

function gridInnerHtml() {
  if (gridError) {
    return `<div class="hp-state">
      <p>${esc(t('profile.gridError'))}</p>
      <button type="button" class="apply-btn-ghost" data-act="hp-retry">${esc(t('profile.retry'))}</button>
    </div>`;
  }
  if (gridLoading && !items.length) {
    return Array.from({ length: 8 }, () =>
      `<div class="hp-tile hp-skel" aria-hidden="true"><div class="hp-tile-media"></div><div class="hp-tile-body"><span></span><span></span></div></div>`).join('');
  }
  if (!items.length) {
    // A live filter emptied the grid → say so and offer a one-tap clear (distinct from a
    // genuinely empty collection/listed set).
    if (fltActive()) {
      return `<div class="hp-state"><p>${esc(t('profile.emptyFiltered'))}</p>
        <button type="button" class="apply-btn-ghost" data-act="hpf-clear">${esc(t('trade.filter.clear'))}</button></div>`;
    }
    return `<div class="hp-state"><p>${esc(t(scope === 'listed' ? 'profile.emptyListed' : 'profile.empty'))}</p></div>`;
  }
  return items.map(tileHtml).join('');
}

function loadMoreHtml() {
  if (!hasMore) return '';
  return `<button type="button" class="apply-btn-ghost hp-more" data-act="hp-more" ${gridLoading ? 'disabled' : ''}>
    ${esc(t(gridLoading ? 'profile.loading' : 'profile.loadMore'))}</button>`;
}

function notFoundHtml() {
  return `
  <div class="hp-hero hp-notfound">
    <div class="hp-hero-glow" aria-hidden="true"></div>
    <div class="hp-state-ico" aria-hidden="true">🔒</div>
    <h2 class="hp-name">${esc(t('profile.notFoundH'))}</h2>
    <p class="hp-notfound-p">${esc(t('profile.notFoundP'))}</p>
    <button type="button" class="hp-share" data-act="hp-browse">${esc(t('profile.browseCta'))}</button>
  </div>`;
}

// Anti-scam banner: if a wallet in view is only Highrise-linked here but signature-verified
// by another member, warn and link to the true owner. Covers the rental/impersonation case.
function walletWarningHtml() {
  const inView = walletFilter === 'all'
    ? profileWallets()
    : profileWallets().filter(w => String(w.wallet).toLowerCase() === walletFilter.toLowerCase());
  const flagged = inView.filter(w => !w.verified && w.verifiedElsewhere);
  if (!flagged.length) return '';
  return `<div class="hp-warn" role="note">
    ${flagged.map(w => `<span class="hp-warn-line">
      <span class="hp-warn-ico" aria-hidden="true">⚠</span>
      <span>${esc(t('profile.walletElsewhereWarn').replace('{wallet}', shortWallet(w.wallet)))}
        <a class="hp-warn-link" href="/profile/${esc(w.verifiedElsewhere.slug)}" data-slug="${esc(w.verifiedElsewhere.slug)}">${esc(w.verifiedElsewhere.name)}</a></span>
    </span>`).join('')}
  </div>`;
}

function render() {
  const el = root();
  if (!el) return;
  el.setAttribute('aria-busy', String(identityLoading));
  if (identityLoading) {
    el.innerHTML = `<div class="apply-loading"><div class="apply-spinner"></div></div>`;
    return;
  }
  if (!data || data === 'notfound') {
    el.innerHTML = notFoundHtml();
    ensureDelegation();
    return;
  }
  el.innerHTML = `
    ${heroHtml()}
    <div id="hp-warn-slot">${walletWarningHtml()}</div>
    ${controlsHtml()}
    <section class="trade-browse has-side hp-browse">
      ${filterSideHtml()}
      <div class="trade-main">
        <div class="hp-active" id="hp-active">${activeRowHtml()}</div>
        <div class="hp-grid" id="hp-grid">${gridInnerHtml()}</div>
        <div class="hp-loadmore" id="hp-loadmore">${loadMoreHtml()}</div>
      </div>
    </section>
    <p class="apply-fineprint hp-fineprint">${esc(t('profile.fineprint'))}</p>`;
  ensureDelegation();
  animateCounts(el);
}

// Patch only the grid bits so the coll/scope toggles never lose their focus ring.
function patchGrid() {
  const el = root();
  if (!el || !data || data === 'notfound') return;
  const grid = el.querySelector('#hp-grid');
  if (grid) grid.innerHTML = gridInnerHtml();
  const more = el.querySelector('#hp-loadmore');
  if (more) more.innerHTML = loadMoreHtml();
  const act = el.querySelector('#hp-active');
  if (act) act.innerHTML = activeRowHtml();
}

// Repaint the sidebar's dynamic bits (facet counts, chips, toggle badge, price placeholder)
// WITHOUT touching the price inputs — focus + caret must survive typing. Mirrors the
// marketplace's patchFilters.
function patchFilters() {
  const el = root();
  if (!el || !data || data === 'notfound') return;
  // See marketplace.js keepFacetPopStill: rebuilding the dropdown list re-creates an open
  // popover and replays its enter animation, which reads as it reopening under the cursor.
  const wasOpen = el.querySelector('.trade-flt-dd.is-open .trade-flt-ddbtn')?.dataset.type || null;
  const rar = el.querySelector('#hp-flt-rar'); if (rar) rar.innerHTML = rarityChipsHtml();
  const tier = el.querySelector('#hp-flt-tier'); if (tier) tier.innerHTML = tierChipsHtml();
  const tr = el.querySelector('#hp-flt-traits');
  if (tr) {
    tr.innerHTML = traitDropsHtml();
    if (wasOpen && wasOpen === openFacet) tr.querySelector('.trade-flt-pop')?.classList.add('is-static');
  }
  const act = el.querySelector('#hp-active'); if (act) act.innerHTML = activeRowHtml();
  const tog = el.querySelector('.hp-flt-toggle');
  if (tog) tog.innerHTML = `${esc(t('trade.filter.toggle'))}${fltCount() ? `<span class="trade-flt-badge">${fltCount()}</span>` : ''}`;
  if (priceRange) {
    const mn = el.querySelector('#hp-flt-min'); if (mn) mn.placeholder = String(priceRange.min);
    const mx = el.querySelector('#hp-flt-max'); if (mx) mx.placeholder = String(priceRange.max);
  }
}
// Push filter state back into the price inputs after a programmatic change (chip ×, clear).
function syncFilterInputs() {
  const el = root(); if (!el) return;
  const mn = el.querySelector('#hp-flt-min'); if (mn) mn.value = flt.min;
  const mx = el.querySelector('#hp-flt-max'); if (mx) mx.value = flt.max;
}
// Apply a filter change: repaint the controls, then reload the grid (debounced for typing).
function applyFilters(debounceMs = 0) {
  clearTimeout(fltDebounce);
  const run = () => { patchFilters(); loadHoldings(true); };
  if (debounceMs) fltDebounce = setTimeout(run, debounceMs);
  else run();
}
// Mobile filter sheet open/close — owns the class + body scroll lock (same as the marketplace).
function setFltSheet(open) {
  fltSheetOpen = open;
  document.body.classList.toggle('trade-sheet-open', open);
  const el = root();
  el?.querySelector('#hp-side')?.classList.toggle('is-open', open);
  el?.querySelector('.hp-flt-toggle')?.setAttribute('aria-expanded', String(open));
}

// Count-up on the hero stats — skipped under reduced motion (values render directly).
function animateCounts(scopeEl) {
  const els = scopeEl.querySelectorAll('[data-hp-count]');
  const motionOK = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  els.forEach(el => {
    const target = parseInt(el.dataset.hpCount, 10) || 0;
    if (!motionOK || target === 0) { el.textContent = target.toLocaleString(); return; }
    const dur = 800;
    let t0 = null;
    function frame(ts) {
      if (t0 === null) t0 = ts;
      const p = Math.min((ts - t0) / dur, 1);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))).toLocaleString();
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

// --- events ---

async function copyText(value, btn) {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); ok = true; }
  } catch { ok = false; }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch { ok = false; }
  }
  if (ok && btn) {
    const original = btn.textContent;
    btn.textContent = t('profile.copied');
    btn.classList.add('is-copied');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('is-copied'); }, 1400);
  }
}

function ensureDelegation() {
  if (delegated) return;
  delegated = true;
  // Document-level: marketplace re-creates #profile-app on each of its renders, so a
  // container-bound listener would go stale. Act names are hp-* and don't collide
  // with the marketplace's own delegation.
  document.addEventListener('click', e => {
    // The rental warning's "true owner" link stays a real <a> (copyable, mid-clickable)
    // but a plain click swaps the in-marketplace view instead of a full page load.
    const ownerLink = e.target.closest('a.hp-warn-link');
    if (ownerLink && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('hcc:open-profile', { detail: { slug: ownerLink.dataset.slug } }));
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn || !btn.closest('#profile-app')) return;
    switch (btn.dataset.act) {
      case 'hp-scope':
        if (scope === btn.dataset.scope) return;
        scope = btn.dataset.scope;
        render();
        return loadHoldings(true);
      case 'hp-wallet':
        if (walletFilter === btn.dataset.wallet) return;
        walletFilter = btn.dataset.wallet;
        render();
        return loadHoldings(true);
      case 'hp-more':  return loadHoldings(false);
      case 'hp-retry': return loadHoldings(true);
      case 'hp-copy':  return copyText(btn.dataset.copy, btn);
      case 'hp-share': return copyText(PAGE_URL(), btn);
      case 'hp-browse':
        return window.dispatchEvent(new CustomEvent('hcc:browse-trade'));
      case 'hp-view':
        // Hand off to the marketplace: open this token's detail/buy view. Pass the known
        // listed state so an unlisted item skips the "brand-new listing, syncing…" hunt
        // and the backdrop is the full collection, not just the on-sale grid.
        return window.dispatchEvent(new CustomEvent('hcc:open-token', {
          detail: { coll: btn.dataset.coll, tokenId: btn.dataset.token, listed: btn.dataset.listed === '1' },
        }));
      // --- filters (mirror the marketplace's flt-* handlers) ---
      case 'hpf-val':
        toggleTrait(btn.dataset.type, btn.dataset.val);
        return applyFilters();
      case 'hpf-open':
        openFacet = openFacet === btn.dataset.type ? null : btn.dataset.type;
        return patchFilters();
      case 'hpf-clear':
        resetFilters();
        syncFilterInputs();
        return applyFilters();
      case 'hpf-rm': {
        const { kind, type, val } = btn.dataset;
        if (kind === 'min') flt.min = '';
        else if (kind === 'max') flt.max = '';
        else if (kind === 't') toggleTrait(type, val);
        syncFilterInputs();
        return applyFilters();
      }
      case 'hpf-drawer':
        return setFltSheet(!fltSheetOpen);
    }
  });
  // Sort (change) + price inputs (debounced), scoped to the profile panel.
  document.addEventListener('change', e => {
    if (e.target?.id !== 'hp-sort' || !e.target.closest('#profile-app')) return;
    flt.sort = e.target.value;
    applyFilters();
  });
  document.addEventListener('input', e => {
    if ((e.target?.id !== 'hp-flt-min' && e.target?.id !== 'hp-flt-max') || !e.target.closest('#profile-app')) return;
    const v = e.target.value.trim().replace(',', '.');
    if (v === '' || /^\d*\.?\d*$/.test(v)) flt[e.target.id === 'hp-flt-min' ? 'min' : 'max'] = v;
    applyFilters(400);
  });
}

// --- public API (wired in app.js) ---

// The collection shown is driven by the marketplace command bar's switcher (the one and
// only switcher) — it arrives as opts.coll on every call.
const wantColl = c => (c === 'land' || c === 'creatures') ? c : null;

export function loadProfile(theSlug, opts = {}) {
  const next = (theSlug || '').toLowerCase();
  const optColl = wantColl(opts.coll);
  // Already fetching this very profile (the marketplace renders more than once while it
  // boots, and every render calls us) — don't restart the identity+holdings round-trip.
  if (!opts.force && next && next === slug && identityLoading) return;
  // Same slug with data in hand: repaint into the (possibly re-created) container —
  // or, if the command bar switched collection, swap the grid to it. force refetches
  // instead (the wallet list just changed under us).
  if (!opts.force && next && next === slug && data && data !== 'notfound') {
    if (optColl && optColl !== coll) {
      coll = optColl;
      // Traits/rarity are collection-specific — the new collection starts unfiltered.
      resetFilters(); facets = null; priceRange = null;
      render();
      loadHoldings(true);
    } else {
      render();
    }
    return;
  }
  slug = next;
  data = null;
  coll = optColl || 'creatures';
  scope = 'all';
  walletFilter = 'all';
  items = []; page = 0; hasMore = false; ownedTotal = null; ownedListed = null;
  gridError = false;
  gridIndexing = false; clearTimeout(indexingTimer);
  resetFilters(); facets = null; priceRange = null; flt.sort = 'rarity';
  setFltSheet(false);
  reqId++;
  if (!slug) { identityLoading = false; data = 'notfound'; render(); return; }
  fetchIdentity();
}

export function rerenderProfile() {
  if (!root() || identityLoading || (!data && !slug)) return;
  if (data) render();
}
