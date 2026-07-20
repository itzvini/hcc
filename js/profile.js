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
let reqId = 0;          // guards a slow stale response against a newer view
let delegated = false;

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

async function loadHoldings(reset = true) {
  if (!data || data === 'notfound' || !profileWallets().length) return;
  if (!reset && (!hasMore || gridLoading)) return;
  const p = reset ? 0 : page + 1;
  if (reset) { items = []; page = 0; hasMore = false; gridError = false; }
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
    const qs = new URLSearchParams({ q: target, scope, page: String(p), sort: 'rarity' });
    const res = await fetch(`${api}?${qs}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('http ' + res.status);
    const d = await res.json();
    if (rid !== reqId) return; // superseded — a newer request owns the grid
    items = reset ? (d.items || []) : items.concat(d.items || []);
    page = d.page ?? p;
    hasMore = !!d.hasMore;
    ownedTotal = d.ownedTotal ?? null;
    ownedListed = d.ownedListed ?? null;
  } catch (err) {
    if (rid !== reqId) return;
    console.error('Profile holdings load failed:', err);
    if (reset) gridError = true;
  } finally {
    if (rid === reqId) { gridLoading = false; patchGrid(); }
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
  const collBtn = (id, key) => `
    <button type="button" role="tab" class="seg-btn ${coll === id ? 'is-active' : ''}"
      aria-selected="${coll === id}" data-act="hp-coll" data-coll="${id}">${esc(t(key))}</button>`;
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
  // The result meta rides the same row (pushed right) so the toolbar is one line.
  return `
  <div class="hp-controls">
    <div class="seg hp-seg" role="tablist" aria-label="${esc(t('profile.collAria'))}">
      ${collBtn('creatures', 'profile.collCreatures')}${collBtn('land', 'profile.collLand')}
    </div>
    <div class="seg hp-seg" role="tablist" aria-label="${esc(t('profile.scopeAria'))}">
      ${scopeBtn('all', 'profile.scopeAll')}${scopeBtn('listed', 'profile.scopeListed')}
    </div>
    ${walletSeg}
    <p class="hp-meta" id="hp-meta">${metaHtml()}</p>
  </div>`;
}

function metaHtml() {
  if (ownedTotal == null) return '';
  const shown = items.length.toLocaleString();
  const total = (scope === 'listed' ? (ownedListed ?? 0) : ownedTotal).toLocaleString();
  const listed = (ownedListed ?? 0).toLocaleString();
  return `${t('profile.meta').replace('{shown}', shown).replace('{total}', total)}
    ${ownedListed != null ? ` · ${t('profile.metaListed').replace('{n}', listed)}` : ''}`;
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
      <button type="button" class="hp-tile-view" data-act="hp-view" data-token="${esc(it.tokenId)}" data-coll="${coll}" aria-label="${esc(label)}">
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
    <div class="hp-grid" id="hp-grid">${gridInnerHtml()}</div>
    <div class="hp-loadmore" id="hp-loadmore">${loadMoreHtml()}</div>
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
  const meta = el.querySelector('#hp-meta');
  if (meta) meta.innerHTML = metaHtml();
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
      case 'hp-coll':
        if (coll === btn.dataset.coll) return;
        coll = btn.dataset.coll;
        render();
        return loadHoldings(true);
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
        // Hand off to the marketplace: open this token's buy/offer view (listed or not).
        return window.dispatchEvent(new CustomEvent('hcc:open-token', {
          detail: { coll: btn.dataset.coll, tokenId: btn.dataset.token },
        }));
    }
  });
}

// --- public API (wired in app.js) ---

export function loadProfile(theSlug, opts = {}) {
  const next = (theSlug || '').toLowerCase();
  // Same slug with data in hand: repaint into the (possibly re-created) container.
  // force refetches instead — the wallet list just changed under us.
  if (!opts.force && next && next === slug && data && data !== 'notfound') { render(); return; }
  slug = next;
  data = null;
  coll = 'creatures';
  scope = 'all';
  walletFilter = 'all';
  items = []; page = 0; hasMore = false; ownedTotal = null; ownedListed = null;
  gridError = false;
  reqId++;
  if (!slug) { identityLoading = false; data = 'notfound'; render(); return; }
  fetchIdentity();
}

export function rerenderProfile() {
  if (!root() || identityLoading || (!data && !slug)) return;
  if (data) render();
}
