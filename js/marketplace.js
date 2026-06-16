import { t } from './i18n.js';

// HCC Marketplace — Phase 0 (connect + transfer) + Phase 1 (public browse).
// Non-custodial throughout: browsing is read-only public data from our own server;
// every wallet action is signed by the user via window.ethereum (no web3 library).
// Buy/sell/cancel (signed orders, prepared server-side) arrive in later phases.

const CREATURE_CONTRACT = '0xCf44b1cBC959295bbBb49935B1b339cC0AA77cdA';
const ZK_CHAIN_ID_HEX   = '0x343b'; // Immutable zkEVM mainnet (13371)
const ZK_NETWORK = {
  chainId: ZK_CHAIN_ID_HEX,
  chainName: 'Immutable zkEVM',
  nativeCurrency: { name: 'Immutable X', symbol: 'IMX', decimals: 18 },
  rpcUrls: ['https://rpc.immutable.com'],
  blockExplorerUrls: ['https://explorer.immutable.com'],
};
const EXPLORER = 'https://explorer.immutable.com';

// Two collections, two worlds: Creatures (Immutable zkEVM + Immutable orderbook) and
// LAND (Ethereum mainnet + OpenSea Seaport). The active collection scopes the API base,
// the chain every action needs, and which features exist (offers/sell are
// Creatures-only until LAND listing-creation ships).
const LAND_CONTRACT_L1 = '0x8bf3a40ea2337e6e4f6e540680ea6390cb3b4e11';
const COLLECTIONS = {
  creatures: { api: '/api/market/creatures', chainHex: ZK_CHAIN_ID_HEX, contract: CREATURE_CONTRACT, labelKey: 'trade.coll.creatures', ico: '🐾' },
  land:      { api: '/api/market/land',      chainHex: '0x1',           contract: LAND_CONTRACT_L1, labelKey: 'trade.coll.land',      ico: '🗺️' },
};
let coll = 'creatures';
// Both collections use the same faceted browse. LAND is browsed via its attached Slime
// (a parcel and its slime are one NFT): one card per parcel, filtered by slime traits +
// rarity rank, priced/buyable when the parcel is listed.
const isBrowseView = () => coll === 'creatures' || coll === 'land';
const C = () => COLLECTIONS[coll];
const onRightChain = () => (chainId || '').toLowerCase() === C().chainHex;
// Every LAND parcel comes with a slime pet in-game — the plot tiles all look alike, so
// the grid shows each parcel's REAL pet, rendered server-side from the Highrise API
// (real plot art lives in the modal). Null when coords are unknown — use the plot image.
function petUrl(it) {
  const c = it?.coords;
  return Number.isInteger(c?.x) && Number.isInteger(c?.y) ? `/api/market/land/pet/${c.x}/${c.y}` : null;
}
function tokenExplorerUrl(tokenId) {
  return coll === 'land'
    ? `https://opensea.io/assets/ethereum/${LAND_CONTRACT_L1}/${encodeURIComponent(tokenId)}`
    : `${EXPLORER}/token/${CREATURE_CONTRACT}/instance/${encodeURIComponent(tokenId)}`;
}
function txExplorerUrl(hash) {
  return coll === 'land' ? `https://etherscan.io/tx/${hash}` : `${EXPLORER}/tx/${hash}`;
}

const SEL_SAFE_TRANSFER = '0x42842e0e'; // safeTransferFrom(address,address,uint256)
const SEL_BALANCE_OF    = '0x70a08231'; // balanceOf(address)
const SEL_OWNER_OF      = '0x6352211e'; // ownerOf(uint256)
const ZERO = '0x0000000000000000000000000000000000000000';
const METAMASK_IMG = '/img/brands/metamask.svg';
// Crisp shield-check (currentColor) — emoji shields render as flat glyphs on Windows.
const SHIELD_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.5l7.5 2.8v5.4c0 4.8-3.2 8.9-7.5 10.3-4.3-1.4-7.5-5.5-7.5-10.3V5.3L12 2.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.6 12l2.4 2.4 4.4-4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const IS_ADDR = /^0x[0-9a-f]{40}$/;
// ETH on Immutable zkEVM is an ERC-20 (the price token); IMX is the NATIVE gas token.
// A buyer needs BOTH, on Immutable zkEVM. The bridge deep-link opens Squid (which also
// powers Immutable's own toolkit bridge) pre-set to ETH-on-Ethereum → ETH-on-zkEVM;
// unknown params degrade gracefully to Squid's defaults.
const IMX_ETH_TOKEN = '0x52a6c53869ce09a731cd772f245b97a4401d3348';
const SQUID_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // Squid's native-coin placeholder
const BRIDGE_URL = `https://app.squidrouter.com/?chains=1,13371&tokens=${SQUID_NATIVE},${IMX_ETH_TOKEN}`;

// Wallet state
let account = null;
let chainId = null;
let busy    = false;
let pendingFlash = null; // one-shot banner surfaced on next render
let loadedOnce = false;

// Browse state
let listings = [];
let listingsCursor = null;
let listingsLoading = false;
let listingsError = false;
let ethUsd = null;
let fxRates = { usd: 1 };   // USD-relative display rates from the listings API
let currency = 'usd';       // active display currency for the fiat estimate ('eth' = none)
const CURRENCIES = ['usd', 'eth', 'eur', 'gbp', 'brl', 'rub', 'try', 'jpy', 'cad', 'aud'];

// Explorer state (Creatures only — LAND keeps the plain cursor feed). Filters are
// applied server-side against a full snapshot of active listings, so the client just
// describes what it wants: traits is Map(type -> Set(values)), OR within a type,
// AND across types. Facets come back with every response (value -> live match count).
let flt = { q: '', traits: new Map(), min: '', max: '', sort: 'price-asc', scope: 'listed' };
let browsePage = 0;
let browseHasMore = false;
let browseTotal = null;        // filtered match count (null until the first response)
let browseListedTotal = null;  // everything currently listed, pre-filter
let browseCollectionTotal = null; // whole collection size, once the server has indexed it
let browseScope = 'listed';    // EFFECTIVE scope from the server (≠ flt.scope while indexing)
let browseIndexing = false;    // asked for the whole collection; server still cataloguing
let browseHadFilters = false;  // whether the LAST APPLIED response was filtered — the count
                               // line renders response-time state, never a mid-flight mix
let browseFacets = null;       // [{type, values:[{v, n}]}] from the server
let browsePriceRange = null;   // {min, max} over all listings — price placeholder hints
let openFacet = null;          // trait type whose value popover is open
let fltOpenMobile = false;     // filter drawer expanded (mobile)
let fltDebounce = null;
let browseReqId = 0;           // drops stale responses when filters change mid-flight
const RARITY_TIERS = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];

// Inventory filter (Sell & Transfer pickers) — the same faceted search as Browse, but
// run CLIENT-SIDE over the owned set (which the server now enriches with traits/rank).
// No price/scope (your items aren't all priced/listed); facets recomputed locally.
let invFlt = { q: '', traits: new Map(), sort: 'rank' };
let invFacets = null;          // [{type, values:[{v,n}]}] computed from the owned set

// What's being browsed — endpoint, the noun for copy, which i18n count keys to use,
// and whether the dataset has rarity TIERS (Creatures do; Slimes don't — their parts
// are all "rare", so only the computed rank distinguishes them). Lets one filter bar
// serve both the Creature collection and the Slime catalogue.
function browseDataset() {
  if (coll === 'land') {
    return {
      api: '/api/market/land/browse', hasRarityChips: false, defaultScope: 'listed',
      scopeAll: 'trade.filter.scopeAllLand', noMatch: 'trade.filter.noMatchLand',
      countAll: 'trade.filter.countAllLand', countCollection: 'trade.filter.countCollectionLand',
      countFiltered: 'trade.filter.countFilteredLand', indexing: 'trade.filter.indexingLand',
    };
  }
  return {
    api: `${C().api}/browse`, hasRarityChips: true, defaultScope: 'listed',
    scopeAll: 'trade.filter.scopeAll', noMatch: 'trade.filter.noMatch',
    countAll: 'trade.filter.countAll', countCollection: 'trade.filter.countCollection',
    countFiltered: 'trade.filter.countFiltered', indexing: 'trade.filter.indexing',
  };
}

function fltActive() {
  return !!(flt.q || flt.min || flt.max || flt.traits.size);
}
function fltCount() {
  let n = (flt.q ? 1 : 0) + (flt.min ? 1 : 0) + (flt.max ? 1 : 0);
  for (const vals of flt.traits.values()) n += vals.size;
  return n;
}
function resetFilters() {
  // Scope is a view mode, not a filter — clearing filters keeps you where you are.
  flt = { q: '', traits: new Map(), min: '', max: '', sort: flt.sort, scope: flt.scope };
  openFacet = null;
}

// Switching collection (Creatures⟷LAND) starts a fresh browse: drop the grid, modal,
// deep-link, and every filter, and lead with the new collection's On-sale scope.
function resetBrowseForView() {
  listings = []; listingsCursor = null; listingsError = false;
  modalToken = null; modalMeta = null; buyState = null;
  linkListing = null; linkSync = null;
  resetFilters();
  flt.scope = browseDataset().defaultScope;
  browseFacets = null; browseTotal = null; browseListedTotal = null; browsePriceRange = null;
  browseCollectionTotal = null; browseScope = flt.scope; browseIndexing = false;
  browsePage = 0; browseHasMore = false; browseHadFilters = false;
  setFltSheet(false);
  clearTimeout(fltDebounce);
}
function browseQuery(page) {
  const p = new URLSearchParams();
  if (flt.scope === 'all') p.set('scope', 'all');
  if (flt.q) p.set('q', flt.q);
  if (flt.min) p.set('min', flt.min);
  if (flt.max) p.set('max', flt.max);
  if (flt.sort !== 'price-asc') p.set('sort', flt.sort);
  for (const [type, vals] of flt.traits) for (const v of vals) p.append('t', `${type}:${v}`);
  if (page) p.set('page', String(page));
  return p.toString();
}

// Modal state
let modalToken = null;
let modalMeta = null;
let modalLoading = false;

// Deep-link state (/trade?coll=…&token=… — e.g. the Discord new-listing pings).
// linkListing holds the resolved listing for a deep-linked token the paged grid feed
// doesn't contain; linkSync is the tokenId still being hunted — a listing created
// moments ago can lag the server's snapshot, so the modal shows a syncing state
// instead of a premature "not listed".
let linkListing = null;
let linkSync = null;

// Buy state — survives modal re-renders so a language switch or balance refresh can't
// wipe an in-flight purchase status. {phase, msg?, hash?}; null = idle.
let buyState = null;
const BUY_BUSY_PHASES = new Set(['prepare', 'approve', 'approveWait', 'fulfill', 'fulfillWait']);

// Which action tab is active inside the Trade panel: 'buy' | 'sell' | 'transfer'.
let tradeTab = 'buy';

// Offers state. tokenOffers = bids on the open modal's token; collOffers = standing
// collection-wide ("floor") offers, best first; myOffers = the user's own active offers.
let tokenOffers = null;    // null = loading/not loaded
let collOffers = null;
let myOffers = null;
let offerState = null;     // staged make-offer: prepare|approve|approveWait|sign|create|done|error
let offerCtx = null;       // where the make-offer flow is running: 'modal' | 'browse'
let acceptState = null;    // staged accept-offer: prepare|approve|approveWait|fulfill|fulfillWait|done|error
let acceptBusyId = null;   // offerId being accepted (disables its button)
const OFFER_BUSY = new Set(['prepare', 'approve', 'approveWait', 'sign', 'create']);
const ACCEPT_BUSY = new Set(['prepare', 'approve', 'approveWait', 'fulfill', 'fulfillWait']);

// Seller state: your Creatures (sell picker), your active listings, and the staged
// sell / cancel progress. Loaded lazily once connected on the right network.
let owned = null;          // null = not loaded; [] = loaded, none
let mine = null;           // null = not loaded; [] = loaded, none
let sellerLoading = false;
let sellSel = null;        // tokenId picked for sale
let sellPickOffers = null; // specific offers on the picked token (instant-sell target)

// Transfer state: picked Creature + live recipient assessment.
let transferSel = null;
let transferCheck = null;      // null | 'loading' | {addr, valid, reason?, checksum, contract, active, activityKnown, creatures}
let transferAck = false;       // explicit confirmation for never-used addresses
let transferCheckTimer = null;
let sellState = null;      // {phase, msg?, hash?}: prepare|approve|approveWait|sign|create|done|error
let cancelBusy = null;     // listingId currently being cancelled
const SELL_BUSY_PHASES = new Set(['prepare', 'approve', 'approveWait', 'sign', 'create']);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortWallet(a) {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || '');
}
const root = () => document.getElementById('trade-app');

// Small ⓘ disclosure for non-crucial detail: hover on desktop, tap on touch. Keeps the
// screen calm — the full explanation is one gesture away instead of always on.
function tipHtml(key) {
  return `<span class="trade-tip"><button type="button" class="trade-tip-btn" aria-label="${esc(t('trade.tip.aria'))}">i</button><span class="trade-tip-pop" role="tooltip">${esc(t(key))}</span></span>`;
}
let tipsWired = false;
function wireTips() {
  if (tipsWired) return; tipsWired = true;
  // Document-level so tips work anywhere on the page (incl. the static beta note),
  // and any outside click/tap closes whatever is open.
  document.addEventListener('click', e => {
    const btn = e.target.closest('.trade-tip-btn');
    const owner = btn ? btn.closest('.trade-tip') : null;
    document.querySelectorAll('.trade-tip.is-open').forEach(el => { if (el !== owner) el.classList.remove('is-open'); });
    if (owner) owner.classList.toggle('is-open');
  });
}
const eth  = () => window.ethereum;
const onZk = () => (chainId || '').toLowerCase() === ZK_CHAIN_ID_HEX;

function word(v) {
  const hex = (typeof v === 'string' && v.startsWith('0x')) ? v.slice(2) : BigInt(v).toString(16);
  return hex.toLowerCase().padStart(64, '0');
}

function fmtEth(eth) {
  const n = Number(eth);
  return Number.isFinite(n) ? `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH` : '—';
}
// The fiat estimate under an ETH price, in the user's chosen currency. Returns '' when
// ETH-only is selected or no rate is available (so the caller renders nothing).
function fmtFiat(eth) {
  if (currency === 'eth' || eth == null || ethUsd == null) return '';
  const rate = currency === 'usd' ? 1 : fxRates[currency];
  if (rate == null) return '';
  const val = Number(eth) * ethUsd * rate;
  try {
    return `≈ ${new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(val)}`;
  } catch {
    return `≈ ${Math.round(val).toLocaleString()} ${currency.toUpperCase()}`;
  }
}

// --- Known wallet bugs ---
// MetaMask extension 13.33.0+ ships a regression that wrongly reports "not enough IMX
// to pay for network fees" on custom networks even when the balance is ample (confirmed
// in the wild 2026-06-10; 13.32 and below behave). We read the wallet's version and
// warn affected users BEFORE they hit the wall. Bounded to major 13 on the assumption
// 14.x ships fixed — revisit/remove once MetaMask patches the regression.
let mmBuggyVersion = null;
async function detectWalletBug() {
  if (!eth()) return;
  try {
    const v = String(await eth().request({ method: 'web3_clientVersion' }) || '');
    const m = v.match(/MetaMask\/v?(\d+)\.(\d+)\.(\d+)/i);
    if (m && Number(m[1]) === 13 && Number(m[2]) >= 33) mmBuggyVersion = `${m[1]}.${m[2]}.${m[3]}`;
  } catch { /* harmless — no warning then */ }
  patchWalletNotice();
}
function mmWarnDismissed() {
  try { return localStorage.getItem('hcc-mmwarn-' + mmBuggyVersion) === '1'; } catch { return false; }
}
function walletNoticeHtml() {
  if (!mmBuggyVersion || mmWarnDismissed()) return '';
  return `
    <div class="trade-mmwarn" role="note">
      <span aria-hidden="true">⚠</span>
      <span>${esc(t('trade.mmbug.notice').replace('{v}', mmBuggyVersion))}</span>
      ${tipHtml('trade.mmbug.detail')}
      <button class="trade-bridgebar-x" data-act="mmwarn-dismiss" type="button" aria-label="${esc(t('trade.bridgebar.dismiss'))}">×</button>
    </div>`;
}
function patchWalletNotice() {
  const el = root()?.querySelector('#trade-mmwarn-slot');
  if (el) el.innerHTML = walletNoticeHtml();
}

// Map a wallet/provider error to a friendly, actionable message — never a raw revert.
function friendlyError(err) {
  const code = err?.code;
  const msg  = (err?.message || '').toLowerCase();
  if (code === 4001 || /user rejected|user denied|rejected the request/.test(msg)) {
    // On buggy MetaMask builds a "cancel" is often forced by the phantom insufficient-
    // IMX block — say so, or the user blames themselves (or us).
    return t('trade.err.rejected') + (mmBuggyVersion ? ` ${t('trade.err.mmBugHint')}` : '');
  }
  if (code === -32002 || /already pending|already processing|request already/.test(msg)) return t('trade.err.pending');
  if (/insufficient funds|insufficient balance|gas required|exceeds balance/.test(msg)) return t('trade.err.gas');
  if (code === 4902 || /unrecognized chain|wrong network/.test(msg)) return t('trade.err.network');
  return t('trade.err.generic');
}

// --- Chain reads (through the wallet's provider) ---
async function readBalance() {
  if (!account || !onZk()) return null;
  try {
    const res = await eth().request({ method: 'eth_call', params: [{ to: CREATURE_CONTRACT, data: SEL_BALANCE_OF + word(account) }, 'latest'] });
    return parseInt(res, 16) || 0;
  } catch { return null; }
}
async function ownerOf(contract, tokenId) {
  try {
    const res = await eth().request({ method: 'eth_call', params: [{ to: contract, data: SEL_OWNER_OF + word(tokenId) }, 'latest'] });
    if (!res || res.length < 42) return null;
    return ('0x' + res.slice(-40)).toLowerCase();
  } catch { return null; }
}
// Balances (wei BigInt, or null on read failure) for the funds-help block.
async function readErc20(token, addr) {
  try { return BigInt(await eth().request({ method: 'eth_call', params: [{ to: token, data: SEL_BALANCE_OF + word(addr) }, 'latest'] }) || '0x0'); }
  catch { return null; }
}
async function readNative(addr) {
  try { return BigInt(await eth().request({ method: 'eth_getBalance', params: [addr, 'latest'] }) || '0x0'); }
  catch { return null; }
}
function fmtWeiEth(wei) {
  if (wei == null) return '—';
  return (Number(wei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 });
}
// "0.0618 ETH (≈ R$ 520)" — every ETH amount carries the user's selected currency.
function fmtEthFiat(eth) {
  if (eth == null || !Number.isFinite(Number(eth))) return '—';
  const fiat = fmtFiat(eth);
  return fiat ? `${fmtEth(eth)} (${fiat})` : fmtEth(eth);
}
const weiToEth = wei => (wei == null ? null : Number(wei) / 1e18);

// --- Wallet actions ---
async function ensureNetwork() {
  try {
    await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ZK_CHAIN_ID_HEX }] });
  } catch (err) {
    if (err?.code === 4902 || /unrecognized chain|add.*chain/i.test(err?.message || '')) {
      await eth().request({ method: 'wallet_addEthereumChain', params: [ZK_NETWORK] });
    } else { throw err; }
  }
  chainId = await eth().request({ method: 'eth_chainId' });
}

// --- Wallet safety primer ---
// Shown ONCE, at the exact moment it matters: the first Connect click. The community
// is heavily targeted (Discord impersonation, phishing links, seed-phrase theft), so
// the primer is unskippable-but-once: four rules, then connect. The full content
// lives in Guides → Stay safe; the 🛡 pill by the tabs links there forever after.
const SAFETY_ACK = 'hcc-safety-ack';
let safetyOpen = false;
function safetyAcked() {
  try { return localStorage.getItem(SAFETY_ACK) === '1'; } catch { return true; }
}

// "60 seconds that protect your Creatures" — literally. The connect button unlocks
// after a real 60s, anchored to the FIRST time the primer was seen (persisted, so a
// refresh doesn't restart it, and time spent reading the full guide counts).
const SAFETY_T0 = 'hcc-safety-t0';
const SAFETY_WAIT_MS = 60 * 1000; // tune here if 60s proves too much friction
let safetyT0Mem = null;
let safetyTimer = null;
function safetyT0() {
  try {
    let v = Number(localStorage.getItem(SAFETY_T0)) || 0;
    if (!v) { v = Date.now(); localStorage.setItem(SAFETY_T0, String(v)); }
    return v;
  } catch {
    if (!safetyT0Mem) safetyT0Mem = Date.now();
    return safetyT0Mem;
  }
}
function safetyRemainingMs() {
  return Math.max(0, safetyT0() + SAFETY_WAIT_MS - Date.now());
}
function startSafetyTicker() {
  if (safetyTimer) return;
  safetyTimer = setInterval(() => {
    if (!safetyOpen || !root()) { clearInterval(safetyTimer); safetyTimer = null; return; }
    const rem = safetyRemainingMs();
    const bar = root().querySelector('#trade-safety-bar');
    if (bar) bar.style.width = `${Math.min(100, ((SAFETY_WAIT_MS - rem) / SAFETY_WAIT_MS) * 100)}%`;
    const btn = root().querySelector('#trade-safety-ok');
    if (!btn) return;
    if (rem > 0) {
      btn.disabled = true;
      btn.textContent = `${t('trade.safety.ok')} · ${Math.ceil(rem / 1000)}s`;
    } else {
      btn.disabled = false;
      btn.textContent = t('trade.safety.ok');
      clearInterval(safetyTimer); safetyTimer = null;
    }
  }, 250);
}
function safetyHtml() {
  if (!safetyOpen) return '';
  const RULES = [['🤫', 1], ['💬', 2], ['🧐', 3], ['🔗', 4]].map(([ico, i], idx) => `
    <li style="--i:${idx}">
      <span class="trade-safety-ico" aria-hidden="true">${ico}</span>
      <div><b>${esc(t(`trade.safety.r${i}h`))}</b><p>${esc(t(`trade.safety.r${i}p`))}</p></div>
    </li>`).join('');
  return `
    <div class="trade-modal trade-safety" role="dialog" aria-modal="true" aria-label="${esc(t('trade.safety.aria'))}">
      <div class="trade-modal-backdrop" data-act="safety-close"></div>
      <div class="trade-safety-card">
        <span class="apply-pill">${esc(t('trade.safety.badge'))}</span>
        <h3 class="trade-safety-h">${esc(t('trade.safety.h'))}</h3>
        <p class="trade-safety-p">${esc(t('trade.safety.p'))}</p>
        <ul class="trade-safety-rules">${RULES}</ul>
        <div class="trade-safety-track" aria-hidden="true"><div class="trade-safety-barfill" id="trade-safety-bar" style="width:${Math.min(100, ((SAFETY_WAIT_MS - safetyRemainingMs()) / SAFETY_WAIT_MS) * 100)}%"></div></div>
        <div class="trade-safety-actions">
          <button class="apply-btn-ghost" data-act="safety-guide" type="button">${esc(t('trade.safety.guide'))}</button>
          <button class="trade-send trade-safety-ok" id="trade-safety-ok" data-act="safety-ack" type="button" ${safetyRemainingMs() > 0 ? 'disabled' : ''}>
            ${esc(t('trade.safety.ok'))}${safetyRemainingMs() > 0 ? ` · ${Math.ceil(safetyRemainingMs() / 1000)}s` : ''}</button>
        </div>
        <p class="trade-safety-foot">${esc(t('trade.safety.foot'))}</p>
      </div>
    </div>`;
}
function openSafetyGuide() {
  safetyOpen = false;
  render();
  // Static elements wired by app.js — programmatic clicks reuse its tab plumbing.
  document.getElementById('tab-guides')?.click();
  document.querySelector('[data-subtab="safety"]')?.click();
}

async function connect() {
  if (!eth() || busy) return;
  if (!safetyAcked()) { safetyOpen = true; render(); startSafetyTicker(); return; }
  busy = true; render();
  try {
    const accounts = await eth().request({ method: 'eth_requestAccounts' });
    account = (accounts[0] || '').toLowerCase() || null;
    chainId = await eth().request({ method: 'eth_chainId' });
    if (account && !onZk()) await ensureNetwork();
  } catch (err) {
    console.error('Wallet connect failed:', err);
    pendingFlash = friendlyError(err);
  } finally { busy = false; render(); }
}

// Switch to whatever chain the ACTIVE collection needs (zkEVM gets added if absent;
// Ethereum mainnet always exists in the wallet).
async function switchToChain(hex) {
  if (hex === ZK_CHAIN_ID_HEX) { await ensureNetwork(); return; }
  await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  chainId = await eth().request({ method: 'eth_chainId' });
}

async function switchNetwork(btn) {
  if (busy) return;
  busy = true;
  if (btn) { btn.disabled = true; btn.textContent = t('trade.net.switching'); }
  try { await switchToChain(C().chainHex); pendingFlash = null; }
  catch (err) { console.error('Network switch failed:', err); pendingFlash = friendlyError(err); }
  finally { busy = false; render(); }
}

async function sendTransfer(contract, tokenId, to) {
  const data = SEL_SAFE_TRANSFER + word(account) + word(to) + word(tokenId);
  return eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to: contract, data }] });
}

// --- Browse ---
// Both Creatures and LAND use the faceted offset-paged browse below.
function loadListings(reset = true) { return loadBrowse(reset); }

// Faceted explorer feed (Creatures and LAND): the server filters/sorts its full
// snapshot, so a "page" is an offset into the current filtered set. A request id
// guards against a slow stale response landing after the user already changed filters.
async function loadBrowse(reset = true) {
  if (!reset && (!browseHasMore || listingsLoading)) return;
  const page = reset ? 0 : browsePage + 1;
  if (reset) { listings = []; browsePage = 0; browseHasMore = false; listingsError = false; }
  const rid = ++browseReqId;
  const hadFilters = fltActive(); // captured at request time, applied at response time
  const ds = browseDataset();
  listingsLoading = true; patchGrid(); patchFilters();
  try {
    const qs = browseQuery(page);
    const res = await fetch(`${ds.api}${qs ? '?' + qs : ''}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    if (rid !== browseReqId || ds.api !== browseDataset().api) return; // superseded — newer request (or view) owns the grid
    if (data.ethUsd != null) ethUsd = data.ethUsd;
    if (data.fxRates) fxRates = data.fxRates;
    listings = reset ? (data.items || []) : listings.concat(data.items || []);
    browsePage = data.page ?? page;
    browseHasMore = !!data.hasMore;
    browseTotal = data.total ?? null;
    browseListedTotal = data.listedTotal ?? null;
    browseCollectionTotal = data.collectionTotal ?? browseCollectionTotal;
    browseScope = data.scope || 'listed';
    browseIndexing = !!data.indexing;
    browseHadFilters = hadFilters;
    if (data.facets) browseFacets = data.facets;
    if (data.priceRange) browsePriceRange = data.priceRange;
  } catch (err) {
    if (rid !== browseReqId) return;
    console.error('Browse load failed:', err);
    if (reset) listingsError = true;
  } finally {
    if (rid === browseReqId) { listingsLoading = false; patchGrid(); patchFilters(); }
  }
}

// Re-fetch from page 0 after any filter change, debounced for typed input — every
// keystroke must not become a request (and the rate limiter agrees).
function applyFilters(debounceMs = 0) {
  clearTimeout(fltDebounce);
  if (!debounceMs) { patchFilters(); loadBrowse(true); return; }
  patchFilters();
  fltDebounce = setTimeout(() => loadBrowse(true), debounceMs);
}

function skeletons(n) {
  return Array.from({ length: n }, () =>
    `<div class="trade-tile trade-skel" aria-hidden="true"><div class="trade-tile-media"></div><div class="trade-tile-body"><span></span><span></span></div></div>`).join('');
}

function rarityChip(rarity) {
  return rarity ? `<span class="trade-rar" data-r="${esc(String(rarity).toLowerCase())}">${esc(rarity)}</span>` : '';
}
function rankChip(rank) {
  return rank != null ? `<span class="trade-rank" title="${esc(t('trade.filter.rankAria'))}">#${esc(String(rank))}</span>` : '';
}

function tileHtml(it) {
  const unlisted = it.listed === false; // scope=all rows; LAND/listed rows lack the flag
  const fiat = unlisted ? '' : fmtFiat(it.totalEth ?? it.priceEth);
  // LAND tiles show the parcel's slime pet (plot art is in the modal); if the parcel
  // has no pet (404) the delegated error handler swaps in the plot image.
  const pet = coll === 'land' ? petUrl(it) : null;
  const src = pet || it.image;
  const fallback = pet && it.image ? ` data-fallback="${esc(it.image)}"` : '';
  const img = src
    ? `<img class="trade-tile-img ${pet ? 'is-pet' : ''}" src="${esc(src)}"${fallback} alt="" loading="lazy" />`
    : `<div class="trade-tile-img trade-tile-noimg" aria-hidden="true">${coll === 'land' ? '🗺️' : '🐾'}</div>`;
  const price = unlisted
    ? `<span class="trade-tile-price is-unlisted">${esc(t('trade.filter.unlisted'))}</span>`
    : `<span class="trade-tile-price">${esc(fmtEth(it.totalEth ?? it.priceEth))}</span>`;
  // LAND: one card is a parcel, shown via its slime — lead with the slime's nickname,
  // with the parcel coordinates (the asset you're buying) as the subtitle.
  const sub = coll === 'land' && it.slimeName && it.parcelName
    ? `<span class="trade-tile-sub">${esc(it.parcelName)}</span>` : '';
  return `
    <button class="trade-tile" type="button" data-act="open" data-token="${esc(it.tokenId)}">
      <div class="trade-tile-media">${img}${rankChip(it.rank)}${rarityChip(it.rarity)}</div>
      <div class="trade-tile-body">
        <span class="trade-tile-name">${esc(it.name)}</span>
        ${sub}
        ${price}
        ${fiat ? `<span class="trade-tile-usd">${esc(fiat)}</span>` : ''}
      </div>
    </button>`;
}

function gridInnerHtml() {
  if (listingsLoading && !listings.length) return skeletons(8);
  if (listingsError && !listings.length) {
    return `<div class="trade-grid-state"><p>${esc(t('trade.browse.error'))}</p>
      <button class="apply-btn-ghost" data-act="retry" type="button">${esc(t('trade.browse.retry'))}</button></div>`;
  }
  if (!listings.length) {
    // Slime catalogue still sweeping Highrise — say so rather than "nothing here".
    if (isBrowseView() && browseIndexing) {
      return `<div class="trade-grid-state"><span class="trade-mini-spin" aria-hidden="true"></span><p>${esc(t(browseDataset().indexing))}</p></div>`;
    }
    if (isBrowseView() && fltActive()) {
      return `<div class="trade-grid-state"><div class="trade-grid-state-ico" aria-hidden="true">🔍</div><p>${esc(t(browseDataset().noMatch))}</p>
        <button class="apply-btn-ghost" data-act="flt-clear" type="button">${esc(t('trade.filter.clear'))}</button></div>`;
    }
    return `<div class="trade-grid-state"><div class="trade-grid-state-ico" aria-hidden="true">🛒</div><p>${esc(t('trade.browse.empty'))}</p></div>`;
  }
  return listings.map(tileHtml).join('');
}

function loadMoreHtml() {
  const more = isBrowseView() ? browseHasMore : !!listingsCursor;
  if (!listings.length || !more) return '';
  return `<button class="apply-btn-ghost" data-act="loadmore" type="button" ${listingsLoading ? 'disabled' : ''}>${esc(listingsLoading ? t('trade.browse.loadingMore') : t('trade.browse.loadMore'))}</button>`;
}

function patchGrid() {
  const g = root()?.querySelector('#trade-grid');
  if (g) g.innerHTML = gridInnerHtml();
  const lm = root()?.querySelector('#trade-loadmore');
  if (lm) lm.innerHTML = loadMoreHtml();
}

// --- Token detail modal ---

// The open modal's listing: the grid feed first, then the deep-link fallback (a token
// arriving via ?token= is often beyond the feed's first page, or newer than it).
function listingForToken(tokenId) {
  return listings.find(l => String(l.tokenId) === String(tokenId))
    || (linkListing && String(linkListing.tokenId) === String(tokenId) ? linkListing : null);
}

// Mirror the open modal into the address bar (/trade?coll=…&token=…) so every token
// view is a shareable deep link. replaceState only — modals must not stack history.
function syncTradeUrl() {
  if (!location.pathname.startsWith('/trade')) return;
  const url = modalToken
    ? `/trade?coll=${coll}&token=${encodeURIComponent(modalToken)}`
    : '/trade';
  history.replaceState(null, '', url);
}

// A slime's full detail (traits, rank, art) already rides in its browse row — the LAND
// token endpoint returns the PARCEL's metadata, not the slime — so shape the modal
// straight from the row, no fetch.
function slimeModalMeta(it) {
  if (!it) return null;
  return {
    isSlime: true,
    name: it.slimeName || it.parcelName,
    image: petUrl(it),
    attributes: Object.entries(it.traits || {}).map(([trait, value]) => ({ trait, value })),
    rank: it.rank,
    rankOf: browseCollectionTotal,
    coords: it.coords,
    parcelName: it.parcelName,
  };
}

async function openModal(tokenId) {
  modalToken = tokenId; modalMeta = null; modalLoading = true; buyState = null;
  tokenOffers = null;
  if (offerCtx === 'modal') { offerState = null; offerCtx = null; }
  acceptState = null;
  if (coll === 'creatures') loadTokenOffers(tokenId); // offers are Creatures-only for now
  syncTradeUrl();
  const slimeRow = coll === 'land' ? listingForToken(tokenId) : null;
  if (slimeRow) { // LAND detail is in the row — render immediately, no token fetch
    modalMeta = slimeModalMeta(slimeRow);
    modalLoading = false;
    patchModal();
    return;
  }
  patchModal();
  try {
    const res = await fetch(`${C().api}/token/${encodeURIComponent(tokenId)}`, { headers: { Accept: 'application/json' } });
    if (res.ok) modalMeta = await res.json();
  } catch (err) { console.error('Token detail failed:', err); }
  modalLoading = false;
  if (String(modalToken) === String(tokenId)) patchModal();
}
function closeModal() {
  if (buyState && BUY_BUSY_PHASES.has(buyState.phase)) return; // don't lose an in-flight purchase
  modalToken = null; modalMeta = null; buyState = null;
  syncTradeUrl();
  patchModal();
}

// Resolve the listing for a deep-linked token the grid feed doesn't have. Creatures
// get an exact-token endpoint backed by the full listing snapshot; LAND walks its
// cursor feed (the collection's active listings span only a few pages).
async function fetchListingFor(tokenId) {
  try {
    if (coll === 'creatures') {
      const res = await fetch(`/api/market/creatures/listing/${encodeURIComponent(tokenId)}`, { headers: { Accept: 'application/json' } });
      return res.ok ? (await res.json()).listing || null : null;
    }
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const url = `${C().api}/listings${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      const hit = (data.items || []).find(it => String(it.tokenId) === String(tokenId));
      if (hit) {
        // Same normalization as loadListings: orderHash plays the listingId role.
        return { listingId: hit.orderHash, protocolAddress: hit.protocolAddress, tokenId: hit.tokenId, seller: hit.seller, priceEth: hit.priceEth, totalEth: hit.priceEth, name: hit.name, image: hit.image, coords: hit.coords, rarity: null };
      }
      cursor = data.nextCursor || '';
      if (!cursor) return null;
    }
  } catch (err) { console.error('Deep-link listing lookup failed:', err); }
  return null;
}

// A brand-new listing (the Discord ping case) can trail the server snapshot by a
// minute, so retry on a short backoff before settling on "not listed". Bails the
// moment the user moves on — closes the modal, opens another token, switches worlds.
const LINK_RETRY_MS = [0, 10000, 25000];

async function openDeepLink(tokenId) {
  const wantColl = coll;
  linkSync = tokenId;
  openModal(tokenId);
  const moved = () => coll !== wantColl || String(modalToken) !== String(tokenId);
  for (const ms of LINK_RETRY_MS) {
    if (ms) await new Promise(resolve => setTimeout(resolve, ms));
    if (moved()) { linkSync = null; return; }
    if (listingForToken(tokenId)?.priceEth != null) break; // the grid feed had it
    const found = await fetchListingFor(tokenId);
    if (moved()) { linkSync = null; return; }
    if (found) { linkListing = found; break; }
  }
  linkSync = null;
  patchModal();
}

function modalCardHtml() {
  const it = listingForToken(modalToken) || {};
  const meta = modalMeta || {};
  const image = meta.image || it.image;
  const name = meta.name || it.name || `Highrise Creature #${modalToken}`;
  const img = image
    ? `<img class="trade-modal-img" src="${esc(image)}" alt="${esc(name)}" />`
    : `<div class="trade-modal-img trade-tile-noimg" aria-hidden="true">🐾</div>`;

  const allIn = it.totalEth ?? it.priceEth;
  const modalFiat = fmtFiat(allIn);
  const price = it.priceEth != null
    ? `<div class="trade-modal-price">
         <span class="trade-modal-price-eth">${esc(fmtEth(allIn))}</span>
         ${modalFiat ? `<span class="trade-modal-price-usd">${esc(modalFiat)}</span>` : ''}
         <span class="trade-modal-fees">${esc(t('trade.price.allin'))} ${tipHtml('trade.price.allin.tip')}</span>
       </div>
       ${buyAreaHtml(it)}`
    : (String(linkSync) === String(modalToken)
        ? `<div class="trade-modal-price"><span class="trade-modal-syncing"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.modal.syncing'))}</span></div>`
        : `<div class="trade-modal-price"><span class="trade-modal-notlisted">${esc(t('trade.modal.notListed'))}</span></div>`);

  const attrs = meta.attributes || meta.traits; // creatures vs LAND field name
  const traits = modalLoading
    ? `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.modal.loading'))}</div>`
    : (attrs && attrs.length
        ? `<div class="trade-modal-traits">${attrs.map(a =>
            `<div class="trade-trait"><span class="trade-trait-k">${esc(a.trait)}</span><span class="trade-trait-v">${esc(a.value)}</span></div>`).join('')}</div>`
        : '');

  const owner = meta.owner ? `<div class="trade-modal-meta-row">${esc(t('trade.modal.owner'))}: <code>${esc(shortWallet(meta.owner))}</code></div>` : '';
  // Slimes live on a parcel — show its coordinates, not the parcel's 50-digit token id.
  const idRow = meta.isSlime
    ? `<div class="trade-modal-meta-row">${esc(t('trade.land.parcel'))}: <code>${esc(meta.parcelName || `(${meta.coords?.x}, ${meta.coords?.y})`)}</code></div>`
    : `<div class="trade-modal-meta-row">${esc(t('trade.modal.tokenId'))}: <code class="trade-modal-tokenid">${esc(modalToken)}</code></div>`;
  const explorer = tokenExplorerUrl(modalToken);

  const rank = meta.rank != null
    ? `<div class="trade-modal-rank">${esc(t(meta.isSlime ? 'trade.modal.rankSlime' : 'trade.modal.rank')
        .replace('{r}', Number(meta.rank).toLocaleString())
        .replace('{t}', Number(meta.rankOf || 0).toLocaleString()))}</div>`
    : '';
  return `
    <button class="trade-modal-close" data-act="close" type="button" aria-label="${esc(t('trade.modal.close'))}">×</button>
    <div class="trade-modal-media">${img}${rankChip(meta.rank ?? it.rank)}${rarityChip(it.rarity || (meta.attributes || []).find(a => /rarity/i.test(a.trait))?.value)}</div>
    <div class="trade-modal-info">
      <h3 class="trade-modal-name">${esc(name)}</h3>
      ${rank}
      ${price}
      ${coll === 'creatures' ? modalOffersHtml(meta) : ''}
      ${owner}
      ${idRow}
      ${traits}
      <a class="trade-modal-explorer" href="${esc(explorer)}" target="_blank" rel="noopener">${esc(t('trade.modal.viewExplorer'))} ↗</a>
    </div>`;
}

// --- Buy flow ---

function buyStatusHtml() {
  if (!buyState) return '';
  const STEP_KEY = {
    prepare: 'trade.buy.preparing',
    approve: 'trade.buy.approve',
    approveWait: 'trade.buy.approveWait',
    fulfill: 'trade.buy.confirm',
    fulfillWait: 'trade.buy.confirmWait',
  };
  if (buyState.phase === 'done') {
    return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.buy.done'))} `
      + `<a href="${esc(txExplorerUrl(buyState.hash))}" target="_blank" rel="noopener">${esc(t('trade.status.view'))}</a></span></div>`;
  }
  if (buyState.phase === 'error') {
    return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(buyState.msg)}</span></div>`;
  }
  if (buyState.phase === 'funds') return fundsHelpHtml();
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP_KEY[buyState.phase] || 'trade.buy.preparing'))}</span></div>`;
}

// A warm, concrete "let's get your ETH ready" panel. The #1 confusion: the user HAS ETH,
// just on Ethereum mainnet, while trades settle on Immutable zkEVM. We acknowledge that
// kindly and show exactly what to do — never a blunt "0 ETH / wrong".
function fundsHelpHtml() {
  const f = buyState;
  const need = fmtEthFiat(f.need);
  const imx = fmtWeiEth(f.imxBal);
  let mainnetEth = 0;
  try { mainnetEth = f.mainnetEthWei != null ? Number(BigInt(f.mainnetEthWei)) / 1e18 : 0; } catch { mainnetEth = 0; }
  const hasMainnet = mainnetEth > 0;
  const hasGas = f.imxBal != null && Number(f.imxBal) / 1e18 >= 0.005;

  // IMX (gas) row — celebrate when they're already covered, gently note it when not.
  const imxRow = hasGas
    ? `<li class="is-ok"><span class="trade-funds-ic" aria-hidden="true">✓</span><div>${esc(t('trade.funds.imxGood'))}<br><span>${esc(t('trade.funds.have'))} ${esc(imx)} IMX</span></div></li>`
    : `<li><span class="trade-funds-ic" aria-hidden="true">•</span><div>${esc(t('trade.funds.imxNeed'))}<br><span>${esc(t('trade.funds.have'))} ${esc(imx)} IMX · ${esc(t('trade.funds.gasHint'))}</span></div></li>`;

  // The common, reassuring case: they have ETH on mainnet — it just needs to bridge over.
  if (hasMainnet) {
    // Quoted one-tap bridge (exact amount, in-panel) when available; deep-link fallback.
    let bridgeArea;
    if (f.quote === 'loading') {
      bridgeArea = `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.bridge.quote.loading'))}</div>`;
    } else if (f.quote && f.quote.tx) {
      const q = f.quote;
      const mins = q.durationSeconds ? Math.max(1, Math.ceil(q.durationSeconds / 60)) : null;
      const meta = [
        q.feeUsd != null ? t('trade.bridge.quote.fees').replace('{f}', String(q.feeUsd)) : null,
        mins != null ? t('trade.bridge.quote.mins').replace('{m}', String(mins)) : null,
        t('trade.bridge.quote.by'),
      ].filter(Boolean).join(' · ');
      const busy = bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase);
      bridgeArea = `
        <div class="trade-bridge-quote">
          <div class="trade-bridge-line">${esc(t('trade.bridge.quote.line').replace('{x}', fmtEthFiat(q.fromEth)).replace('{y}', fmtEthFiat(q.toEth)))}</div>
          <div class="trade-bridge-meta">${esc(meta)}</div>
          ${bridgeJob?.phase === 'done' ? '' : `<button class="trade-funds-btn" data-act="bridge-now" type="button" ${busy ? 'disabled' : ''}>${esc(t('trade.bridge.now'))}</button>`}
          ${bridgeStatusHtml()}
        </div>`;
    } else {
      bridgeArea = `<a class="trade-funds-btn" href="${BRIDGE_URL}" target="_blank" rel="noopener">${esc(t('trade.funds.bridgeBtn'))} ↗</a>
        <p class="trade-funds-foot">${esc(t('trade.funds.bridgeFoot'))}</p>`;
    }
    return `
      <div class="trade-funds">
        <div class="trade-funds-h"><span aria-hidden="true">💡</span> ${esc(t('trade.funds.bridgeH'))} ${tipHtml('trade.funds.bridgeP')}</div>
        <ul class="trade-funds-list">
          <li><span class="trade-funds-ic" aria-hidden="true">↗</span><div>
            <b>ETH</b> — ${esc(t('trade.funds.ethTitle'))}<br>
            <span>${esc(t('trade.funds.youHaveOnEth').replace('{x}', fmtEthFiat(weiToEth(f.mainnetEthWei))))} · ${esc(t('trade.funds.bridgeNeed').replace('{x}', need))}</span>
          </div></li>
          ${imxRow}
        </ul>
        ${bridgeArea}
      </div>`;
  }

  // No ETH detected anywhere — still gentle, just a "here's how to get set up".
  return `
    <div class="trade-funds">
      <div class="trade-funds-h"><span aria-hidden="true">💡</span> ${esc(t('trade.funds.h'))} ${tipHtml('trade.funds.intro')}</div>
      <ul class="trade-funds-list">
        <li><span class="trade-funds-ic" aria-hidden="true">•</span><div><b>ETH</b> — ${esc(t('trade.funds.forPrice'))}<br><span>${esc(t('trade.funds.need'))} ≈ <b>${esc(need)}</b> · ${esc(t('trade.funds.have'))} ${esc(fmtEthFiat(weiToEth(f.ethBal)))}</span></div></li>
        ${imxRow}
      </ul>
      <p class="trade-funds-net">${esc(t('trade.funds.net'))}</p>
      <a class="trade-funds-btn" href="${BRIDGE_URL}" target="_blank" rel="noopener">${esc(t('trade.funds.bridge'))} ↗</a>
    </div>`;
}

// Read balances (zkEVM ETH + IMX, and mainnet ETH via the server), then show the panel.
// When the user has mainnet ETH, also ask the server for an exact-output Squid quote so
// the panel can offer one-tap bridging of precisely the shortfall.
async function showFundsHelp(it) {
  const need = it.totalEth ?? it.priceEth;
  buyState = { phase: 'funds', need, ethBal: null, imxBal: null, mainnetEthWei: null, quote: 'loading' };
  patchModal();
  const [ethBal, imxBal, elsewhere] = await Promise.all([
    readErc20(IMX_ETH_TOKEN, account),
    readNative(account),
    fetch(`/api/market/creatures/eth-elsewhere/${account}`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (buyState?.phase !== 'funds') return;
  const mainnetEthWei = elsewhere?.mainnetEthWei ?? null;
  buyState = { phase: 'funds', need, ethBal, imxBal, mainnetEthWei, quote: 'loading' };
  patchModal();

  // Shortfall on zkEVM (in ETH); only quote when they hold mainnet ETH to bridge.
  const haveZk = ethBal != null ? Number(ethBal) / 1e18 : 0;
  const shortfall = Math.max(0, need - haveZk);
  let hasMainnet = false;
  try { hasMainnet = mainnetEthWei != null && BigInt(mainnetEthWei) > 0n; } catch { hasMainnet = false; }
  if (!hasMainnet || shortfall <= 0) {
    buyState.quote = null; patchModal(); return;
  }
  try {
    const res = await fetch('/api/market/creatures/bridge/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ address: account, needEth: shortfall.toFixed(18).replace(/0+$/, '').replace(/\.$/, '') }),
    });
    const q = res.ok ? await res.json() : null;
    if (buyState?.phase === 'funds') { buyState.quote = q; patchModal(); }
  } catch {
    if (buyState?.phase === 'funds') { buyState.quote = null; patchModal(); }
  }
}

// --- One-tap bridge (Squid): persistent job + live tracker ---
// The bridge outlives any one screen: the job is held module-wide AND persisted to
// localStorage, so closing the modal, switching tabs, or reloading the page never
// loses track of it — a slim banner on the Trade tab keeps reporting until it lands.
let bridgeJob = null; // {phase, hash, mins, startedAt, stage, axelarUrl, msg, needWei, quoteId, requestId, account}
const BRIDGE_STORE = 'hcc-bridge';
const BRIDGE_TERMINAL = new Set(['done', 'slow', 'error']);

function saveBridge() {
  try {
    if (bridgeJob && bridgeJob.hash) localStorage.setItem(BRIDGE_STORE, JSON.stringify(bridgeJob));
    else localStorage.removeItem(BRIDGE_STORE);
  } catch { /* private mode — tracking still works for this session */ }
}
function loadSavedBridge() {
  try {
    const raw = localStorage.getItem(BRIDGE_STORE);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j?.hash || !j.startedAt || Date.now() - j.startedAt > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(BRIDGE_STORE);
      return null;
    }
    return j;
  } catch { return null; }
}
function dismissBridge() {
  bridgeJob = null;
  try { localStorage.removeItem(BRIDGE_STORE); } catch { /* fine */ }
  patchBridgeBanner();
  patchModal();
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function bridgeLinksHtml(b) {
  if (!b?.hash) return '';
  const axelar = b.axelarUrl || `https://axelarscan.io/gmp/${b.hash}`;
  return `<a href="https://etherscan.io/tx/${esc(b.hash)}" target="_blank" rel="noopener">${esc(t('trade.bridge.etherscan'))}</a>
    · <a href="${esc(axelar)}" target="_blank" rel="noopener">${esc(t('trade.bridge.axelar'))}</a>`;
}

// Full tracker (modal funds panel): stage stepper + elapsed clock + ETA bar + links.
function bridgeTrackerHtml(b) {
  const idx = { submitted: 0, src_confirmed: 1, bridging: 1, arrived: 2 }[b.stage] ?? 0;
  const steps = ['trade.bridge.step1', 'trade.bridge.step2', 'trade.bridge.step3'].map((k, i) => {
    const state = i < idx ? 'is-done' : i === idx ? 'is-active' : '';
    const ico = i < idx ? '✓' : (i === idx ? '<span class="trade-mini-spin" aria-hidden="true"></span>' : '·');
    return `<li class="${state}"><span class="trade-track-ic">${ico}</span><span>${esc(t(k))}</span></li>`;
  }).join('');
  const minsText = b.mins ? `~${b.mins} min` : t('trade.bridge.mins.few');
  return `
    <div class="trade-track" role="status" aria-live="polite">
      <ul class="trade-track-steps">${steps}</ul>
      <div class="trade-track-bar" aria-hidden="true"><div class="trade-track-barfill" data-bridge-bar></div></div>
      <div class="trade-track-meta">
        <span><b data-bridge-elapsed>${esc(fmtElapsed(Date.now() - b.startedAt))}</b> ${esc(t('trade.bridge.elapsed'))} · ${esc(t('trade.bridge.eta'))} ${esc(minsText)}</span>
        <span>${bridgeLinksHtml(b)}</span>
      </div>
    </div>`;
}

// Slim always-visible banner (under the wallet bar) so the bridge stays in view —
// and survives — wherever the user goes. Dismissible once terminal.
function bridgeBannerHtml() {
  const b = bridgeJob;
  if (!b || (!b.hash && !BRIDGE_TERMINAL.has(b.phase))) return '';
  const stageKey = { submitted: 'trade.bridge.step1', src_confirmed: 'trade.bridge.step2', bridging: 'trade.bridge.step2', arrived: 'trade.bridge.step3' }[b.stage] || 'trade.bridge.step1';
  const dismiss = BRIDGE_TERMINAL.has(b.phase)
    ? `<button class="trade-bridgebar-x" data-act="bridge-dismiss" type="button" aria-label="${esc(t('trade.bridgebar.dismiss'))}">×</button>` : '';
  if (b.phase === 'done') {
    return `<div class="trade-bridgebar is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.bridgebar.done'))}</span><span class="trade-bridgebar-links">${bridgeLinksHtml(b)}</span>${dismiss}</div>`;
  }
  if (b.phase === 'error') {
    return `<div class="trade-bridgebar is-bad"><span aria-hidden="true">⚠</span><span>${esc(b.msg || t('trade.bridge.failed'))}</span><span class="trade-bridgebar-links">${bridgeLinksHtml(b)}</span>${dismiss}</div>`;
  }
  const slow = b.phase === 'slow' ? ` ${esc(t('trade.bridgebar.slowTag'))}` : '';
  return `
    <div class="trade-bridgebar" role="status" aria-live="polite">
      <span class="trade-mini-spin" aria-hidden="true"></span>
      <span>${esc(t('trade.bridgebar.bridging'))} — ${esc(t(stageKey))}${slow} · <b data-bridge-elapsed>${esc(fmtElapsed(Date.now() - b.startedAt))}</b>${b.mins ? ` / ~${esc(String(b.mins))} min` : ''}</span>
      <span class="trade-bridgebar-links">${bridgeLinksHtml(b)}</span>
      ${dismiss}
    </div>`;
}
function patchBridgeBanner() {
  const el = root()?.querySelector('#trade-bridgebar-slot');
  if (el) el.innerHTML = bridgeBannerHtml();
}

// 1-second UI tick for the elapsed clocks + ETA bars (panel + banner) — direct DOM
// writes, no re-render.
let bridgeTickTimer = null;
function startBridgeTicker() {
  if (bridgeTickTimer) return;
  bridgeTickTimer = setInterval(() => {
    const b = bridgeJob;
    if (!b || !['waiting', 'slow'].includes(b.phase) || !root()) { clearInterval(bridgeTickTimer); bridgeTickTimer = null; return; }
    root().querySelectorAll('[data-bridge-elapsed]').forEach(el => { el.textContent = fmtElapsed(Date.now() - b.startedAt); });
    if (b.mins) {
      const w = `${Math.min(96, ((Date.now() - b.startedAt) / (b.mins * 60000)) * 100)}%`;
      root().querySelectorAll('[data-bridge-bar]').forEach(el => { el.style.width = w; });
    }
  }, 1000);
}

function bridgeStatusHtml() {
  const b = bridgeJob;
  if (!b) return '';
  const STEP = { switch: 'trade.bridge.switch', confirm: 'trade.bridge.confirm', back: 'trade.bridge.back' };
  if (b.phase === 'waiting') return bridgeTrackerHtml(b);
  if (b.phase === 'done')  return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.bridge.done'))}</span></div>`;
  if (b.phase === 'slow') {
    return `${bridgeTrackerHtml(b)}<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t('trade.bridge.slow'))}</span></div>`;
  }
  if (b.phase === 'error') {
    return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(b.msg)} ${bridgeLinksHtml(b)}</span></div>`;
  }
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP[b.phase]))}</span></div>`;
}

function setBridgeJob(patchFields) {
  bridgeJob = { ...bridgeJob, ...patchFields };
  saveBridge();
  patchModal();
  patchBridgeBanner();
}

// The tracking loop — independent of any screen. Resumable: runs off bridgeJob alone,
// so it works identically right after sending and after a page reload mid-bridge.
async function trackBridge() {
  const job = bridgeJob;
  if (!job?.hash) return;
  startBridgeTicker();
  const needWei = BigInt(job.needWei);
  // Wait ≥25 min (or 2× ETA) from when the bridge STARTED, with a 10-min floor from
  // now so a just-resumed old job still gets a fair polling window.
  const deadline = Math.max(job.startedAt + Math.max(25 * 60 * 1000, (job.mins || 0) * 120000), Date.now() + 10 * 60 * 1000);
  let tick = 0;
  while (Date.now() < deadline) {
    if (bridgeJob !== job || job.phase !== 'waiting') return;
    const bal = await readErc20(IMX_ETH_TOKEN, job.account);
    if (bal != null && bal >= needWei) return setBridgeJob({ phase: 'done', stage: 'arrived' });
    if (tick++ % 2 === 0) { // status every ~20s — visible movement without rate pressure
      try {
        const r = await fetch(`/api/market/creatures/bridge/status?tx=${job.hash}&quoteId=${encodeURIComponent(job.quoteId || '')}&requestId=${encodeURIComponent(job.requestId || '')}`);
        if (r.ok) {
          const s = await r.json();
          if (bridgeJob !== job || job.phase !== 'waiting') return;
          if (s.stage === 'failed' || s.stage === 'failed_src') return setBridgeJob({ phase: 'error', msg: t('trade.bridge.failed'), axelarUrl: s.axelarUrl || job.axelarUrl });
          if (s.stage === 'needs_gas') return setBridgeJob({ phase: 'error', msg: t('trade.bridge.needsGas'), axelarUrl: s.axelarUrl || job.axelarUrl });
          if (s.stage !== job.stage || (s.axelarUrl && s.axelarUrl !== job.axelarUrl)) {
            setBridgeJob({ stage: s.stage, axelarUrl: s.axelarUrl || job.axelarUrl });
          }
        }
      } catch { /* transient — keep tracking */ }
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  if (bridgeJob === job && job.phase === 'waiting') setBridgeJob({ phase: 'slow' });
}

async function handleBridgeNow() {
  const f = buyState;
  const q = f?.quote;
  if (!q || q === 'loading' || !q.tx) return;
  if (bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase)) return; // one bridge at a time
  try {
    bridgeJob = { phase: 'switch', account, mins: null, startedAt: Date.now() };
    patchModal();
    await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
    setBridgeJob({ phase: 'confirm' });
    const hash = await eth().request({
      method: 'eth_sendTransaction',
      params: [{ from: account, to: q.tx.to, data: q.tx.data, value: q.tx.value, ...(q.tx.gas ? { gas: q.tx.gas } : {}) }],
    });
    setBridgeJob({ phase: 'back', hash });
    await ensureNetwork(); // back to Immutable zkEVM
    const mins = q.durationSeconds ? Math.max(1, Math.ceil(q.durationSeconds / 60)) : null;
    const needWei = (BigInt(Math.round((f?.need ?? 0) * 1e6)) * 10n ** 12n).toString();
    setBridgeJob({
      phase: 'waiting', hash, mins, startedAt: Date.now(), stage: 'submitted',
      axelarUrl: null, needWei, quoteId: q.quoteId || '', requestId: q.requestId || '', account,
    });
    trackBridge();
  } catch (err) {
    console.error('Bridge failed:', err);
    setBridgeJob({ phase: 'error', msg: friendlyError(err) });
  }
}

function buyAreaHtml(it) {
  if (buyState?.phase === 'done') return buyStatusHtml();
  if (account && it.seller && it.seller.toLowerCase() === account) {
    return `<p class="trade-modal-own">${esc(t('trade.buy.own'))}</p>`;
  }
  const busyNow = buyState && BUY_BUSY_PHASES.has(buyState.phase);
  let btn;
  if (!eth()) {
    btn = `<a class="trade-send trade-buy-btn" href="https://metamask.io/download/" target="_blank" rel="noopener">${esc(t('trade.install.btn'))}</a>`;
  } else if (!account) {
    btn = `<button class="trade-send trade-buy-btn" data-act="connect" type="button">${esc(t('trade.buy.connect'))}</button>`;
  } else if (!onRightChain()) {
    btn = `<button class="trade-send trade-buy-btn" data-act="switch" type="button">${esc(t('trade.net.switch'))}</button>`;
  } else {
    btn = `<button class="trade-send trade-buy-btn" data-act="buy" data-listing="${esc(it.listingId)}" type="button" ${busyNow ? 'disabled' : ''}>
      ${esc(t('trade.buy.btn'))} · ${esc(fmtEthFiat(it.totalEth ?? it.priceEth))}</button>`;
  }
  const gasNote = coll === 'land' ? `<p class="trade-beta-micro">${esc(t('trade.land.gasMicro'))}</p>` : '';
  return `<div class="trade-buy">${btn}<p class="trade-beta-micro">${esc(t('trade.beta.micro'))}</p>${gasNote}${buyStatusHtml()}</div>`;
}

function setBuy(phase, extra) {
  buyState = { phase, ...extra };
  patchModal();
}

// Server prepare-error codes → friendly copy.
function buyServerError(code) {
  const KEY = {
    not_found: 'trade.err.gone', not_active: 'trade.err.gone',
    insufficient: 'trade.err.funds', rate_limited: 'trade.err.rate',
    own_listing: 'trade.buy.own', blocked_account: 'trade.err.osBlocked',
  };
  return t(KEY[code] || 'trade.err.unavailable');
}

// Poll the wallet provider for a receipt; resolves to it (or null on timeout).
async function waitForReceipt(hash, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await eth().request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (r) return r;
    } catch { /* transient provider hiccup — keep polling */ }
    await new Promise(res => setTimeout(res, 1500));
  }
  return null;
}

// LAND buy: Ethereum mainnet, native-ETH value transaction, no approvals. The
// prepared calldata is zone-bound to this buyer, so it can't be hijacked.
async function handleBuyLand(it) {
  try {
    setBuy('prepare');
    // Pre-flight: price + a gas cushion must already sit on MAINNET (no bridge here —
    // this is the opposite direction from the zkEVM funds helper).
    const needWei = BigInt(Math.round((it.totalEth ?? it.priceEth) * 1e6)) * 10n ** 12n + 10n ** 16n; // +0.01 ETH gas cushion
    try {
      const ee = await fetch(`/api/market/creatures/eth-elsewhere/${account}`).then(r => r.ok ? r.json() : null);
      if (ee?.mainnetEthWei != null && BigInt(ee.mainnetEthWei) < needWei) {
        setBuy('error', { msg: t('trade.err.landFunds').replace('{x}', fmtEth(Number(needWei) / 1e18)).replace('{y}', fmtEth(Number(BigInt(ee.mainnetEthWei)) / 1e18)) });
        return;
      }
    } catch { /* pre-flight unavailable — the wallet will still guard */ }

    const res = await fetch('/api/market/land/buy/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderHash: it.listingId, protocolAddress: it.protocolAddress, takerAddress: account }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setBuy('error', { msg: buyServerError(data.error) }); return; }

    await switchToChain('0x1');
    for (const tx of (data.transactions || [])) {
      setBuy('fulfill');
      const hash = await eth().request({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: tx.to, data: tx.data, value: tx.value && tx.value !== '0x0' ? tx.value : undefined }],
      });
      setBuy('fulfillWait', { hash });
      const receipt = await waitForReceipt(hash);
      if (!receipt || receipt.status !== '0x1') { setBuy('error', { msg: t('trade.err.txFailed') }); return; }
      setBuy('done', { hash });
      listings = listings.filter(l => l.listingId !== it.listingId);
      patchGrid();
      loadSellerData(); // their LAND count changed
      return;
    }
    setBuy('error', { msg: t('trade.err.unavailable') });
  } catch (err) {
    console.error('LAND buy failed:', err);
    setBuy('error', { msg: friendlyError(err) });
  }
}

async function handleBuy(listingId) {
  if (buyState && BUY_BUSY_PHASES.has(buyState.phase)) return;
  const it = listings.find(l => l.listingId === listingId)
    || (linkListing?.listingId === listingId ? linkListing : null);
  if (!it) return;
  if (coll === 'land') return handleBuyLand(it);

  try {
    setBuy('prepare');

    // Pre-flight FIRST: verify the on-chain balances ourselves before any server or
    // wallet round-trip — a real shortfall goes straight to the friendly funds panel
    // (balances + bridge quote). Also means any wallet-side "insufficient" alert that
    // appears later is a false positive (MetaMask's custom-network reads can lag).
    const [zkEthBal, imxBal] = await Promise.all([readErc20(IMX_ETH_TOKEN, account), readNative(account)]);
    const needWei = BigInt(Math.round((it.totalEth ?? it.priceEth) * 1e6)) * 10n ** 12n;
    if (zkEthBal != null && zkEthBal < needWei) { await showFundsHelp(it); return; }
    if (imxBal != null && imxBal === 0n) { setBuy('error', { msg: t('trade.err.gas') }); return; }

    const res = await fetch('/api/market/creatures/buy/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ listingId, takerAddress: account }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === 'insufficient') { await showFundsHelp(it); return; }
      setBuy('error', { msg: buyServerError(data.error) });
      return;
    }

    for (const tx of (data.transactions || [])) {
      const isApproval = tx.purpose === 'APPROVAL';
      setBuy(isApproval ? 'approve' : 'fulfill');
      const hash = await eth().request({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: tx.to, data: tx.data, value: tx.value && tx.value !== '0x0' ? tx.value : undefined }],
      });
      setBuy(isApproval ? 'approveWait' : 'fulfillWait', { hash });
      const receipt = await waitForReceipt(hash);
      if (!receipt || receipt.status !== '0x1') { setBuy('error', { msg: t('trade.err.txFailed') }); return; }
      if (!isApproval) {
        setBuy('done', { hash });
        listings = listings.filter(l => l.listingId !== listingId); // it's sold — drop from the grid
        patchGrid();
        refreshBalance();
        return;
      }
    }
    // No FULFILL_ORDER transaction came back — treat as unavailable rather than charge nothing silently.
    setBuy('error', { msg: t('trade.err.unavailable') });
  } catch (err) {
    console.error('Buy failed:', err);
    setBuy('error', { msg: friendlyError(err) });
  }
}

// --- Offers (bids + collection "floor" offers) ---

async function loadCollOffers() {
  try {
    const res = await fetch('/api/market/creatures/offers/collection', { headers: { Accept: 'application/json' } });
    collOffers = res.ok ? ((await res.json()).offers || []) : [];
  } catch { collOffers = []; }
  patchCollStrip();
  patchSellView();
}
async function loadMyOffers() {
  if (!account) { myOffers = null; return; }
  try {
    const res = await fetch(`/api/market/creatures/offers/mine/${account}`, { headers: { Accept: 'application/json' } });
    myOffers = res.ok ? ((await res.json()).offers || []) : [];
  } catch { myOffers = []; }
  patchCollStrip();
}
async function loadTokenOffers(tokenId) {
  tokenOffers = null;
  try {
    const res = await fetch(`/api/market/creatures/offers/token/${encodeURIComponent(tokenId)}`, { headers: { Accept: 'application/json' } });
    const offers = res.ok ? ((await res.json()).offers || []) : [];
    if (String(modalToken) === String(tokenId)) { tokenOffers = offers; patchModal(); }
  } catch { if (String(modalToken) === String(tokenId)) { tokenOffers = []; patchModal(); } }
}

function offerStatusHtml() {
  if (!offerState) return '';
  const STEP = {
    prepare: 'trade.offer.preparing', approve: 'trade.offer.approve', approveWait: 'trade.offer.approveWait',
    sign: 'trade.offer.sign', create: 'trade.offer.create',
  };
  if (offerState.phase === 'done')  return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.offer.done'))}</span></div>`;
  if (offerState.phase === 'error') return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(offerState.msg)}</span></div>`;
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP[offerState.phase]))}</span></div>`;
}
function acceptStatusHtml() {
  if (!acceptState) return '';
  const STEP = {
    prepare: 'trade.accept.preparing', approve: 'trade.accept.approve', approveWait: 'trade.accept.approveWait',
    fulfill: 'trade.accept.confirm', fulfillWait: 'trade.accept.confirmWait',
  };
  if (acceptState.phase === 'done') {
    const link = acceptState.hash ? ` <a href="${esc(EXPLORER)}/tx/${esc(acceptState.hash)}" target="_blank" rel="noopener">${esc(t('trade.status.view'))}</a>` : '';
    return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.accept.done'))}${link}</span></div>`;
  }
  if (acceptState.phase === 'error') return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(acceptState.msg)}</span></div>`;
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP[acceptState.phase]))}</span></div>`;
}

// Offer rows for the token modal: list + accept (owner) or make-an-offer (everyone else).
function modalOffersHtml(meta) {
  const isOwner = account && meta?.owner && meta.owner === account;
  const rows = tokenOffers === null
    ? `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.offers.loading'))}</div>`
    : (tokenOffers.length
        ? `<ul class="trade-offer-list">${tokenOffers.slice(0, 3).map(o => `
            <li>
              <span class="trade-offer-price">${esc(fmtEthFiat(o.priceEth))}</span>
              <span class="trade-offer-meta">${esc(t('trade.offers.net').replace('{x}', fmtEthFiat(o.netEth)))} · ${esc(t('trade.offers.from'))} <code>${esc(shortWallet(o.from))}</code></span>
              ${isOwner ? `<button class="trade-offer-accept" data-act="accept-offer" data-offer="${esc(o.offerId)}" type="button" ${acceptBusyId ? 'disabled' : ''}>${esc(acceptBusyId === o.offerId ? t('trade.accept.busy') : t('trade.offers.accept'))}</button>` : ''}
            </li>`).join('')}</ul>`
        : `<p class="trade-offers-none">${esc(t('trade.offers.none'))}</p>`);

  const makeBusy = offerState && OFFER_BUSY.has(offerState.phase);
  const makeForm = !isOwner && account && onZk()
    ? `<form class="trade-offer-form" id="trade-offer-form" data-token="${esc(modalToken)}" novalidate>
        <input id="trade-offer-price" type="text" inputmode="decimal" placeholder="${esc(t('trade.offers.make.ph'))}" autocomplete="off" />
        <button class="trade-offer-btn" type="submit" ${makeBusy ? 'disabled' : ''}>${esc(t('trade.offers.make.btn'))}</button>
      </form>`
    : '';

  return `
    <div class="trade-offers">
      <h4 class="trade-offers-h">${esc(t('trade.offers.h'))}</h4>
      ${rows}
      ${isOwner ? acceptStatusHtml() : ''}
      ${makeForm}
      ${offerCtx === 'modal' ? offerStatusHtml() : ''}
    </div>`;
}

// Collection-offer strip on the Buy tab: top standing offer + place-your-own + manage yours.
function collStripHtml() {
  const top = collOffers?.[0];
  const makeBusy = offerState && OFFER_BUSY.has(offerState.phase);
  const mineRows = (myOffers && myOffers.length)
    ? `<div class="trade-myoffers">
        <span class="trade-myoffers-h">${esc(t('trade.coll.mine.h'))}</span>
        ${myOffers.map(o => `
          <span class="trade-myoffer-chip ${o.funded === false ? 'is-unfunded' : ''}">
            ${o.funded === false ? `<span class="trade-myoffer-warn" title="${esc(t('trade.coll.unfunded'))}" aria-label="${esc(t('trade.coll.unfunded'))}">⚠</span>` : ''}
            ${esc(o.collection ? t('trade.coll.chipAny') : `#…${String(o.tokenId).slice(-4)}`)} · ${esc(fmtEthFiat(o.priceEth))}
            <button data-act="cancel-offer" data-offer="${esc(o.offerId)}" type="button" aria-label="${esc(t('trade.coll.cancel'))}" ${acceptBusyId ? 'disabled' : ''}>×</button>
          </span>`).join('')}
      </div>`
    : '';
  return `
    <div class="trade-colloffer" id="trade-colloffer">
      <div class="trade-colloffer-row">
        <div class="trade-colloffer-info">
          <span class="trade-colloffer-label">${esc(t('trade.coll.top'))} ${tipHtml('trade.coll.make.p')}</span>
          <span class="trade-colloffer-price">${top ? esc(fmtEthFiat(top.priceEth)) : esc(t('trade.coll.none'))}</span>
        </div>
        ${account && onZk() ? `
          <form class="trade-offer-form is-inline" id="trade-coll-offer-form" novalidate>
            <input id="trade-coll-offer-price" type="text" inputmode="decimal" placeholder="${esc(t('trade.offers.make.ph'))}" autocomplete="off" />
            <button class="trade-offer-btn" type="submit" ${makeBusy ? 'disabled' : ''}>${esc(t('trade.coll.make.btn'))}</button>
          </form>` : `<span class="trade-colloffer-hint">${esc(t('trade.coll.connectHint'))}</span>`}
      </div>
      ${offerCtx === 'browse' ? offerStatusHtml() : ''}
      ${mineRows}
    </div>`;
}
function patchCollStrip() {
  const el = root()?.querySelector('#trade-colloffer');
  if (el) el.outerHTML = collStripHtml();
}

// Instant-sell card on the Sell tab. Targets the best SPECIFIC offer on the picked
// Creature — collection-bid accepts are broken in the current Immutable SDK (criteria
// resolution bug; reported), so the collection top is shown for context only.
async function fetchSellPickOffers(tokenId) {
  try {
    const res = await fetch(`/api/market/creatures/offers/token/${encodeURIComponent(tokenId)}`, { headers: { Accept: 'application/json' } });
    const offers = res.ok ? ((await res.json()).offers || []) : [];
    if (String(sellSel) === String(tokenId)) { sellPickOffers = offers; patchSellView(); }
  } catch { if (String(sellSel) === String(tokenId)) { sellPickOffers = []; patchSellView(); } }
}

function instantSellHtml() {
  // Best payout wins: top direct offer on the picked Creature vs top collection-wide
  // offer (per-Creature; multi-unit bids fill one at a time).
  const spec = sellSel != null && Array.isArray(sellPickOffers) && sellPickOffers.length ? sellPickOffers[0] : null;
  const coll = collOffers?.[0] || null;
  const best = spec && coll ? (spec.netEth >= coll.netEth ? spec : coll) : (spec || coll);
  if (!best) return '';
  const busy = acceptState && ACCEPT_BUSY.has(acceptState.phase);
  let action;
  if (sellSel != null && sellPickOffers === null) {
    action = `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.offers.loading'))}</div>`;
  } else if (sellSel != null) {
    action = `<button class="trade-send trade-instant-btn" data-act="instant-sell" data-offer="${esc(best.offerId)}" type="button" ${busy ? 'disabled' : ''}>
      ${esc(t('trade.instant.btn').replace('{x}', fmtEthFiat(best.netEth)))}</button>`;
  } else {
    action = `<button class="trade-send trade-instant-btn" type="button" disabled>
        ${esc(t('trade.instant.btn').replace('{x}', fmtEthFiat(best.netEth)))}</button>
      <p class="trade-beta-micro">${esc(t('trade.instant.pick'))}</p>`;
  }
  return `
    <div class="trade-instant">
      <div class="trade-instant-head">
        <span class="trade-instant-ico" aria-hidden="true">⚡</span>
        <div>
          <b>${esc(t('trade.instant.h'))} </b>${tipHtml('trade.instant.tip')}
          <p>${esc(t(best === spec ? 'trade.instant.lineSpecific' : 'trade.instant.line').replace('{x}', fmtEthFiat(best.priceEth)).replace('{y}', fmtEthFiat(best.netEth)))}</p>
        </div>
      </div>
      ${action}
      ${offerCtx !== 'modal' ? acceptStatusHtml() : ''}
    </div>`;
}

function offerServerError(code) {
  const KEY = {
    insufficient: 'trade.err.offerFunds', bad_price: 'trade.err.badPrice',
    rate_limited: 'trade.err.rate', own_listing: 'trade.err.ownOffer',
    not_found: 'trade.err.offerGone', not_active: 'trade.err.offerGone',
  };
  return t(KEY[code] || 'trade.err.unavailable');
}
// Accept-side mapping: here 'insufficient' means the BIDDER's offer is no longer
// funded — very different from the make-offer context.
function acceptServerError(code) {
  const KEY = {
    // 'taker_float' fires (mislabeled by seaport-js) when accepting COLLECTION bids —
    // an SDK criteria-resolution bug, independent of balances. Specific offers work.
    taker_float: 'trade.err.collAccept',
    insufficient: 'trade.err.offerUnfunded', rate_limited: 'trade.err.rate',
    own_listing: 'trade.err.ownOffer', not_found: 'trade.err.offerGone',
    not_active: 'trade.err.offerGone', bad_token: 'trade.err.notOwner',
  };
  return t(KEY[code] || 'trade.err.unavailable');
}

function setOffer(phase, extra) { offerState = { phase, ...extra }; patchModal(); patchCollStrip(); }
function setAccept(phase, extra) { acceptState = { phase, ...extra }; patchModal(); patchSellView(); }

// Place an offer: prepare → (one-time ERC20 approval) → sign typed data → create.
async function handleMakeOffer(tokenId, priceRaw, ctx) {
  if (offerState && OFFER_BUSY.has(offerState.phase)) return;
  offerCtx = ctx;
  const price = (priceRaw || '').trim().replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,18})?$/.test(price) || Number(price) <= 0) return setOffer('error', { msg: t('trade.err.badPrice') });

  try {
    setOffer('prepare');
    const res = await fetch('/api/market/creatures/offer/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, priceEth: price, ...(tokenId != null ? { tokenId } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setOffer('error', { msg: offerServerError(data.error) });

    let signature = null;
    for (const action of (data.actions || [])) {
      if (action.type === 'TRANSACTION') {
        setOffer('approve');
        const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to: action.to, data: action.data, value: action.value && action.value !== '0x0' ? action.value : undefined }] });
        setOffer('approveWait');
        const receipt = await waitForReceipt(hash);
        if (!receipt || receipt.status !== '0x1') return setOffer('error', { msg: t('trade.err.txFailed') });
      } else if (action.type === 'SIGNABLE') {
        setOffer('sign');
        signature = await signTypedData(action.typedData);
      }
    }
    if (!signature) return setOffer('error', { msg: t('trade.err.unavailable') });

    setOffer('create');
    const createRes = await fetch('/api/market/creatures/offer/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderComponents: data.orderComponents, orderHash: data.orderHash, signature, collection: tokenId == null }),
    });
    const created = await createRes.json().catch(() => ({}));
    if (!createRes.ok) return setOffer('error', { msg: offerServerError(created.error) });

    setOffer('done');
    loadMyOffers();
    if (tokenId != null) loadTokenOffers(tokenId); else loadCollOffers();
  } catch (err) {
    console.error('Make offer failed:', err);
    setOffer('error', { msg: friendlyError(err) });
  }
}

// Accept an offer (sell a Creature into it): prepare → (NFT approval) → fill → receipt.
async function handleAcceptOffer(offerId, tokenId) {
  if (acceptBusyId) return;
  acceptBusyId = offerId;
  const offer = [...(collOffers || []), ...(tokenOffers || []), ...(myOffers || []), ...(sellPickOffers || [])].find(o => o.offerId === offerId);
  // Collection bids need to know WHICH Creature is being sold into them, and
  // multi-unit bids (buy N creatures) are filled one at a time.
  const fillToken = tokenId ?? (offer?.collection ? sellSel : null);
  const amountToFill = offer && offer.units > 1 ? '1' : null;
  try {
    setAccept('prepare');
    const res = await fetch('/api/market/creatures/offer/accept/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        offerId, takerAddress: account,
        ...(fillToken != null ? { tokenId: fillToken } : {}),
        ...(amountToFill != null ? { amountToFill } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setAccept('error', { msg: acceptServerError(data.error) });
      // A stale (unfunded/filled/cancelled/changed) offer should vanish from the UI promptly.
      if (['insufficient', 'not_found', 'not_active', 'taker_float'].includes(data.error)) {
        loadCollOffers();
        if (modalToken) loadTokenOffers(modalToken);
      }
      return;
    }

    for (const tx of (data.transactions || [])) {
      const isApproval = tx.purpose === 'APPROVAL';
      setAccept(isApproval ? 'approve' : 'fulfill');
      const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to: tx.to, data: tx.data, value: tx.value && tx.value !== '0x0' ? tx.value : undefined }] });
      setAccept(isApproval ? 'approveWait' : 'fulfillWait', { hash });
      const receipt = await waitForReceipt(hash);
      if (!receipt || receipt.status !== '0x1') { setAccept('error', { msg: t('trade.err.txFailed') }); return; }
      if (!isApproval) {
        setAccept('done', { hash });
        sellSel = null;
        refreshBalance();
        loadSellerData();
        loadCollOffers();
        if (modalToken) loadTokenOffers(modalToken);
        return;
      }
    }
    setAccept('error', { msg: t('trade.err.unavailable') });
  } catch (err) {
    console.error('Accept offer failed:', err);
    setAccept('error', { msg: friendlyError(err) });
  } finally {
    acceptBusyId = null;
    patchModal(); patchSellView(); patchCollStrip();
  }
}

// Cancel one of your own offers (gasless: sign the cancel payload).
async function handleCancelOffer(offerId) {
  if (acceptBusyId) return;
  acceptBusyId = offerId; patchCollStrip();
  try {
    const prepRes = await fetch('/api/market/creatures/cancel/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderIds: [offerId], accountAddress: account }),
    });
    const prep = await prepRes.json().catch(() => ({}));
    if (!prepRes.ok) throw Object.assign(new Error('prepare'), { friendly: offerServerError(prep.error) });
    const signature = await signTypedData(prep.typedData);
    const subRes = await fetch('/api/market/creatures/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderIds: [offerId], accountAddress: account, signature }),
    });
    if (!subRes.ok) throw Object.assign(new Error('submit'), { friendly: offerServerError((await subRes.json().catch(() => ({}))).error) });
    myOffers = (myOffers || []).filter(o => o.offerId !== offerId);
    loadCollOffers();
  } catch (err) {
    console.error('Cancel offer failed:', err);
    pendingFlash = err.friendly || friendlyError(err);
  } finally {
    acceptBusyId = null;
    if (pendingFlash) render(); else patchCollStrip();
  }
}

function modalHtml() {
  return `
    <div id="trade-modal" class="trade-modal" ${modalToken ? '' : 'hidden'} role="dialog" aria-modal="true" aria-label="${esc(t('trade.modal.aria'))}">
      <div class="trade-modal-backdrop" data-act="close"></div>
      <div class="trade-modal-card">${modalToken ? modalCardHtml() : ''}</div>
    </div>`;
}
function patchModal() {
  const m = root()?.querySelector('#trade-modal');
  if (!m) return;
  m.hidden = !modalToken;
  document.body.classList.toggle('trade-modal-open', !!modalToken);
  m.querySelector('.trade-modal-card').innerHTML = modalToken ? modalCardHtml() : '';
  // Focus the dialog on open only — status repaints during a buy must not steal focus.
  if (modalToken && !m.contains(document.activeElement)) m.querySelector('.trade-modal-close')?.focus();
}

// --- Wallet bar + actions ---
function flashBanner() {
  if (!pendingFlash) return '';
  const m = pendingFlash; pendingFlash = null;
  return `<div class="apply-alert" role="alert"><span aria-hidden="true">⚠</span><span>${esc(m)}</span></div>`;
}

// Compact wallet chip — lives inside the command bar, not a row of its own.
function walletBarHtml() {
  if (!eth()) {
    return `<div class="trade-bar">
      <span class="trade-bar-msg">${esc(t('trade.bar.install'))}</span>
      <a class="trade-mm-btn is-sm" href="https://metamask.io/download/" target="_blank" rel="noopener">
        <img class="trade-mm-logo" src="${METAMASK_IMG}" alt="" /><span>${esc(t('trade.install.btn'))}</span></a>
    </div>`;
  }
  if (!account) {
    return `<div class="trade-bar">
      <span class="trade-bar-msg">${esc(t('trade.bar.connectPrompt'))}</span>
      <button class="trade-mm-btn is-sm" data-act="connect" type="button" ${busy ? 'disabled' : ''}>
        <img class="trade-mm-logo" src="${METAMASK_IMG}" alt="" /><span>${esc(busy ? t('trade.connecting') : t('trade.connect.btn'))}</span></button>
    </div>`;
  }
  // Wrong network is an action, not a status — the pill itself switches.
  const net = onRightChain()
    ? `<span class="trade-net is-ok">${esc(coll === 'land' ? t('trade.net.eth') : t('trade.net.ok'))}</span>`
    : `<button class="trade-net is-bad" data-act="switch" type="button" title="${esc(t('trade.net.switch'))}">${esc(t('trade.net.bad'))}</button>`;
  // Live on-chain balances straight from the RPC — the user's ground truth when a
  // wallet UI mis-reports (e.g. MetaMask's phantom "insufficient IMX" on custom nets).
  const bal = coll === 'land'
    ? `<span class="trade-bar-bal" title="${esc(t('trade.balance.landLabel'))}">🗺️ <b id="trade-bal">—</b></span>
       <span class="trade-bar-bal">ETH <b id="trade-bal-eth">—</b></span>`
    : (onZk()
        ? `<span class="trade-bar-bal" title="${esc(t('trade.balance.label'))}">🐾 <b id="trade-bal">—</b></span>
           <span class="trade-bar-bal">ETH <b id="trade-bal-eth">—</b></span>
           <span class="trade-bar-bal">IMX <b id="trade-bal-imx">—</b></span>`
        : '');
  return `<div class="trade-bar is-connected">
    <img class="trade-mm-dot" src="${METAMASK_IMG}" alt="" />
    <code class="trade-addr" title="${esc(account)}">${esc(shortWallet(account))}</code>
    ${net}${bal ? `<span class="trade-bar-bals">${bal}</span>` : ''}
    <button class="apply-logout" data-act="disconnect" type="button">${esc(t('trade.disconnect'))}</button>
  </div>`;
}

// --- Filter bar (Creatures explorer) ---
// Browse like a pro: name search, rarity tiers, every trait as a faceted popover,
// price range, and sort — all server-filtered against the full listing snapshot.

function rarityFacet() {
  // Live counts come from the server; the tier vocabulary is stable so the chips can
  // render (uncounted) before the first response lands.
  const f = (browseFacets || []).find(x => /rarity/i.test(x.type));
  return { type: f?.type || 'Rarity', counts: new Map((f?.values || []).map(({ v, n }) => [v, n])) };
}

function traitSelected(type, v) { return flt.traits.get(type)?.has(v) || false; }

function toggleTrait(type, v) {
  const cur = flt.traits.get(type) || new Set();
  if (cur.has(v)) cur.delete(v); else cur.add(v);
  if (cur.size) flt.traits.set(type, cur); else flt.traits.delete(type);
}

function rarityChipsHtml() {
  const { type, counts } = rarityFacet();
  return RARITY_TIERS.map(tier => {
    const sel = traitSelected(type, tier);
    // A tier absent from the facets has zero listings — render it disabled, same as
    // an explicit zero (before the first response, counts are unknown: leave enabled).
    const n = browseFacets ? (counts.get(tier) ?? 0) : null;
    return `<button type="button" class="trade-flt-rchip ${sel ? 'is-on' : ''}" data-r="${tier.toLowerCase()}"
      data-act="flt-val" data-type="${esc(type)}" data-val="${esc(tier)}" aria-pressed="${sel}" ${n === 0 && !sel ? 'disabled' : ''}>
      <span class="trade-flt-rdot" aria-hidden="true"></span>${esc(tier)}${n != null ? `<span class="trade-flt-n">${n}</span>` : ''}
    </button>`;
  }).join('');
}

function traitPopHtml(f) {
  return `<div class="trade-flt-pop" role="listbox" aria-label="${esc(f.type)}">
    ${f.values.map(({ v, n }) => {
      const sel = traitSelected(f.type, v);
      return `<button type="button" class="trade-flt-opt ${sel ? 'is-on' : ''}" role="option" aria-selected="${sel}"
        data-act="flt-val" data-type="${esc(f.type)}" data-val="${esc(v)}" ${n === 0 && !sel ? 'disabled' : ''}>
        <span class="trade-flt-check" aria-hidden="true">${sel ? '✓' : ''}</span>
        <span class="trade-flt-optv">${esc(v)}</span><span class="trade-flt-n">${n}</span>
      </button>`;
    }).join('')}
  </div>`;
}

function traitDropsHtml() {
  if (!browseFacets) return `<span class="trade-flt-loading">${esc(t('trade.filter.loading'))}</span>`;
  return browseFacets.filter(f => !/rarity/i.test(f.type)).map(f => {
    const selCount = flt.traits.get(f.type)?.size || 0;
    const open = openFacet === f.type;
    return `
    <div class="trade-flt-dd ${open ? 'is-open' : ''}">
      <button type="button" class="trade-flt-ddbtn ${selCount ? 'has-sel' : ''}" data-act="flt-open" data-type="${esc(f.type)}"
        aria-expanded="${open}" aria-haspopup="listbox">
        ${esc(f.type)}${selCount ? `<span class="trade-flt-badge">${selCount}</span>` : ''}<span class="trade-flt-caret" aria-hidden="true">▾</span>
      </button>
      ${open ? traitPopHtml(f) : ''}
    </div>`;
  }).join('');
}

// "On sale ⟷ All …" — a view mode beside the filters, not one of them. The "All"
// label is dataset-specific ("All Creatures" vs "All Slimes").
function scopeSegHtml() {
  const ds = browseDataset();
  const opts = [['listed', 'trade.filter.scopeListed'], ['all', ds.scopeAll]];
  return opts.map(([v, key]) => `
    <button type="button" role="tab" class="seg-btn ${flt.scope === v ? 'is-active' : ''}"
      aria-selected="${flt.scope === v}" data-act="flt-scope" data-scope="${v}">${esc(t(key))}</button>`).join('');
}

function countLineHtml() {
  // Everything here is response-time state (browse*) — mixing in live flt state mid-
  // fetch produced nonsense like "103 in the collection". Dim it while a fetch runs.
  const ds = browseDataset();
  const allScope = browseScope === 'all';
  const denom = allScope ? browseCollectionTotal : browseListedTotal;
  if (browseTotal == null || denom == null) return '';
  const key = browseHadFilters ? ds.countFiltered : (allScope ? ds.countCollection : ds.countAll);
  const note = browseIndexing && flt.scope === 'all'
    ? ` <span class="trade-flt-note">${esc(t(ds.indexing))}</span>` : '';
  return `<span class="trade-flt-count ${listingsLoading ? 'is-stale' : ''}" role="status">${esc(t(key)
    .replace('{n}', browseTotal.toLocaleString()).replace('{total}', denom.toLocaleString()))}</span>${note}`;
}

function activeChipsHtml() {
  const chips = [];
  if (flt.q)   chips.push({ k: 'q',   label: `“${flt.q}”` });
  if (flt.min) chips.push({ k: 'min', label: `≥ ${flt.min} ETH` });
  if (flt.max) chips.push({ k: 'max', label: `≤ ${flt.max} ETH` });
  for (const [type, vals] of flt.traits) for (const v of vals) chips.push({ k: 't', type, v, label: `${type}: ${v}` });
  const count = countLineHtml();
  if (!chips.length) return count;
  return `${count}${chips.map(c => `
    <button type="button" class="trade-flt-chip" data-act="flt-rm" data-kind="${c.k}"
      ${c.type ? `data-type="${esc(c.type)}" data-val="${esc(c.v)}"` : ''} aria-label="${esc(t('trade.filter.removeAria').replace('{f}', c.label))}">
      ${esc(c.label)}<span class="trade-flt-x" aria-hidden="true">×</span>
    </button>`).join('')}
    <button type="button" class="trade-flt-clearall" data-act="flt-clear">${esc(t('trade.filter.clear'))}</button>`;
}

// Filter sidebar (desktop) / slide-up sheet (mobile): rarity, price and every trait
// as an inline accordion. Search/scope/sort live in the toolbar above the grid.
function filterSideHtml() {
  const pr = browsePriceRange;
  return `
  <aside class="trade-side ${fltOpenMobile ? 'is-open' : ''}" id="trade-side" aria-label="${esc(t('trade.filter.toggle'))}">
    <div class="trade-side-backdrop" data-act="flt-drawer"></div>
    <div class="trade-side-card">
      <div class="trade-side-head">
        <h3 class="trade-side-title">${esc(t('trade.filter.toggle'))}</h3>
        <button type="button" class="trade-flt-clearall" data-act="flt-clear">${esc(t('trade.filter.clear'))}</button>
        <button type="button" class="trade-side-x" data-act="flt-drawer" aria-label="${esc(t('trade.modal.close'))}">×</button>
      </div>
      ${browseDataset().hasRarityChips ? `<div class="trade-side-sec">
        <h4 class="trade-side-h">${esc(t('trade.filter.rarityH'))}</h4>
        <div class="trade-flt-rar" id="flt-rar" role="group" aria-label="${esc(t('trade.filter.rarityAria'))}">${rarityChipsHtml()}</div>
      </div>` : ''}
      <div class="trade-side-sec">
        <h4 class="trade-side-h">${esc(t('trade.filter.priceH'))}</h4>
        <div class="trade-flt-price" role="group" aria-label="${esc(t('trade.filter.priceAria'))}">
          <input id="flt-min" inputmode="decimal" autocomplete="off" placeholder="${pr ? esc(String(pr.min)) : 'min'}" value="${esc(flt.min)}" aria-label="${esc(t('trade.filter.minAria'))}" />
          <span class="trade-flt-dash" aria-hidden="true">–</span>
          <input id="flt-max" inputmode="decimal" autocomplete="off" placeholder="${pr ? esc(String(pr.max)) : 'max'}" value="${esc(flt.max)}" aria-label="${esc(t('trade.filter.maxAria'))}" />
          <span class="trade-flt-eth" aria-hidden="true">ETH</span>
        </div>
      </div>
      <div class="trade-side-sec">
        <h4 class="trade-side-h">${esc(t('trade.filter.traitsH'))}</h4>
        <div class="trade-flt-traits" id="flt-traits">${traitDropsHtml()}</div>
      </div>
      <button type="button" class="trade-send trade-side-done" data-act="flt-drawer">${esc(t('trade.filter.done'))}</button>
    </div>
  </aside>`;
}

// Slim toolbar above the grid: scope, search, sort — plus the sheet toggle on mobile.
function browseToolbarHtml() {
  const sorts = [['price-asc', 'sortPriceAsc'], ['price-desc', 'sortPriceDesc'], ['rarity', 'sortRarity'], ['newest', 'sortNewest']];
  return `
  <div class="trade-toolbar">
    <div class="seg trade-flt-scope" id="flt-scope" role="tablist" aria-label="${esc(t('trade.filter.scopeAria'))}">${scopeSegHtml()}</div>
    <label class="trade-flt-search">
      <svg class="trade-flt-sico" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input id="flt-q" type="search" autocomplete="off" enterkeyhint="search" placeholder="${esc(t('trade.filter.search'))}" value="${esc(flt.q)}" aria-label="${esc(t('trade.filter.search'))}" />
    </label>
    <select id="flt-sort" class="seg-select trade-flt-sort" aria-label="${esc(t('trade.filter.sortAria'))}">
      ${sorts.map(([v, k]) => `<option value="${v}" ${flt.sort === v ? 'selected' : ''}>${esc(t('trade.filter.' + k))}</option>`).join('')}
    </select>
    <button type="button" class="apply-btn-ghost trade-flt-toggle" data-act="flt-drawer" aria-expanded="${fltOpenMobile}" aria-controls="trade-side">
      ${esc(t('trade.filter.toggle'))}${fltCount() ? `<span class="trade-flt-badge">${fltCount()}</span>` : ''}
    </button>
  </div>
  <div class="trade-flt-active" id="flt-active">${activeChipsHtml()}</div>`;
}

// Re-render the dynamic parts of the filter UI (facet counts, chips, badges) WITHOUT
// touching the text inputs — focus and caret must survive every keystroke. The parts
// live in two places now (sidebar + toolbar), so query each by id from the root.
function patchFilters() {
  const r = root();
  if (!r || !isBrowseView()) return;
  const sc  = r.querySelector('#flt-scope');   if (sc)  sc.innerHTML = scopeSegHtml();
  const rar = r.querySelector('#flt-rar');     if (rar) rar.innerHTML = rarityChipsHtml();
  const tr  = r.querySelector('#flt-traits');  if (tr)  tr.innerHTML = traitDropsHtml();
  const act = r.querySelector('#flt-active');  if (act) act.innerHTML = activeChipsHtml();
  const tog = r.querySelector('.trade-flt-toggle');
  if (tog) tog.innerHTML = `${esc(t('trade.filter.toggle'))}${fltCount() ? `<span class="trade-flt-badge">${fltCount()}</span>` : ''}`;
  if (browsePriceRange) {
    const mn = r.querySelector('#flt-min'); if (mn) mn.placeholder = String(browsePriceRange.min);
    const mx = r.querySelector('#flt-max'); if (mx) mx.placeholder = String(browsePriceRange.max);
  }
}

// Push state back into the inputs after a programmatic change (chip ×, clear all).
function syncFilterInputs() {
  const r = root();
  if (!r) return;
  const q  = r.querySelector('#flt-q');   if (q)  q.value = flt.q;
  const mn = r.querySelector('#flt-min'); if (mn) mn.value = flt.min;
  const mx = r.querySelector('#flt-max'); if (mx) mx.value = flt.max;
}

// Mobile filter sheet open/close — one place owns the class + body scroll lock.
function setFltSheet(open) {
  fltOpenMobile = open;
  document.body.classList.toggle('trade-sheet-open', open);
  const r = root();
  r?.querySelector('#trade-side')?.classList.toggle('is-open', open);
  r?.querySelector('.trade-flt-toggle')?.setAttribute('aria-expanded', String(open));
}

// --- Inventory filter (Sell & Transfer pickers) ---
// Same faceted search as Browse, but run client-side over the owned set (server-enriched
// with traits + rank). Reuses the .trade-flt-* styling; no price/scope (your items aren't
// all priced/listed). Trait popovers share `openFacet` with Browse — only one tab shows
// at a time. The match/facet logic mirrors the server's browseMatch/computeBrowseFacets.

// The pickable owned set for the active tab (owned minus your active listings — you can't
// sell or transfer something that's already listed). Same base for Sell and Transfer.
function invBase() {
  if (!Array.isArray(owned)) return [];
  const listedIds = new Set((mine || []).map(l => String(l.tokenId)));
  return owned.filter(o => !listedIds.has(String(o.tokenId)));
}
function invTraitSelected(type, v) { return invFlt.traits.get(type)?.has(v) || false; }
function invToggleTrait(type, v) {
  const cur = invFlt.traits.get(type) || new Set();
  if (cur.has(v)) cur.delete(v); else cur.add(v);
  if (cur.size) invFlt.traits.set(type, cur); else invFlt.traits.delete(type);
}
function invActive() { return !!(invFlt.q || invFlt.traits.size); }
// OR within a trait type, AND across types (skipType lets faceting count "if I also pick this").
function invMatch(it, skipType) {
  if (invFlt.q) {
    const hay = `${it.name || ''} ${it.tokenId} ${it.coords ? `${it.coords.x} ${it.coords.y}` : ''}`.toLowerCase();
    if (!hay.includes(invFlt.q.toLowerCase())) return false;
  }
  for (const [type, vals] of invFlt.traits) {
    if (type === skipType) continue;
    if (!vals.has((it.traits || {})[type])) return false;
  }
  return true;
}
function computeInvFacets() {
  const base = invBase();
  const types = new Map(); // type -> Map(value -> count)
  for (const it of base) for (const [type, v] of Object.entries(it.traits || {})) {
    if (v == null || v === '') continue;
    if (!types.has(type)) types.set(type, new Map());
    const m = types.get(type); if (!m.has(v)) m.set(v, 0);
  }
  for (const [type, vals] of types) for (const it of base) {
    const v = (it.traits || {})[type];
    if (v != null && v !== '' && invMatch(it, type)) vals.set(v, (vals.get(v) || 0) + 1);
  }
  const out = [];
  for (const [type, vals] of types) {
    const values = [...vals.entries()].map(([v, n]) => ({ v, n }));
    if (/rarity/i.test(type)) values.sort((a, b) => (RARITY_TIERS.indexOf(a.v) + 1 || 99) - (RARITY_TIERS.indexOf(b.v) + 1 || 99));
    else values.sort((a, b) => a.v.localeCompare(b.v));
    out.push({ type, values });
  }
  out.sort((a, b) => a.type.localeCompare(b.type));
  return out;
}
// "Rarest first" uses a statistical rank when present (LAND slimes carry one), else the
// Rarity tier (Creatures expose it as a trait), else token number as a stable tiebreak.
function invRarityRank(it) {
  if (it.rank != null) return it.rank;
  const tier = it.traits && Object.entries(it.traits).find(([k]) => /rarity/i.test(k))?.[1];
  const i = RARITY_TIERS.indexOf(tier);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}
function invFilteredItems() {
  const items = invBase().filter(it => invMatch(it, null));
  const byNum = (a, b) => { try { const d = BigInt(a.tokenId) - BigInt(b.tokenId); return d < 0n ? -1 : d > 0n ? 1 : 0; } catch { return String(a.tokenId).localeCompare(String(b.tokenId)); } };
  if (invFlt.sort === 'num-desc') items.sort((a, b) => byNum(b, a));
  else if (invFlt.sort === 'rank') items.sort((a, b) => (invRarityRank(a) - invRarityRank(b)) || byNum(a, b));
  else items.sort(byNum); // num-asc
  return items;
}

function invRarityChipsHtml() {
  const facet = (invFacets || []).find(x => /rarity/i.test(x.type));
  if (!facet) return '';
  const counts = new Map(facet.values.map(({ v, n }) => [v, n]));
  return RARITY_TIERS.map(tier => {
    const sel = invTraitSelected(facet.type, tier);
    const n = counts.get(tier) ?? 0;
    if (n === 0 && !sel) return ''; // only tiers actually present in your inventory
    return `<button type="button" class="trade-flt-rchip ${sel ? 'is-on' : ''}" data-r="${tier.toLowerCase()}"
      data-act="inv-val" data-type="${esc(facet.type)}" data-val="${esc(tier)}" aria-pressed="${sel}">
      <span class="trade-flt-rdot" aria-hidden="true"></span>${esc(tier)}<span class="trade-flt-n">${n}</span>
    </button>`;
  }).join('');
}
function invTraitPopHtml(f) {
  return `<div class="trade-flt-pop" role="listbox" aria-label="${esc(f.type)}">
    ${f.values.map(({ v, n }) => {
      const sel = invTraitSelected(f.type, v);
      return `<button type="button" class="trade-flt-opt ${sel ? 'is-on' : ''}" role="option" aria-selected="${sel}"
        data-act="inv-val" data-type="${esc(f.type)}" data-val="${esc(v)}" ${n === 0 && !sel ? 'disabled' : ''}>
        <span class="trade-flt-check" aria-hidden="true">${sel ? '✓' : ''}</span>
        <span class="trade-flt-optv">${esc(v)}</span><span class="trade-flt-n">${n}</span>
      </button>`;
    }).join('')}
  </div>`;
}
function invTraitDropsHtml() {
  // Show every trait type as an accordion entry (same as the Buy sidebar) — a single value
  // is fine here; it just opens to the one value you hold.
  return (invFacets || []).filter(f => !/rarity/i.test(f.type) && f.values.length).map(f => {
    const selCount = invFlt.traits.get(f.type)?.size || 0;
    const open = openFacet === f.type;
    return `
    <div class="trade-flt-dd ${open ? 'is-open' : ''}">
      <button type="button" class="trade-flt-ddbtn ${selCount ? 'has-sel' : ''}" data-act="inv-open" data-type="${esc(f.type)}"
        aria-expanded="${open}" aria-haspopup="listbox">
        ${esc(f.type)}${selCount ? `<span class="trade-flt-badge">${selCount}</span>` : ''}<span class="trade-flt-caret" aria-hidden="true">▾</span>
      </button>
      ${open ? invTraitPopHtml(f) : ''}
    </div>`;
  }).join('');
}
function invActiveChipsHtml() {
  const chips = [];
  if (invFlt.q) chips.push({ k: 'q', label: `“${invFlt.q}”` });
  for (const [type, vals] of invFlt.traits) for (const v of vals) chips.push({ k: 't', type, v, label: `${type}: ${v}` });
  const total = invBase().length;
  const count = total ? `<span class="trade-flt-count">${esc(t('trade.filter.invCount').replace('{n}', invFilteredItems().length).replace('{total}', total))}</span>` : '';
  if (!chips.length) return count;
  return `${count}${chips.map(c => `
    <button type="button" class="trade-flt-chip" data-act="inv-rm" data-kind="${c.k}"
      ${c.type ? `data-type="${esc(c.type)}" data-val="${esc(c.v)}"` : ''} aria-label="${esc(t('trade.filter.removeAria').replace('{f}', c.label))}">
      ${esc(c.label)}<span class="trade-flt-x" aria-hidden="true">×</span>
    </button>`).join('')}
    <button type="button" class="trade-flt-clearall" data-act="inv-clear">${esc(t('trade.filter.clear'))}</button>`;
}
function invFltCount() {
  let n = invFlt.q ? 1 : 0;
  for (const vals of invFlt.traits.values()) n += vals.size;
  return n;
}
// Is there an inventory worth showing the filter sidebar for? (owned loaded + has facets)
function invHasFilters() {
  return Array.isArray(owned) && invBase().length >= 1 && (invFacets || []).some(f => f.values.length);
}
// The Sell/Transfer filter SIDEBAR — same markup + classes as the Buy sidebar
// (filterSideHtml), minus the Price section (your items aren't priced). Rarity shows for
// Creatures; LAND has none. Traits render as the vertical accordion via .trade-side CSS.
function invFilterSideHtml() {
  const hasRarity = coll === 'creatures' && (invFacets || []).some(f => /rarity/i.test(f.type));
  const drops = invTraitDropsHtml();
  return `
  <aside class="trade-side ${fltOpenMobile ? 'is-open' : ''}" id="trade-side" aria-label="${esc(t('trade.filter.toggle'))}">
    <div class="trade-side-backdrop" data-act="flt-drawer"></div>
    <div class="trade-side-card">
      <div class="trade-side-head">
        <h3 class="trade-side-title">${esc(t('trade.filter.toggle'))}</h3>
        <button type="button" class="trade-flt-clearall" data-act="inv-clear">${esc(t('trade.filter.clear'))}</button>
        <button type="button" class="trade-side-x" data-act="flt-drawer" aria-label="${esc(t('trade.modal.close'))}">×</button>
      </div>
      ${hasRarity ? `<div class="trade-side-sec">
        <h4 class="trade-side-h">${esc(t('trade.filter.rarityH'))}</h4>
        <div class="trade-flt-rar" id="inv-rar" role="group" aria-label="${esc(t('trade.filter.rarityAria'))}">${invRarityChipsHtml()}</div>
      </div>` : ''}
      ${drops ? `<div class="trade-side-sec">
        <h4 class="trade-side-h">${esc(t('trade.filter.traitsH'))}</h4>
        <div class="trade-flt-traits" id="inv-traits">${drops}</div>
      </div>` : ''}
      <button type="button" class="trade-send trade-side-done" data-act="flt-drawer">${esc(t('trade.filter.done'))}</button>
    </div>
  </aside>`;
}
// The Sell/Transfer toolbar — same markup as the Buy toolbar (browseToolbarHtml), minus
// the on-sale/all scope toggle. Search + inventory sorts + the mobile Filters button.
function invToolbarHtml() {
  const sorts = [['rank', 'sortRarity'], ['num-asc', 'sortNumAsc'], ['num-desc', 'sortNumDesc']];
  return `
  <div class="trade-toolbar">
    <label class="trade-flt-search">
      <svg class="trade-flt-sico" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input id="inv-q" type="search" autocomplete="off" enterkeyhint="search" placeholder="${esc(t('trade.filter.searchInv'))}" value="${esc(invFlt.q)}" aria-label="${esc(t('trade.filter.searchInv'))}" />
    </label>
    <select id="inv-sort" class="seg-select trade-flt-sort" aria-label="${esc(t('trade.filter.sortAria'))}">
      ${sorts.map(([v, k]) => `<option value="${v}" ${invFlt.sort === v ? 'selected' : ''}>${esc(t('trade.filter.' + k))}</option>`).join('')}
    </select>
    <button type="button" class="apply-btn-ghost trade-flt-toggle" data-act="flt-drawer" aria-expanded="${fltOpenMobile}" aria-controls="trade-side">
      ${esc(t('trade.filter.toggle'))}${invFltCount() ? `<span class="trade-flt-badge">${invFltCount()}</span>` : ''}
    </button>
  </div>
  <div class="trade-flt-active" id="inv-active">${invActiveChipsHtml()}</div>`;
}
// Re-render the live filter bits + the picker WITHOUT touching the search input (focus +
// caret survive every keystroke), mirroring how patchFilters works for Browse.
function patchInvFilter() {
  const r = root(); if (!r) return;
  invFacets = computeInvFacets();
  const rar = r.querySelector('#inv-rar');    if (rar) rar.innerHTML = invRarityChipsHtml();
  const tr  = r.querySelector('#inv-traits'); if (tr)  tr.innerHTML = invTraitDropsHtml();
  const act = r.querySelector('#inv-active'); if (act) act.innerHTML = invActiveChipsHtml();
  const tog = r.querySelector('.trade-flt-toggle');
  if (tog) tog.innerHTML = `${esc(t('trade.filter.toggle'))}${invFltCount() ? `<span class="trade-flt-badge">${invFltCount()}</span>` : ''}`;
  const pick = r.querySelector('#trade-pick-wrap');
  if (pick) pick.innerHTML = tradeTab === 'transfer' ? transferPickerHtml() : sellPickerHtml();
}
function resetInvFilter() { invFlt = { q: '', traits: new Map(), sort: 'rank' }; invFacets = null; }
// Close-popover repaint routes to the right tab (Esc / outside-click share `openFacet`).
function repaintFacetUI() { (tradeTab === 'sell' || tradeTab === 'transfer') ? patchInvFilter() : patchFilters(); }

function browseHtml() {
  const subTip = coll === 'land' ? 'trade.land.subSlimes' : 'trade.browse.sub';
  return `<section class="trade-browse has-side">
    ${filterSideHtml()}
    <div class="trade-main">
      <div class="trade-results-head">
        <h3 class="trade-browse-h">${esc(t('trade.browse.h'))} ${tipHtml(subTip)}</h3>
        <div class="trade-browse-actions">
          <select class="seg-select trade-currency" id="trade-currency" aria-label="${esc(t('trade.currency.aria'))}">
            ${CURRENCIES.map(c => `<option value="${c}" ${currency === c ? 'selected' : ''}>${c.toUpperCase()}</option>`).join('')}
          </select>
          <button class="apply-btn-ghost trade-refresh" data-act="refresh" type="button">${esc(t('trade.refresh'))}</button>
        </div>
      </div>
      ${browseToolbarHtml()}
      ${coll === 'creatures' ? collStripHtml() : ''}
      <div class="trade-grid" id="trade-grid">${gridInnerHtml()}</div>
      <div class="trade-loadmore" id="trade-loadmore">${loadMoreHtml()}</div>
    </div>
  </section>`;
}

// --- Seller hub (my listings + sell + transfer) ---

async function loadSellerData() {
  if (!account || sellerLoading) return;
  if (coll === 'creatures' && !onZk()) return; // creature data needs the wallet usable on zkEVM
  sellerLoading = true;
  try {
    if (coll === 'land') {
      // LAND: owned + the wallet's own active listings, both from OpenSea (chain-independent).
      const [o, m] = await Promise.all([
        fetch(`/api/market/land/owned/${account}`).then(r => r.ok ? r.json() : { items: [] }),
        fetch(`/api/market/land/mine/${account}`).then(r => r.ok ? r.json() : { items: [] }),
      ]);
      owned = o.items || [];
      mine = m.items || [];
    } else {
      const [o, m] = await Promise.all([
        fetch(`/api/market/creatures/owned/${account}`).then(r => r.ok ? r.json() : { items: [] }),
        fetch(`/api/market/creatures/mine/${account}`).then(r => r.ok ? r.json() : { items: [] }),
      ]);
      owned = o.items || [];
      mine = m.items || [];
    }
  } catch (err) {
    console.error('Seller data failed:', err);
    owned = owned || []; mine = mine || [];
  } finally {
    sellerLoading = false;
    patchSellView();
    patchTransferView();
    refreshBalance();
  }
}

function sellStatusHtml() {
  if (!sellState) return '';
  const STEP_KEY = {
    prepare: 'trade.sell.preparing',
    approve: 'trade.sell.approve',
    approveWait: 'trade.sell.approveWait',
    sign: 'trade.sell.sign',
    create: 'trade.sell.create',
  };
  if (sellState.phase === 'done') {
    return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t(skey('trade.sell.done')))}</span></div>`;
  }
  if (sellState.phase === 'error') {
    return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(sellState.msg)}</span></div>`;
  }
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(skey(STEP_KEY[sellState.phase])))}</span></div>`;
}

function myListingsHtml() {
  if (!mine || !mine.length) return '';
  return `
    <div class="trade-mine" id="trade-mine">
      <h4 class="trade-form-h">${esc(t('trade.mine.h'))}</h4>
      <div class="trade-mine-row">
        ${mine.map(l => `
          <div class="trade-mine-card">
            ${coll === 'land' && petUrl(l)
              ? `<img src="${esc(petUrl(l))}" ${l.image ? `data-fallback="${esc(l.image)}"` : ''} alt="" loading="lazy" />`
              : (l.image ? `<img src="${esc(l.image)}" alt="" loading="lazy" />` : '<div class="trade-tile-noimg">🐾</div>')}
            <div class="trade-mine-info">
              <span class="trade-mine-name">${esc(l.name)}</span>
              <span class="trade-mine-price">${esc(fmtEthFiat(l.priceEth))}</span>
            </div>
            <button class="trade-mine-cancel" data-act="cancel-listing" data-listing="${esc(l.listingId)}" type="button"
              ${cancelBusy ? 'disabled' : ''}>${esc(cancelBusy === l.listingId ? t('trade.mine.cancelling') : t('trade.mine.cancel'))}</button>
          </div>`).join('')}
      </div>
    </div>`;
}

function sellPickerHtml() {
  if (owned === null) return `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t(skey('trade.sell.loadingOwned')))}</div>`;
  if (!invBase().length) return `<p class="trade-form-p">${esc(t(skey('trade.sell.none')))}</p>`;
  const sellable = invFilteredItems();
  if (!sellable.length) return `<p class="trade-form-p">${esc(t('trade.filter.invNone'))} <button type="button" class="trade-flt-clearall" data-act="inv-clear">${esc(t('trade.filter.clear'))}</button></p>`;
  return `
    <div class="trade-pick" role="listbox" aria-label="${esc(t(skey('trade.sell.pickAria')))}">
      ${sellable.map(o => `
        <button class="trade-pick-tile ${String(sellSel) === String(o.tokenId) ? 'is-sel' : ''}" type="button"
          role="option" aria-selected="${String(sellSel) === String(o.tokenId)}"
          data-act="sell-pick" data-token="${esc(o.tokenId)}" title="${esc(o.name)}">
          ${coll === 'land' && petUrl(o)
            ? `<img src="${esc(petUrl(o))}" ${o.image ? `data-fallback="${esc(o.image)}"` : ''} alt="" loading="lazy" />`
            : (o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy" />` : '<div class="trade-tile-noimg">🐾</div>')}
          <span>${esc(o.name.replace(/^Highrise (Creature|LAND) /, ''))}</span>
        </button>`).join('')}
    </div>`;
}

// Collection scope: Creatures (zkEVM) ⟷ LAND (Ethereum). Sits above the action tabs.
function collSwitcherHtml() {
  return `<div class="seg trade-coll-switch" role="tablist" aria-label="${esc(t('trade.coll.aria'))}">
    ${Object.entries(COLLECTIONS).map(([id, c]) => `
      <button type="button" role="tab" class="seg-btn ${coll === id ? 'is-active' : ''}"
        aria-selected="${coll === id}" data-act="coll" data-coll="${id}">${c.ico} ${esc(t(c.labelKey))}</button>`).join('')}
  </div>`;
}

function maybeLoadSeller() {
  if (account && owned === null && !sellerLoading && (coll === 'land' || onZk())) loadSellerData();
}

// Segmented Buy / Sell / Transfer control (reuses the Market panel's .seg pattern).
function tradeTabsHtml() {
  const TABS = [['buy', 'trade.tab.buy'], ['sell', 'trade.tab.sell'], ['transfer', 'trade.tab.transfer']];
  return `<div class="seg trade-tabs" role="tablist" aria-label="${esc(t('trade.tabs.aria'))}">
    ${TABS.map(([id, key]) => `
      <button type="button" role="tab" class="seg-btn ${tradeTab === id ? 'is-active' : ''}"
        aria-selected="${tradeTab === id}" data-act="trade-tab" data-tab="${id}">${esc(t(key))}</button>`).join('')}
    <button type="button" class="trade-safety-pill" data-act="safety-guide" title="${esc(t('trade.safety.pill.title'))}">
      ${SHIELD_SVG}<span>${esc(t('trade.safety.pill'))}</span></button>
  </div>`;
}

// Wallet gate for the Sell / Transfer tabs (Buy browsing needs no wallet).
function walletGateHtml() {
  if (!eth()) {
    return `<div class="apply-state-box">
      <div class="apply-state-ico" aria-hidden="true">🦊</div>
      <p>${esc(t('trade.bar.install'))}</p>
      <a class="trade-mm-btn is-sm" href="https://metamask.io/download/" target="_blank" rel="noopener" style="margin-top:16px">
        <img class="trade-mm-logo" src="${METAMASK_IMG}" alt="" /><span>${esc(t('trade.install.btn'))}</span></a>
    </div>`;
  }
  if (!account) {
    return `<div class="apply-state-box">
      <div class="apply-state-ico" aria-hidden="true">🔐</div>
      <p>${esc(t('trade.bar.connectPrompt'))}</p>
      <button class="trade-mm-btn is-sm" data-act="connect" type="button" ${busy ? 'disabled' : ''} style="margin-top:16px">
        <img class="trade-mm-logo" src="${METAMASK_IMG}" alt="" /><span>${esc(busy ? t('trade.connecting') : t('trade.connect.btn'))}</span></button>
    </div>`;
  }
  return `<div class="apply-state-box">
    <div class="apply-state-ico" aria-hidden="true">🔀</div>
    <h3>${esc(t(coll === 'land' ? 'trade.net.wrongEth.h' : 'trade.net.wrong.h'))}</h3>
    <p>${esc(t(coll === 'land' ? 'trade.net.wrongEth.p' : 'trade.net.wrong.p'))}</p>
    <button class="apply-btn-ghost" data-act="switch" type="button">${esc(t('trade.net.switch'))}</button>
  </div>`;
}

// LAND reuses the Creature sell views; copy that must read differently has a `.land`
// variant in the locale file. Falls back to the base (Creature) copy when none exists.
function skey(base) {
  if (coll !== 'land') return base;
  const k = `${base}.land`;
  return t(k) === k ? base : k;
}

function sellViewHtml() {
  if (!account || !onRightChain()) return walletGateHtml();
  const sellBusy = sellState && SELL_BUSY_PHASES.has(sellState.phase);
  const isLand = coll === 'land';
  invFacets = computeInvFacets();
  // Workbench split: picker browses wide on the left, the action card (price + list)
  // stays put on the right. The price/duration inputs must stay inside the form
  // (handleSell reads them). LAND lists on OpenSea's Seaport (native ETH).
  const wb = `
    <div class="trade-workbench">
      <div class="trade-wb-main">
        <h4 class="trade-form-h">${esc(t(skey('trade.sell.h')))} ${tipHtml(skey('trade.sell.p'))}</h4>
        <div id="trade-pick-wrap">${sellPickerHtml()}</div>
      </div>
      <div class="trade-wb-side">
        <form class="trade-form" id="trade-sell-form" novalidate>
          <label class="trade-field"><span>${esc(t('trade.sell.price'))}</span>
            <input id="trade-sell-price" type="text" inputmode="decimal" placeholder="${esc(t('trade.sell.price.ph'))}" autocomplete="off" /></label>
          ${isLand ? landSellDurationHtml() : ''}
          ${isLand ? `<div class="trade-sell-net" id="trade-sell-net">${landSellNetHtml('')}</div>` : ''}
          <button class="trade-send" id="trade-sell-submit" type="submit" ${sellBusy || !sellSel ? 'disabled' : ''}>
            ${esc(t('trade.sell.btn'))} <span aria-hidden="true">→</span></button>
          <div id="trade-sell-status" role="status" aria-live="polite">${sellStatusHtml()}</div>
        </form>
        ${isLand ? '' : instantSellHtml()}
      </div>
    </div>`;
  // Same left filter sidebar + toolbar as Buy, once there's an inventory worth filtering.
  return invHasFilters()
    ? `<section class="trade-browse has-side">${invFilterSideHtml()}<div class="trade-main">${myListingsHtml()}${invToolbarHtml()}${wb}</div></section>`
    : `${myListingsHtml()}${wb}`;
}

// LAND listing length (Seaport startTime→endTime). A short expiry means abandoned test
// listings self-clear; the seller can still cancel early on-chain via "My listings".
function landSellDurationHtml() {
  return `<label class="trade-field"><span>${esc(t('trade.sell.duration'))}</span>
    <select id="trade-sell-duration">
      ${[1, 3, 7, 14, 30].map(d => `<option value="${d}" ${d === 7 ? 'selected' : ''}>${esc(t('trade.sell.days').replace('{n}', String(d)))}</option>`).join('')}
    </select></label>`;
}

// Live "you'll receive" estimate under the LAND price field — the 6% (1% OpenSea + 5%
// royalty) is shown up front; the exact split is in the order the wallet shows on sign.
function landSellNetHtml(priceStr) {
  const p = parseFloat(String(priceStr).replace(',', '.'));
  if (!(p > 0)) return `<span class="trade-sell-net-hint">${esc(t('trade.sell.feeNote'))}</span>`;
  return `<span class="trade-sell-net-hint">${t('trade.sell.netNote').replace('{net}', `<b>${esc(fmtEth(p * 0.94))} ETH</b>`).replace('{fee}', '6')}</span>`;
}

// Picker of transferable Creatures (owned minus actively listed — transferring a
// listed Creature would leave a phantom listing behind).
function transferPickerHtml() {
  if (owned === null) return `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.sell.loadingOwned'))}</div>`;
  const base = invBase();
  const hiddenNote = owned.length > base.length
    ? `<p class="trade-form-p">${esc(t('trade.transfer.listedNote'))}</p>` : '';
  if (!base.length) return `<p class="trade-form-p">${esc(t('trade.transfer.none'))}</p>${hiddenNote}`;
  const transferable = invFilteredItems();
  if (!transferable.length) return `<p class="trade-form-p">${esc(t('trade.filter.invNone'))} <button type="button" class="trade-flt-clearall" data-act="inv-clear">${esc(t('trade.filter.clear'))}</button></p>${hiddenNote}`;
  return `
    <div class="trade-pick" role="listbox" aria-label="${esc(t('trade.transfer.pick'))}">
      ${transferable.map(o => `
        <button class="trade-pick-tile ${String(transferSel) === String(o.tokenId) ? 'is-sel' : ''}" type="button"
          role="option" aria-selected="${String(transferSel) === String(o.tokenId)}"
          data-act="transfer-pick" data-token="${esc(o.tokenId)}" title="${esc(o.name)}">
          ${coll === 'land' && petUrl(o)
            ? `<img src="${esc(petUrl(o))}" ${o.image ? `data-fallback="${esc(o.image)}"` : ''} alt="" loading="lazy" />`
            : (o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy" />` : '<div class="trade-tile-noimg">🐾</div>')}
          <span>${esc(o.name.replace(/^Highrise (Creature|LAND) /, ''))}</span>
        </button>`).join('')}
    </div>${hiddenNote}`;
}

// Live recipient assessment rendering. Hard blocks (bad checksum / protocol contract)
// kill the Send button; a never-used address demands an explicit confirmation.
function transferCheckHtml() {
  const c = transferCheck;
  if (!c) return '';
  if (c === 'loading') return `<div class="trade-check-row is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t('trade.check.checking'))}</span></div>`;
  if (!c.valid) {
    const KEY = { checksum: 'trade.check.checksumBad', protocol: 'trade.check.protocol', format: 'trade.err.badAddr' };
    return `<div class="trade-check-row is-err"><span aria-hidden="true">⛔</span><span>${esc(t(KEY[c.reason] || 'trade.err.badAddr'))}</span></div>`;
  }
  // Best case: it's another of the user's own connected accounts — proven by the
  // wallet itself, no warning needed at all.
  if (c.connectedOwn) {
    return `<div class="trade-check-row is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.check.ownAccount'))}</span></div>`;
  }
  const rows = [];
  if (c.checksum === 'ok') rows.push(`<div class="trade-check-row is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.check.checksumOk'))}</span></div>`);
  if (c.active) {
    rows.push(`<div class="trade-check-row is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.check.active'))}</span></div>`);
    if (c.creatures > 0) rows.push(`<div class="trade-check-row is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.check.holds').replace('{n}', String(c.creatures)))}</span></div>`);
    if (c.contract) rows.push(`<div class="trade-check-row is-warn"><span aria-hidden="true">⚠</span><span>${esc(t('trade.check.contract'))}</span></div>`);
  } else {
    // Calm info tone, not an alarm — a fresh wallet is normal; the diligence is the
    // ten-second visual match. The hard "why" lives behind the ⓘ for the curious.
    rows.push(`<div class="trade-check-row is-info"><span aria-hidden="true">🔍</span><span>${esc(t(c.activityKnown ? 'trade.check.fresh' : 'trade.check.unknown'))} ${tipHtml('trade.check.fresh.tip')}</span></div>`);
    // Spaced-out copy of the typed address so the visual match is actually
    // humanly doable against what the recipient's wallet shows.
    const chunked = c.addr ? `${c.addr.slice(0, 2)} ${c.addr.slice(2).match(/.{1,4}/g).join(' ')}` : '';
    if (chunked) {
      rows.push(`<div class="trade-check-compare"><span>${esc(t('trade.check.compare'))}</span><code>${esc(chunked)}</code></div>`);
    }
    rows.push(`
      <label class="trade-ack">
        <input type="checkbox" id="trade-transfer-ack" ${transferAck ? 'checked' : ''} />
        <span>${esc(t('trade.check.freshAck'))}</span>
      </label>`);
  }
  return rows.join('');
}

// Send only when: a Creature is picked, the address passed every hard check, and any
// soft warning has been explicitly acknowledged.
function transferSendAllowed() {
  const c = transferCheck;
  return transferSel != null && c && c !== 'loading' && c.valid && (c.active || transferAck);
}

function transferViewHtml() {
  if (!account || !onRightChain()) return walletGateHtml();
  invFacets = computeInvFacets();
  // Same workbench split as Sell. Recipient input, check rows, send button and status
  // must all stay inside the form — handleTransferSubmit queries them through it.
  const wb = `
    <div class="trade-workbench">
      <div class="trade-wb-main">
        <h4 class="trade-form-h">${esc(t('trade.transfer.h'))} ${tipHtml('trade.transfer.p')}</h4>
        <span class="trade-field-label">${esc(t('trade.transfer.pick'))}</span>
        <div id="trade-pick-wrap">${transferPickerHtml()}</div>
      </div>
      <div class="trade-wb-side">
        <form class="trade-form" id="trade-transfer-form" novalidate>
          <label class="trade-field"><span>${esc(t('trade.field.recipient'))}</span>
            <input id="trade-to" type="text" placeholder="0x…" autocomplete="off" spellcheck="false" /></label>
          <div id="trade-to-check" aria-live="polite">${transferCheckHtml()}</div>
          <button class="trade-send" id="trade-send" type="submit" ${transferSendAllowed() ? '' : 'disabled'}>${esc(t('trade.transfer.btn'))} <span aria-hidden="true">→</span></button>
          <div class="trade-status" id="trade-status" role="status" aria-live="polite"></div>
        </form>
      </div>
    </div>`;
  // Same left filter sidebar + toolbar as Buy, once there's an inventory worth filtering.
  return invHasFilters()
    ? `<section class="trade-browse has-side">${invFilterSideHtml()}<div class="trade-main">${invToolbarHtml()}${wb}</div></section>`
    : wb;
}

function patchTransferView() {
  const view = root()?.querySelector('#trade-view');
  if (!view || tradeTab !== 'transfer') return;
  const to = view.querySelector('#trade-to')?.value;
  view.innerHTML = transferViewHtml();
  const input = view.querySelector('#trade-to');
  if (input && to) input.value = to;
}
function patchTransferCheck() {
  const el = root()?.querySelector('#trade-to-check');
  if (el) el.innerHTML = transferCheckHtml();
  const btn = root()?.querySelector('#trade-transfer-form #trade-send');
  if (btn) btn.disabled = !transferSendAllowed();
}

// Debounced server-side recipient assessment as the user types/pastes.
function queueTransferCheck(raw) {
  clearTimeout(transferCheckTimer);
  transferAck = false;
  const addr = (raw || '').trim();
  if (!addr) { transferCheck = null; patchTransferCheck(); return; }
  transferCheck = 'loading'; patchTransferCheck();
  transferCheckTimer = setTimeout(async () => {
    // Instant local rejections — no round-trip needed.
    const lower = addr.toLowerCase();
    if (!IS_ADDR.test(lower)) { transferCheck = { addr, valid: false, reason: 'format' }; patchTransferCheck(); return; }
    if (lower === account)    { transferCheck = { addr, valid: false, reason: 'format' }; patchTransferCheck(); return; }
    if (lower === ZERO)       { transferCheck = { addr, valid: false, reason: 'protocol' }; patchTransferCheck(); return; }
    // The strongest possible proof: the recipient is another account the user has
    // connected in their own wallet — key-holdership confirmed by MetaMask itself.
    try {
      const accs = (await eth().request({ method: 'eth_accounts' })) || [];
      if (accs.map(a => String(a).toLowerCase()).includes(lower)) {
        transferCheck = { addr, valid: true, connectedOwn: true, active: true, checksum: 'none', contract: false, creatures: null };
        patchTransferCheck();
        return;
      }
    } catch { /* fall through to the on-chain assessment */ }
    try {
      const res = await fetch('/api/market/creatures/transfer/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ to: addr, chain: coll === 'land' ? 'ethereum' : 'zkevm' }),
      });
      const c = res.ok ? await res.json() : { valid: true, active: false, activityKnown: false, checksum: 'none', contract: false, creatures: null };
      const cur = root()?.querySelector('#trade-to')?.value?.trim();
      if (cur === addr) { transferCheck = { addr, ...c }; patchTransferCheck(); }
    } catch {
      const cur = root()?.querySelector('#trade-to')?.value?.trim();
      if (cur === addr) { transferCheck = { addr, valid: true, active: false, activityKnown: false, checksum: 'none', contract: false, creatures: null }; patchTransferCheck(); }
    }
  }, 500);
}

function viewHtml() {
  if (tradeTab === 'sell')     return `<section class="trade-actions" id="trade-view">${sellViewHtml()}</section>`;
  if (tradeTab === 'transfer') return `<section class="trade-actions" id="trade-view">${transferViewHtml()}</section>`;
  return `<div id="trade-view">${browseHtml()}</div>`;
}

// Re-render the active Sell view in place, preserving the typed price — a picker
// click or a cancelled listing must never wipe what the user entered.
function patchSellView() {
  const view = root()?.querySelector('#trade-view');
  if (!view || tradeTab !== 'sell') return;
  const price = view.querySelector('#trade-sell-price')?.value;
  view.innerHTML = sellViewHtml();
  const input = view.querySelector('#trade-sell-price');
  if (input && price) input.value = price;
}
function patchSellStatus() {
  const st = root()?.querySelector('#trade-sell-status');
  if (st) st.innerHTML = sellStatusHtml();
  const btn = root()?.querySelector('#trade-sell-submit');
  if (btn) btn.disabled = !!(sellState && SELL_BUSY_PHASES.has(sellState.phase)) || !sellSel;
}
function setSell(phase, extra) { sellState = { phase, ...extra }; patchSellStatus(); }

// Sign a server-built EIP-712 payload with the connected wallet.
function signTypedData(typedData) {
  return eth().request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typedData)] });
}

function sellServerError(code) {
  const KEY = {
    insufficient: 'trade.err.notOwner', bad_price: 'trade.err.badPrice',
    bad_token: 'trade.err.badId', rate_limited: 'trade.err.rate',
    not_owner: 'trade.err.notOwner', not_found: 'trade.err.notOwner',
    disabled: 'trade.err.sellDisabled', blocked_account: 'trade.err.osBlocked',
  };
  return t(KEY[code] || 'trade.err.unavailable');
}

async function handleSell(form) {
  if (sellState && SELL_BUSY_PHASES.has(sellState.phase)) return;
  if (coll === 'land') return handleSellLand(form);
  const priceRaw = (form.querySelector('#trade-sell-price').value || '').trim().replace(',', '.');
  if (!sellSel) return setSell('error', { msg: t('trade.err.noSel') });
  if (!/^\d{1,6}(\.\d{1,18})?$/.test(priceRaw) || Number(priceRaw) <= 0) {
    return setSell('error', { msg: t('trade.err.badPrice') });
  }

  try {
    setSell('prepare');
    const res = await fetch('/api/market/creatures/sell/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, tokenId: sellSel, priceEth: priceRaw }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setSell('error', { msg: sellServerError(data.error) });

    let signature = null;
    for (const action of (data.actions || [])) {
      if (action.type === 'TRANSACTION') { // one-time collection approval
        setSell('approve');
        const hash = await eth().request({
          method: 'eth_sendTransaction',
          params: [{ from: account, to: action.to, data: action.data, value: action.value && action.value !== '0x0' ? action.value : undefined }],
        });
        setSell('approveWait', { hash });
        const receipt = await waitForReceipt(hash);
        if (!receipt || receipt.status !== '0x1') return setSell('error', { msg: t('trade.err.txFailed') });
      } else if (action.type === 'SIGNABLE') {
        setSell('sign');
        signature = await signTypedData(action.typedData);
      }
    }
    if (!signature) return setSell('error', { msg: t('trade.err.unavailable') });

    setSell('create');
    const createRes = await fetch('/api/market/creatures/sell/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderComponents: data.orderComponents, orderHash: data.orderHash, signature }),
    });
    const created = await createRes.json().catch(() => ({}));
    if (!createRes.ok) return setSell('error', { msg: sellServerError(created.error) });

    setSell('done');
    sellSel = null;
    form.reset();
    loadSellerData();      // refresh "my listings" + picker
    loadListings(true);    // the new listing appears in browse
  } catch (err) {
    console.error('Sell failed:', err);
    setSell('error', { msg: friendlyError(err) });
  }
}

// LAND listing: build + sign a Seaport order on Ethereum mainnet, then relay it to
// OpenSea. The server constructs the order (so fees/recipients can't be tampered with);
// the wallet signs the EIP-712 order and, the first time only, a one-off conduit approval.
async function handleSellLand(form) {
  const priceRaw = (form.querySelector('#trade-sell-price').value || '').trim().replace(',', '.');
  const durationDays = Number(form.querySelector('#trade-sell-duration')?.value) || 7;
  if (!sellSel) return setSell('error', { msg: t(skey('trade.err.noSel')) });
  if (!/^\d{1,6}(\.\d{1,18})?$/.test(priceRaw) || Number(priceRaw) <= 0) {
    return setSell('error', { msg: t('trade.err.badPrice') });
  }

  try {
    setSell('prepare');
    await switchToChain('0x1'); // sign + approve happen on mainnet (no-op if already there)
    const res = await fetch('/api/market/land/sell/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, tokenId: sellSel, priceEth: priceRaw, durationDays }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setSell('error', { msg: sellServerError(data.error) });

    let signature = null;
    for (const action of (data.actions || [])) {
      if (action.type === 'TRANSACTION') { // one-time setApprovalForAll to OpenSea's conduit
        setSell('approve');
        const hash = await eth().request({
          method: 'eth_sendTransaction',
          params: [{ from: account, to: action.to, data: action.data, value: action.value && action.value !== '0x0' ? action.value : undefined }],
        });
        setSell('approveWait', { hash });
        const receipt = await waitForReceipt(hash);
        if (!receipt || receipt.status !== '0x1') return setSell('error', { msg: t('trade.err.txFailed') });
      } else if (action.type === 'SIGNABLE') {
        setSell('sign');
        signature = await signTypedData(action.typedData);
      }
    }
    if (!signature) return setSell('error', { msg: t('trade.err.unavailable') });

    setSell('create');
    const createRes = await fetch('/api/market/land/sell/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderParameters: data.orderParameters, signature }),
    });
    const created = await createRes.json().catch(() => ({}));
    if (!createRes.ok) return setSell('error', { msg: sellServerError(created.error) });

    setSell('done');
    sellSel = null;
    form.reset();
    loadSellerData();      // refresh "my listings" + picker
    loadListings(true);    // the new listing appears in browse (after OpenSea indexes it)
  } catch (err) {
    console.error('LAND sell failed:', err);
    setSell('error', { msg: friendlyError(err) });
  }
}

async function handleCancelListing(listingId) {
  if (cancelBusy) return;
  if (coll === 'land') return handleCancelLandListing(listingId);
  cancelBusy = listingId; patchSellView();
  try {
    const prepRes = await fetch('/api/market/creatures/cancel/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderIds: [listingId], accountAddress: account }),
    });
    const prep = await prepRes.json().catch(() => ({}));
    if (!prepRes.ok) throw Object.assign(new Error('prepare'), { friendly: sellServerError(prep.error) });

    const signature = await signTypedData(prep.typedData);

    const subRes = await fetch('/api/market/creatures/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderIds: [listingId], accountAddress: account, signature }),
    });
    const sub = await subRes.json().catch(() => ({}));
    if (!subRes.ok) throw Object.assign(new Error('submit'), { friendly: sellServerError(sub.error) });

    mine = (mine || []).filter(l => l.listingId !== listingId);
    loadListings(true); // drop it from browse too
  } catch (err) {
    console.error('Cancel failed:', err);
    pendingFlash = err.friendly || friendlyError(err);
  } finally {
    cancelBusy = null;
    if (pendingFlash) render(); else patchSellView();
  }
}

// Cancel a LAND listing on-chain (Seaport cancel). Costs a little mainnet gas, but it
// truly invalidates the order — an off-chain hide would leave the signature fillable.
async function handleCancelLandListing(orderHash) {
  cancelBusy = orderHash; patchSellView();
  try {
    const prepRes = await fetch('/api/market/land/cancel/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderHash, accountAddress: account }),
    });
    const prep = await prepRes.json().catch(() => ({}));
    if (!prepRes.ok) throw Object.assign(new Error('prepare'), { friendly: sellServerError(prep.error) });

    await switchToChain('0x1');
    for (const tx of (prep.transactions || [])) {
      const hash = await eth().request({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: tx.to, data: tx.data, value: tx.value && tx.value !== '0x0' ? tx.value : undefined }],
      });
      const receipt = await waitForReceipt(hash);
      if (!receipt || receipt.status !== '0x1') throw Object.assign(new Error('tx'), { friendly: t('trade.err.txFailed') });
    }

    mine = (mine || []).filter(l => l.listingId !== orderHash);
    loadListings(true); // drop it from browse too
  } catch (err) {
    console.error('LAND cancel failed:', err);
    pendingFlash = err.friendly || friendlyError(err);
  } finally {
    cancelBusy = null;
    if (pendingFlash) render(); else patchSellView();
  }
}

async function handleTransferSubmit(form) {
  const status = form.querySelector('#trade-status');
  const btn    = form.querySelector('#trade-send');
  const fail = m => { status.className = 'trade-status is-error'; status.innerHTML = `<span aria-hidden="true">⚠</span><span>${esc(m)}</span>`; };
  const info = m => { status.className = 'trade-status is-info';  status.innerHTML = `<span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(m)}</span>`; };
  const done = (msg, hash) => {
    status.className = 'trade-status is-ok';
    status.innerHTML = `<span aria-hidden="true">✓</span><span>${esc(msg)} <a href="${esc(txExplorerUrl(hash))}" target="_blank" rel="noopener">${esc(t('trade.status.view'))}</a></span>`;
  };

  if (btn.disabled) return;
  const tokenId = transferSel;
  const to = (form.querySelector('#trade-to').value || '').trim().toLowerCase();
  // Belt and braces — the button is disabled unless these hold, but state can race.
  if (tokenId == null)         return fail(t('trade.err.noTransferSel'));
  if (!IS_ADDR.test(to))       return fail(t('trade.err.badAddr'));
  if (to === account)          return fail(t('trade.err.self'));
  if (to === ZERO)             return fail(t('trade.err.zero'));
  if (!transferSendAllowed() || transferCheck?.addr?.toLowerCase() !== to) {
    return fail(t('trade.err.badAddr'));
  }

  btn.disabled = true;
  try {
    info(t('trade.status.checking'));
    // ownerOf reads via the wallet provider — ensure it's on the collection's chain.
    await switchToChain(C().chainHex);
    const owner = await ownerOf(C().contract, tokenId);
    if (owner === null)    { fail(t('trade.err.noToken'));  btn.disabled = false; return; }
    if (owner !== account) { fail(t('trade.err.notOwner')); btn.disabled = false; return; }
    info(t('trade.status.confirm'));
    const hash = await sendTransfer(C().contract, tokenId, to);
    done(t('trade.status.sent'), hash);
    transferSel = null; transferCheck = null; transferAck = false;
    form.querySelector('#trade-to').value = '';
    refreshBalance();
    loadSellerData(); // the Creature left this wallet — refresh pickers
  } catch (err) {
    console.error('Transfer failed:', err);
    fail(friendlyError(err));
    btn.disabled = !transferSendAllowed();
  }
}

async function refreshBalance() {
  const el = root()?.querySelector('#trade-bal');
  if (!el) return;
  if (coll === 'land') {
    // LAND count from the owned list (loaded by loadSellerData), mainnet ETH from the
    // server (provider-independent — works whatever chain the wallet sits on).
    el.textContent = Array.isArray(owned) ? String(owned.length) : '—';
    try {
      const ee = await fetch(`/api/market/creatures/eth-elsewhere/${account}`).then(r => r.ok ? r.json() : null);
      const ethEl = root()?.querySelector('#trade-bal-eth');
      if (ethEl) ethEl.textContent = ee?.mainnetEthWei != null ? fmtWeiEth(BigInt(ee.mainnetEthWei)) : '—';
    } catch { /* leave em-dash */ }
    return;
  }
  const [bal, zkEth, imx] = await Promise.all([readBalance(), readErc20(IMX_ETH_TOKEN, account), readNative(account)]);
  el.textContent = bal == null ? '—' : String(bal);
  const ethEl = root()?.querySelector('#trade-bal-eth');
  if (ethEl) ethEl.textContent = fmtWeiEth(zkEth);
  const imxEl = root()?.querySelector('#trade-bal-imx');
  if (imxEl) imxEl.textContent = fmtWeiEth(imx);
}

// --- Render + events ---
function render() {
  const el = root();
  if (!el) return;
  el.setAttribute('aria-busy', 'false');
  // One command bar carries collection, action tabs and wallet — the old stack of
  // full-width rows (wallet bar / switcher / tabs) cost three screens of chrome.
  el.innerHTML = `${flashBanner()}
    <div class="trade-command">${collSwitcherHtml()}${tradeTabsHtml()}${walletBarHtml()}</div>
    <div id="trade-mmwarn-slot">${walletNoticeHtml()}</div>
    <div id="trade-bridgebar-slot">${bridgeBannerHtml()}</div>
    ${viewHtml()}${modalHtml()}${safetyHtml()}`;
  ensureDelegation();
  if (account && (coll === 'land' || onZk())) {
    refreshBalance();
    maybeLoadSeller();
    if (coll === 'creatures' && myOffers === null) loadMyOffers();
  }
}

function onClick(e) {
  const target = e.target.closest('[data-act]');
  if (!target) return;
  switch (target.dataset.act) {
    case 'open':       return openModal(target.dataset.token);
    case 'close':      return closeModal();
    case 'buy':        return handleBuy(target.dataset.listing);
    case 'trade-tab':
      if (tradeTab === target.dataset.tab) return;
      tradeTab = target.dataset.tab;
      setFltSheet(false);
      openFacet = null; // browse + inventory share the popover state; don't carry it across
      render();
      if (tradeTab === 'sell' || tradeTab === 'transfer') maybeLoadSeller();
      return;
    case 'coll': {
      if (coll === target.dataset.coll || !COLLECTIONS[target.dataset.coll]) return;
      coll = target.dataset.coll;
      try { localStorage.setItem('hcc-trade-coll', coll); } catch { /* fine */ }
      tokenOffers = null;
      resetBrowseForView(); // clears the grid/filters; scope defaults per the new view
      syncTradeUrl();
      resetSellerState();
      render();
      loadListings(true);
      if (coll === 'creatures') loadCollOffers();
      maybeLoadSeller();
      return;
    }
    case 'sell-pick':
      sellSel = String(sellSel) === String(target.dataset.token) ? null : target.dataset.token;
      sellState = null;
      sellPickOffers = null;
      // Instant-sell-into-offers is Creatures-only; LAND has no in-site offers yet.
      if (sellSel != null && coll === 'creatures') fetchSellPickOffers(sellSel);
      return patchSellView();
    case 'transfer-pick':
      transferSel = String(transferSel) === String(target.dataset.token) ? null : target.dataset.token;
      return patchTransferView();
    case 'cancel-listing': return handleCancelListing(target.dataset.listing);
    case 'accept-offer':   return handleAcceptOffer(target.dataset.offer);
    case 'instant-sell':   return handleAcceptOffer(target.dataset.offer, sellSel);
    case 'cancel-offer':   return handleCancelOffer(target.dataset.offer);
    case 'bridge-now':     return handleBridgeNow();
    case 'bridge-dismiss': return dismissBridge();
    case 'mmwarn-dismiss':
      try { localStorage.setItem('hcc-mmwarn-' + mmBuggyVersion, '1'); } catch { /* fine */ }
      return patchWalletNotice();
    case 'safety-ack':
      if (safetyRemainingMs() > 0) return; // button is disabled; belt and braces
      try { localStorage.setItem(SAFETY_ACK, '1'); } catch { /* fine */ }
      safetyOpen = false;
      render();
      return connect();
    case 'safety-close':
      safetyOpen = false;
      return render();
    case 'safety-guide': return openSafetyGuide();
    case 'connect':    return connect();
    case 'disconnect': account = null; resetSellerState(); return render();
    case 'switch':     return switchNetwork(target);
    case 'loadmore':   return loadListings(false);
    case 'retry':      return loadListings(true);
    case 'refresh':    return loadListings(true);
    case 'flt-scope':
      if (flt.scope === target.dataset.scope) return;
      flt.scope = target.dataset.scope === 'all' ? 'all' : 'listed';
      return applyFilters();
    case 'flt-val':
      toggleTrait(target.dataset.type, target.dataset.val);
      return applyFilters();
    case 'flt-open':
      openFacet = openFacet === target.dataset.type ? null : target.dataset.type;
      return patchFilters();
    case 'flt-clear':
      resetFilters();
      syncFilterInputs();
      return applyFilters();
    case 'flt-rm': {
      const { kind, type, val } = target.dataset;
      if (kind === 'q') flt.q = '';
      else if (kind === 'min') flt.min = '';
      else if (kind === 'max') flt.max = '';
      else if (kind === 't') toggleTrait(type, val);
      syncFilterInputs();
      return applyFilters();
    }
    case 'flt-drawer':
      return setFltSheet(!fltOpenMobile);
    // --- Inventory filter (Sell/Transfer pickers) ---
    case 'inv-val':
      invToggleTrait(target.dataset.type, target.dataset.val);
      return patchInvFilter();
    case 'inv-open':
      openFacet = openFacet === target.dataset.type ? null : target.dataset.type;
      return patchInvFilter();
    case 'inv-clear': {
      resetInvFilter();
      openFacet = null;
      const q = root()?.querySelector('#inv-q'); if (q) q.value = '';
      return patchInvFilter();
    }
    case 'inv-rm': {
      const { kind, type, val } = target.dataset;
      if (kind === 'q') { invFlt.q = ''; const q = root()?.querySelector('#inv-q'); if (q) q.value = ''; }
      else if (kind === 't') invToggleTrait(type, val);
      return patchInvFilter();
    }
  }
}
function onSubmit(e) {
  if (e.target?.id === 'trade-transfer-form') { e.preventDefault(); handleTransferSubmit(e.target); }
  if (e.target?.id === 'trade-sell-form')     { e.preventDefault(); handleSell(e.target); }
  if (e.target?.id === 'trade-offer-form') {
    e.preventDefault();
    handleMakeOffer(e.target.dataset.token, e.target.querySelector('#trade-offer-price')?.value, 'modal');
  }
  if (e.target?.id === 'trade-coll-offer-form') {
    e.preventDefault();
    handleMakeOffer(null, e.target.querySelector('#trade-coll-offer-price')?.value, 'browse');
  }
}
function onChange(e) {
  if (e.target?.id === 'trade-transfer-ack') {
    transferAck = e.target.checked;
    const btn = root()?.querySelector('#trade-transfer-form #trade-send');
    if (btn) btn.disabled = !transferSendAllowed();
    return;
  }
  if (e.target?.id === 'flt-sort') {
    flt.sort = e.target.value;
    return applyFilters();
  }
  if (e.target?.id === 'inv-sort') {
    invFlt.sort = e.target.value;
    return patchInvFilter();
  }
  if (e.target?.id !== 'trade-currency') return;
  currency = e.target.value;
  try { localStorage.setItem('hcc-trade-cur', currency); } catch { /* private mode — fine */ }
  patchGrid();
  if (modalToken) patchModal();
}
function onInput(e) {
  if (e.target?.id === 'trade-to') return queueTransferCheck(e.target.value);
  if (e.target?.id === 'inv-q') {
    invFlt.q = e.target.value.trim();
    return patchInvFilter(); // patches facets/chips/picker, not the input — focus survives
  }
  if (e.target?.id === 'trade-sell-price') {
    const net = root()?.querySelector('#trade-sell-net'); // LAND only — element absent for Creatures
    if (net) net.innerHTML = landSellNetHtml(e.target.value);
    return;
  }
  if (e.target?.id === 'flt-q') {
    flt.q = e.target.value.trim();
    return applyFilters(300);
  }
  if (e.target?.id === 'flt-min' || e.target?.id === 'flt-max') {
    const v = e.target.value.trim().replace(',', '.');
    if (v === '' || /^\d*\.?\d*$/.test(v)) flt[e.target.id === 'flt-min' ? 'min' : 'max'] = v;
    return applyFilters(400);
  }
}
function resetSellerState() {
  owned = null; mine = null; sellSel = null; sellState = null; cancelBusy = null;
  myOffers = null; offerState = null; offerCtx = null; acceptState = null; acceptBusyId = null;
  sellPickOffers = null;
  transferSel = null; transferCheck = null; transferAck = false;
  resetInvFilter(); openFacet = null; // inventory traits differ per collection
  clearTimeout(transferCheckTimer);
}
function ensureDelegation() {
  const el = root();
  if (!el || el._hccDelegated) return;
  el._hccDelegated = true;
  el.addEventListener('click', onClick);
  el.addEventListener('submit', onSubmit);
  el.addEventListener('change', onChange);
  el.addEventListener('input', onInput);
  // Image fallbacks (error doesn't bubble — capture phase): LAND pet renders fall
  // back to the real plot image when the parcel has no pet or the render fails.
  el.addEventListener('error', e => {
    const img = e.target;
    if (img?.tagName === 'IMG' && img.dataset.fallback) {
      img.src = img.dataset.fallback;
      img.classList.remove('is-pet');
      delete img.dataset.fallback;
    }
  }, true);
}

let escWired = false;
function wireEsc() {
  if (escWired) return; escWired = true;
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (openFacet) { openFacet = null; repaintFacetUI(); return; }
    if (fltOpenMobile) { setFltSheet(false); return; }
    if (safetyOpen) { safetyOpen = false; render(); return; }
    if (modalToken) closeModal();
  });
  // Any click outside an open trait popover closes it (multi-select clicks inside
  // keep it open — picking three Eyes values shouldn't take three reopens).
  document.addEventListener('click', e => {
    if (openFacet && !e.target.closest('.trade-flt-dd')) { openFacet = null; repaintFacetUI(); }
  });
}

function wireProviderEvents() {
  const p = eth();
  if (!p || p._hccTradeWired) return;
  p._hccTradeWired = true;
  p.on?.('accountsChanged', accs => { account = (accs[0] || '').toLowerCase() || null; resetSellerState(); render(); });
  p.on?.('chainChanged',   cid  => { chainId = cid; resetSellerState(); render(); });
}

export async function loadMarketplace() {
  loadedOnce = true;
  try { const c = localStorage.getItem('hcc-trade-cur'); if (c && CURRENCIES.includes(c)) currency = c; } catch { /* fine */ }
  try { const k = localStorage.getItem('hcc-trade-coll'); if (k && COLLECTIONS[k]) coll = k; } catch { /* fine */ }
  flt.scope = browseDataset().defaultScope;
  // Deep link (/trade?coll=…&token=…): land straight on that token's detail modal.
  // The coll param wins over the saved preference for this visit, without persisting.
  let deepToken = null;
  try {
    const params = new URLSearchParams(location.search);
    if (COLLECTIONS[params.get('coll')]) coll = params.get('coll');
    const tk = (params.get('token') || '').trim();
    if (/^\d{1,80}$/.test(tk)) deepToken = tk;
  } catch { /* malformed query — ignore */ }
  wireEsc();
  wireTips();
  wireProviderEvents();
  detectWalletBug();
  if (eth()) {
    try {
      const accs = await eth().request({ method: 'eth_accounts' });
      account = (accs[0] || '').toLowerCase() || null;
      if (account) chainId = await eth().request({ method: 'eth_chainId' });
    } catch { /* leave disconnected */ }
  }
  // Resume a bridge that was in flight when the page was last closed — the user can
  // navigate away or reload without ever losing sight of their money.
  const saved = loadSavedBridge();
  if (saved) {
    bridgeJob = saved;
    if (saved.phase === 'waiting' || saved.phase === 'slow') {
      bridgeJob.phase = 'waiting';
      trackBridge();
    }
  }
  render();
  loadListings(true);
  if (coll === 'creatures') loadCollOffers();
  if (deepToken) openDeepLink(deepToken);
}

// Re-render from in-memory state on language switch (no refetch).
export function rerenderMarketplace() {
  if (loadedOnce && root()) render();
}
