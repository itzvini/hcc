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
const SEL_WETH_WITHDRAW = '0x2e1a7d4d'; // withdraw(uint256) — unwrap WETH → native ETH (1:1)
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
// The reverse, for sellers cashing out their proceeds: ETH-on-zkEVM → ETH-on-Ethereum.
const CASHOUT_URL = `https://app.squidrouter.com/?chains=13371,1&tokens=${IMX_ETH_TOKEN},${SQUID_NATIVE}`;
// LAND offers settle in WETH on Ethereum mainnet — a seller's proceeds arrive as this ERC-20
// (invisible in MetaMask until added). Canonical mainnet WETH.
const WETH_TOKEN = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
// IMX is the NATIVE gas token on Immutable zkEVM — every on-chain action (a buy, a sell's
// one-time collection approval, a transfer) needs a little, and the ETH ERC-20 can't pay
// for it. This deep-link bridges native ETH on Ethereum → native IMX on zkEVM (both the
// Squid native placeholder, resolved per chain); the one-tap quote does the same exactly.
const GAS_BRIDGE_URL = `https://app.squidrouter.com/?chains=1,13371&tokens=${SQUID_NATIVE},${SQUID_NATIVE}`;
// IMX held on Ethereum mainnet is an ERC-20 — when the user already has some, bridging it
// straight to native IMX on zkEVM is cheaper than swapping ETH (no DEX leg). This deep-link
// is preset for exactly that; the one-tap quote takes the same source via {from:'imx'}.
const IMX_L1_TOKEN = '0xf57e7e7c23978c3caec3c3548e3d615c346e79ff';
const GAS_BRIDGE_URL_IMX = `https://app.squidrouter.com/?chains=1,13371&tokens=${IMX_L1_TOKEN},${SQUID_NATIVE}`;
const GAS_MIN_WEI = 10n ** 15n;        // < 0.001 IMX on hand → surface the gas helper
const GAS_OK_WEI  = 5n * 10n ** 15n;   // ≥ 0.005 IMX → "you're set for gas" (matches the buy panel)
const GAS_TARGET_IMX = 5;              // one-tap top-up target, in IMX (tunable) — a lot of
                                       // runway (gas is fractions of a cent/tx) while still
                                       // clearing typical bridge minimums; deep-link covers the rest
// Fiat on-ramp ("top up with card") — for a wallet that holds nothing anywhere, so there's
// nothing to bridge: they need to ACQUIRE crypto. The card path is a Transak deep-link built
// server-side (/api/market/onramp) with the destination NETWORK pinned and the buy amount
// prefilled — both zkEVM (Creatures) and Ethereum (LAND) go through it. This constant is only
// the keyless FALLBACK: Immutable's own hosted on-ramp page, used when no Transak key is set
// (it also delivers to zkEVM, but can't pin the network/amount, so it defaults to ETH-on-L1
// and the buyer has to pick the network themselves — hence it's the fallback, not the default).
const ONRAMP_URL_ZKEVM = 'https://toolkit.immutable.com/onramp/';
// A bridge is signed on Ethereum MAINNET, so the wallet must hold the bridge INPUT *plus*
// enough ETH left over to pay that tx's L1 gas. Squid's quoted `feeUsd` covers the bridge
// + destination gas, NOT the source-chain execution gas the wallet itself pays — so we keep
// a separate headroom. When mainnet ETH can't cover input + this reserve, offering a bridge
// just produces an unfundable tx (the MetaMask "Review alert" → "something went wrong" a
// short wallet hits); we route to the card top-off instead. ~$5 of mainnet gas at typical
// fees — generous enough to clear gas spikes, small enough not to block real bridges.
const BRIDGE_GAS_RESERVE_ETH = 0.0015;

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
let sellUnit = 'eth';       // unit the seller types a listing price in: 'eth' or a fiat code
let offerUnit = 'eth';      // unit the buyer types an offer/bid in: 'eth' or a fiat code
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
let browseIndexTimer = null;   // quiet re-poll while the server is still cataloguing
const RARITY_TIERS = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
// LAND plot tiers — a parcel attribute (the "Tier" facet), shown as their own always-
// visible chip group rather than buried in the trait dropdowns. Ordered common → premium.
const TIER_VALUES = ['Standard', 'Premium'];

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

// Gas-help state — the shared "you just need a little IMX for gas on zkEVM" panel that
// Buy, Sell and Transfer all surface when a wallet can't cover its on-chain action.
// {ctx:'buy'|'sell'|'transfer', imxBal, mainnetEthWei, quote:'loading'|null|{...}}; null = idle.
let gasState = null;

// Which action tab is active inside the Trade panel: 'buy' | 'sell' | 'transfer'.
let tradeTab = 'buy';

// Offers state. tokenOffers = bids on the open modal's token; collOffers = standing
// collection-wide ("floor") offers, best first; myOffers = the user's own active offers.
let tokenOffers = null;    // null = loading/not loaded
let collOffers = null;
let collOffersError = false; // true = last load failed → empty strip means "couldn't load", not "none"
let collOffersRetryTimer = null; // pending auto-retry after a failed load (self-heals the strip)
let collOffersRetryAttempt = 0;  // backoff step for the auto-retry
// LAND standing offers (OpenSea collection bids, WETH) — separate from the Creature set.
let landCollOffers = null;
let landCollOffersError = false;
let landCollOffersRetryTimer = null;
let landCollOffersRetryAttempt = 0;
let landMyOffers = null;   // the connected wallet's own active LAND offers (for cancel)
let myOffers = null;
let offerState = null;     // staged make-offer: prepare|approve|approveWait|sign|create|done|error
let offerCtx = null;       // where the make-offer flow is running: 'modal' | 'browse'
let landOfferState = null; // staged LAND make-offer (separate: mainnet + WETH wrap/approve)
let acceptState = null;    // staged accept-offer: prepare|approve|approveWait|fulfill|fulfillWait|done|error
let acceptBusyId = null;   // offerId being accepted (disables its button)
let pendingAccept = null;  // { kind, …params, netEth } awaiting the user's sale confirmation
let landAcceptState = null; // staged LAND accept (separate flow: mainnet + WETH)
let landAcceptBusy = false;
let unwrapState = null;     // one-tap WETH → ETH unwrap after a LAND sale: send|wait|done|error
const OFFER_BUSY = new Set(['prepare', 'wrap', 'wrapWait', 'approve', 'approveWait', 'sign', 'create']);
const ACCEPT_BUSY = new Set(['prepare', 'approve', 'approveWait', 'fulfill', 'fulfillWait']);

// Seller state: your Creatures (sell picker), your active listings, and the staged
// sell / cancel progress. Loaded lazily once connected on the right network.
let owned = null;          // null = not loaded; [] = loaded, none
let mine = null;           // null = not loaded; [] = loaded, none
let sellerLoading = false;
// Activity history ("History" tab): past buys, sales, transfers (+ Creature listing events).
// Loaded lazily on first visit, separately from the seller hub — it's read-only by address.
// NB: named histItems, NOT `history` — that would shadow the global window.history that
// syncTradeUrl() relies on (a null shadow there silently broke collection switching).
let histItems = null;      // null = not loaded; [] = loaded, none
let historyLoading = false;
let historyError = false;
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
// A trait's collection-wide rarity as a percentage, e.g. 0.032 → "3.2%". One decimal
// under 10% (where it carries signal), whole numbers above. Returns '' for unknowns.
function fmtTraitPct(p) {
  if (p == null || !Number.isFinite(Number(p))) return '';
  const v = Number(p) * 100;
  if (v > 0 && v < 0.1) return '<0.1%';
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}
// Look up a trait value's rarity % from the current browse facets (collection-wide,
// scope-independent). Null when facets aren't loaded or the value isn't catalogued.
function traitPctOf(type, value) {
  const f = (browseFacets || []).find(x => x.type === type);
  return f?.values.find(x => x.v === value)?.pct ?? null;
}
// USD to prefill the card on-ramp so the buyer RECEIVES enough crypto. Transak's fee (~3.5–5.5%)
// plus price drift between prefill and purchase mean the delivered crypto is a few % under what
// the fiat buys at spot — so a raw price-in-USD prefill leaves them short (e.g. $199 → only
// 0.1197 ETH for a 0.1278 ETH Creature). ~12% headroom covers the max fee + drift; the field
// stays editable and any surplus just lands in their wallet. Returns 0 when no rate is known.
const ONRAMP_FEE_MARKUP = 1.12;
function onrampFiatUsd(eth) {
  return (ethUsd && eth > 0) ? Math.ceil(eth * ethUsd * ONRAMP_FEE_MARKUP) : 0;
}
// Extra ETH to buy on Ethereum when the funds will then be BRIDGED to zkEVM (Creature price):
// covers the bridge fee + the L1 gas to sign the bridge tx. LAND is bought directly on Ethereum,
// so it needs no such buffer.
const ONRAMP_BRIDGE_BUFFER_ETH = 0.004;

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

// --- Sell-price units ---
// A listing is always created in ETH on-chain, but the seller can type the price in
// either ETH or a fiat currency and we auto-convert. These helpers turn one into the
// other using the live ETH/USD rate plus the USD-relative fxRates from the listings API.
function fiatPerEth(unit) {           // fiat-per-1-ETH for `unit`; null if no live rate
  if (ethUsd == null) return null;
  const fx = unit === 'usd' ? 1 : fxRates[unit];
  return fx == null ? null : ethUsd * fx;
}
function toEthAmount(amount, unit) {  // `amount` in `unit` → ETH (Number), or null
  if (unit === 'eth') return amount;
  const r = fiatPerEth(unit);
  return r ? amount / r : null;
}
function fromEthAmount(eth, unit) {   // ETH amount → value in `unit` (Number), or null
  if (unit === 'eth') return eth;
  const r = fiatPerEth(unit);
  return r ? eth * r : null;
}
// Format an ETH amount directly into the fiat `unit` (ignores the global display
// currency) — used for the sell form's live equivalence line.
function fmtUnitFiat(eth, unit) {
  const v = fromEthAmount(eth, unit);
  if (v == null) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: unit.toUpperCase(), maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v);
  } catch {
    return `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit.toUpperCase()}`;
  }
}
// Fiat entry is only possible once a live rate has loaded.
function sellFiatReady() { return ethUsd != null; }
const fiatReady = sellFiatReady; // unit-neutral alias (shared by Sell + make-offer)

// --- Generic price-unit helpers (shared by the Sell form and the make-offer forms) ---
// A price/offer is always created in ETH on-chain; the user may type it in ETH or a fiat
// currency and we convert with the live rate. Parameterized by `unit` so both flows reuse
// one set of rules; the Sell-specific wrappers below pin `unit = sellUnit`.

// Normalize a typed price (in `unit`) to a server-valid ETH string. { ok:true, eth } | { ok:false, msg }.
function unitPriceToEth(raw, unit) {
  const s = String(raw || '').trim().replace(',', '.');
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, msg: t('trade.err.badPrice') };
  if (unit === 'eth') {
    if (!/^\d{1,6}(\.\d{1,18})?$/.test(s)) return { ok: false, msg: t('trade.err.badPrice') };
    return { ok: true, eth: s };
  }
  const eth = toEthAmount(n, unit);
  if (eth == null) return { ok: false, msg: t('trade.err.rateUnavail') };
  const ethStr = String(Number(eth.toFixed(8))); // trim to a sane, server-valid precision
  if (!/^\d{1,6}(\.\d{1,18})?$/.test(ethStr) || Number(ethStr) <= 0) return { ok: false, msg: t('trade.err.badPrice') };
  return { ok: true, eth: ethStr };
}
// The "≈ …" equivalence line shown under a price field: ETH→fiat or fiat→ETH.
function unitConvHtml(raw, unit) {
  const n = parseFloat(String(raw || '').trim().replace(',', '.'));
  if (!(n > 0)) return '';
  if (unit === 'eth') {
    const fiat = fmtUnitFiat(n, currency === 'eth' ? 'usd' : currency);
    return fiat ? `≈ ${fiat}` : '';
  }
  const eth = toEthAmount(n, unit);
  return eth != null ? `≈ ${fmtEth(eth)}` : '';
}
// Options for a price-unit selector: ETH always; fiats only when a rate is live.
function unitOptions(unit) {
  const units = fiatReady() ? ['eth', ...CURRENCIES.filter(u => u !== 'eth')] : ['eth'];
  return units.map(u => `<option value="${u}" ${unit === u ? 'selected' : ''}>${u === 'eth' ? 'ETH' : u.toUpperCase()}</option>`).join('');
}

// Drop a stale persisted fiat unit back to ETH if no rate is available.
function normSellUnit() { if (!fiatReady() && sellUnit !== 'eth') sellUnit = 'eth'; return sellUnit; }
function sellPriceToEth(raw) { return unitPriceToEth(raw, sellUnit); }
// ETH value of the current input (string; '' if blank/invalid) — feeds the LAND net hint.
function sellEthFromInput(raw) { const r = sellPriceToEth(raw); return r.ok ? r.eth : ''; }
function sellConvHtml(raw) { return unitConvHtml(raw, sellUnit); }
function sellUnitOptions() { return unitOptions(sellUnit); }

// Make-offer wrappers (mirror the Sell ones, pinned to offerUnit).
function normOfferUnit() { if (!fiatReady() && offerUnit !== 'eth') offerUnit = 'eth'; return offerUnit; }
function offerConvHtml(raw) { return unitConvHtml(raw, offerUnit); }
function offerUnitOptions() { return unitOptions(offerUnit); }

// --- Known wallet bugs ---
// MetaMask extension 13.33.0 shipped a regression that wrongly reports "not enough IMX
// to pay for network fees" on custom networks even when the balance is ample (confirmed
// in the wild 2026-06-10; 13.32 and below behave). MetaMask shipped the fix in 13.35.1,
// so only the [13.33.0, 13.35.1) range is affected. We read the wallet's version and
// warn users in that range BEFORE they hit the wall.
let mmBuggyVersion = null;
async function detectWalletBug() {
  if (!eth()) return;
  try {
    const v = String(await eth().request({ method: 'web3_clientVersion' }) || '');
    const m = v.match(/MetaMask\/v?(\d+)\.(\d+)\.(\d+)/i);
    if (m) {
      const ver = [Number(m[1]), Number(m[2]), Number(m[3])];
      // True when ver >= the given [major, minor, patch], compared part-by-part.
      const atLeast = t => ver[0] !== t[0] ? ver[0] > t[0]
                         : ver[1] !== t[1] ? ver[1] > t[1]
                         : ver[2] >= t[2];
      if (atLeast([13, 33, 0]) && !atLeast([13, 35, 1])) mmBuggyVersion = ver.join('.');
    }
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
let cashoutOpen = false;     // the cash-out guidance modal (Creature proceeds are zkEVM ETH)
let cashoutStep = 'intent';  // 'intent' → 'guide'
function safetyAcked() {
  try { return localStorage.getItem(SAFETY_ACK) === '1'; } catch { return true; }
}

// "30 seconds that protect your Creatures" — literally. The connect button unlocks
// after a real 30s, anchored to the FIRST time the primer was seen (persisted, so a
// refresh doesn't restart it, and time spent reading the full guide counts).
const SAFETY_T0 = 'hcc-safety-t0';
const SAFETY_WAIT_MS = 30 * 1000; // tune here if 30s proves too much friction
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

// Cash-out guidance: selling pays in a token novices misroute when "withdrawing".
//  • Creatures: ETH on Immutable zkEVM — sent straight to an exchange it's LOST (exchanges
//    credit only mainnet ETH). Safe path: bridge to Ethereum first, then send.
//  • LAND: WETH on Ethereum — already the right network, but WETH ≠ ETH (many exchanges
//    won't credit a WETH deposit). Safe path: unwrap to ETH first, then send.
// An intent-first modal routes them to the right path for the active collection.
function cashoutHtml() {
  if (!cashoutOpen) return '';
  const inner = cashoutStep === 'guide'
    ? (coll === 'land' ? cashoutLandGuideInner() : cashoutGuideInner())
    : cashoutIntentInner();
  return `
    <div class="trade-modal trade-cashout" role="dialog" aria-modal="true" aria-label="${esc(t('trade.cashout.aria'))}">
      <div class="trade-modal-backdrop" data-act="cashout-close"></div>
      <div class="trade-safety-card trade-cashout-card">${inner}</div>
    </div>`;
}
function cashoutIntentInner() {
  return `
    <span class="apply-pill">${esc(t('trade.cashout.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.cashout.h'))}</h3>
    <p class="trade-safety-p">${esc(t(coll === 'land' ? 'trade.cashout.p.land' : 'trade.cashout.p'))}</p>
    <div class="trade-cashout-opts">
      <button class="trade-cashout-opt" data-act="cashout-guide" type="button">
        <span class="trade-cashout-opt-ico" aria-hidden="true">💸</span>
        <span class="trade-cashout-opt-tx"><b>${esc(t('trade.cashout.opt.move.h'))}</b><span>${esc(t('trade.cashout.opt.move.p'))}</span></span>
        <span class="trade-cashout-opt-arrow" aria-hidden="true">→</span>
      </button>
      <button class="trade-cashout-opt" data-act="cashout-close" type="button">
        <span class="trade-cashout-opt-ico" aria-hidden="true">🛍️</span>
        <span class="trade-cashout-opt-tx"><b>${esc(t('trade.cashout.opt.keep.h'))}</b><span>${esc(t('trade.cashout.opt.keep.p'))}</span></span>
      </button>
    </div>`;
}
function cashoutGuideInner() {
  const steps = [1, 2, 3].map(i => `<li><span class="trade-cashout-num">${i}</span><span>${esc(t('trade.cashout.step' + i))}</span></li>`).join('');
  return `
    <span class="apply-pill">${esc(t('trade.cashout.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.cashout.guide.h'))}</h3>
    <div class="trade-cashout-warn"><span aria-hidden="true">⚠️</span><p>${esc(t('trade.cashout.warn'))}</p></div>
    <ol class="trade-cashout-steps">${steps}</ol>
    <div class="trade-safety-actions">
      <button class="apply-btn-ghost" data-act="cashout-back" type="button">${esc(t('trade.cashout.back'))}</button>
      <a class="trade-send trade-safety-ok" href="${CASHOUT_URL}" target="_blank" rel="noopener">${esc(t('trade.cashout.bridge'))} ↗</a>
    </div>
    <p class="trade-safety-foot">${esc(t('trade.cashout.foot'))}</p>`;
}
// LAND variant: proceeds are WETH already on Ethereum — no bridge, just unwrap to plain ETH.
// The unwrap runs in-place (its status shows here via patchCashout from setUnwrap).
function cashoutLandGuideInner() {
  const steps = [1, 2].map(i => `<li><span class="trade-cashout-num">${i}</span><span>${esc(t('trade.cashout.land.step' + i))}</span></li>`).join('');
  const unwrapping = unwrapState && (unwrapState.phase === 'send' || unwrapState.phase === 'wait');
  return `
    <span class="apply-pill">${esc(t('trade.cashout.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.cashout.guide.h'))}</h3>
    <div class="trade-cashout-warn"><span aria-hidden="true">⚠️</span><p>${esc(t('trade.cashout.land.warn'))}</p></div>
    <ol class="trade-cashout-steps">${steps}</ol>
    ${unwrapStatusHtml()}
    <div class="trade-safety-actions">
      <button class="apply-btn-ghost" data-act="cashout-back" type="button">${esc(t('trade.cashout.back'))}</button>
      <button class="trade-send trade-safety-ok" data-act="unwrap-weth" type="button" ${unwrapping ? 'disabled' : ''}>${esc(t('trade.cashout.land.unwrapBtn'))}</button>
    </div>
    <p class="trade-safety-foot">${esc(t('trade.cashout.land.foot'))}</p>`;
}
function patchCashout() {
  const slot = root()?.querySelector('#trade-cashout-slot');
  if (slot) slot.innerHTML = cashoutHtml();
  document.body.classList.toggle('trade-modal-open', cashoutOpen || !!modalToken || !!pendingAccept);
}

async function connect() {
  if (!eth() || busy) return;
  if (!safetyAcked()) { safetyOpen = true; render(); startSafetyTicker(); return; }
  busy = true; render();
  try {
    const accounts = await eth().request({ method: 'eth_requestAccounts' });
    account = (accounts[0] || '').toLowerCase() || null;
    chainId = await eth().request({ method: 'eth_chainId' });
    // Land them on whatever chain the active collection needs (zkEVM for Creatures,
    // Ethereum for LAND) — not always zkEVM, or connecting on the LAND tab misfires.
    if (account && !onRightChain()) await switchToChain(C().chainHex);
  } catch (err) {
    console.error('Wallet connect failed:', err);
    pendingFlash = friendlyError(err);
  } finally { busy = false; render(); }
}

// Re-open MetaMask's account picker so the user can switch to — or newly connect —
// another of their accounts. MetaMask never lets a dapp enumerate every account or set
// the active one directly; this permission prompt is the supported path. The user's pick
// normally arrives via the `accountsChanged` handler, but some builds resolve the prompt
// without firing it when the active account is unchanged, so we re-read to stay truthful.
async function switchAccount() {
  if (!eth() || busy) return;
  if (!account) return connect();
  busy = true; render();
  try {
    await eth().request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    const accs = (await eth().request({ method: 'eth_accounts' })) || [];
    const next = (accs[0] || '').toLowerCase() || null;
    if (next && next !== account) { account = next; resetSellerState(); }
  } catch (err) {
    // 4001 = user dismissed the picker — a no-op, not something to surface.
    if (err?.code !== 4001) { console.error('Account switch failed:', err); pendingFlash = friendlyError(err); }
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

// Proactively move the wallet to the chain the active collection needs, at the moments
// the user clearly wants it (connect, Creatures⟷LAND toggle). A decline is SILENT — the
// "wrong network" pill stays as the manual fallback. We never trigger this passively
// (page load, a switch the user made in MetaMask), so there's no surprise popup or loop.
async function autoSwitchNetwork() {
  if (!account || onRightChain() || busy) return;
  busy = true;
  try { await switchToChain(C().chainHex); }
  catch (err) { console.error('Auto network switch declined:', err); /* pill remains */ }
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
// `quiet` is a background re-poll (used while the server is still cataloguing): it refreshes
// state without clearing the grid or flashing the loading skeleton, so filters fill in on
// their own when the catalogue lands — no jank, no manual refresh.
async function loadBrowse(reset = true, quiet = false) {
  if (!reset && (!browseHasMore || listingsLoading)) return;
  const page = reset ? 0 : browsePage + 1;
  if (reset && !quiet) { listings = []; browsePage = 0; browseHasMore = false; listingsError = false; }
  const rid = ++browseReqId;
  clearTimeout(browseIndexTimer); // a fresh request supersedes any pending poll
  const hadFilters = fltActive(); // captured at request time, applied at response time
  const ds = browseDataset();
  if (!quiet) { listingsLoading = true; patchGrid(); patchFilters(); }
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
    if (reset && !quiet) listingsError = true;
  } finally {
    if (rid === browseReqId) {
      listingsLoading = false; patchGrid(); patchFilters();
      // Still cataloguing? The trait facets (and the full "All" set) aren't ready yet —
      // poll quietly until they land so the UI completes itself. Scoped to this dataset
      // so switching collections doesn't keep it alive.
      if (browseIndexing) browseIndexTimer = setTimeout(() => {
        if (browseDataset().api === ds.api) loadBrowse(true, true);
      }, 5000);
    }
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
        ? `<div class="trade-modal-traits">${attrs.map(a => {
            const pctStr = fmtTraitPct(traitPctOf(a.trait, a.value));
            return `<div class="trade-trait"><span class="trade-trait-k">${esc(a.trait)}</span><span class="trade-trait-v">${esc(a.value)}${pctStr ? ` <span class="trade-trait-pct" title="${esc(t('trade.filter.rarityPct'))}">${esc(pctStr)}</span>` : ''}</span></div>`;
          }).join('')}</div>`
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
    // A funds shortfall can carry a card on-ramp CTA (LAND/Ethereum) — mint it on click.
    const onramp = buyState.onramp
      ? `<button class="trade-funds-btn" data-act="onramp" data-chain="${esc(buyState.onramp.chain)}" data-token="${esc(buyState.onramp.token)}" data-fiat="${esc(String(buyState.onramp.fiat || ''))}" type="button" style="margin-top:12px">${esc(t('trade.onramp.btn'))} ↗</button>`
      : '';
    return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(buyState.msg)}</span></div>${onramp}`;
  }
  if (buyState.phase === 'funds') return fundsHelpHtml();
  if (buyState.phase === 'gas') return gasHelpHtml();
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP_KEY[buyState.phase] || 'trade.buy.preparing'))}</span></div>`;
}

// A warm, concrete "let's get your ETH ready" panel. The #1 confusion: the user HAS ETH,
// just on Ethereum mainnet, while trades settle on Immutable zkEVM. We acknowledge that
// kindly and show exactly what to do — never a blunt "0 ETH / wrong".
function fundsHelpHtml(f = buyState) {
  // Shared by the Buy flow and the make-offer flow (`f.intent === 'offer'`): getting ETH
  // onto Immutable zkEVM is identical either way — only a few buy-specific lines swap.
  const offering = f.intent === 'offer';
  const headKey = offering ? 'trade.funds.hOffer' : 'trade.funds.h';
  const forKey  = offering ? 'trade.funds.forOffer' : 'trade.funds.forPrice';
  const footKey = offering ? 'trade.funds.bridgeFootOffer' : 'trade.funds.bridgeFoot';
  const need = fmtEthFiat(f.need);
  const imx = fmtWeiEth(f.imxBal);
  let mainnetEth = 0;
  try { mainnetEth = f.mainnetEthWei != null ? Number(BigInt(f.mainnetEthWei)) / 1e18 : 0; } catch { mainnetEth = 0; }
  // Only offer the bridge when mainnet ETH can actually fund it (input + L1 gas) — set in
  // showFundsHelp. A wallet that holds *some* mainnet ETH but not enough is routed to the
  // card top-off below, not asked to bridge an amount it can't send.
  const canBridge = f.canBridge === true;
  const hasGas = f.imxBal != null && Number(f.imxBal) / 1e18 >= 0.005;

  // IMX (gas) row — celebrate when they're already covered, gently note it when not.
  const imxRow = hasGas
    ? `<li class="is-ok"><span class="trade-funds-ic" aria-hidden="true">✓</span><div>${esc(t('trade.funds.imxGood'))}<br><span>${esc(t('trade.funds.have'))} ${esc(imx)} IMX</span></div></li>`
    : `<li><span class="trade-funds-ic" aria-hidden="true">•</span><div>${esc(t('trade.funds.imxNeed'))}<br><span>${esc(t('trade.funds.have'))} ${esc(imx)} IMX · ${esc(t('trade.funds.gasHint'))}</span></div></li>`;

  // The common, reassuring case: they have enough ETH on mainnet — it just needs to bridge over.
  if (canBridge) {
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
        <p class="trade-funds-foot">${esc(t(footKey))}</p>`;
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

  // Either no ETH anywhere, or some on mainnet but not enough to bridge (input + gas) — so
  // the answer is to ACQUIRE the difference. The card on-ramp lands ETH + IMX on Immutable
  // zkEVM in one go; the bridge stays as a secondary route for anyone who holds enough ETH
  // on another wallet/exchange. When they DO hold a little mainnet ETH, say so plainly so
  // the switch from "bridge" to "top up" doesn't read as the site losing track of it.
  // Acknowledge what they already hold on Ethereum and prompt them to top up ONLY the
  // complement (we've pre-set the card to exactly that), then bridge it all over.
  const shortNote = mainnetEth > 0
    ? `<p class="trade-funds-net">${esc(t('trade.funds.notEnoughToBridge').replace('{x}', fmtEthFiat(mainnetEth)).replace('{y}', fmtEthFiat(f.cardTopUpEth)))}</p>`
    : '';
  // The ETH row spells out the whole picture: what's needed, what's already on zkEVM, and what's
  // on Ethereum (so the "top up the difference" guidance has visible context).
  const ethElsewhere = mainnetEth > 0
    ? ` · ${esc(t('trade.funds.plusOnEth').replace('{x}', fmtEthFiat(mainnetEth)))}`
    : '';
  return `
    <div class="trade-funds">
      <div class="trade-funds-h"><span aria-hidden="true">💡</span> ${esc(t(headKey))} ${tipHtml('trade.funds.intro')}</div>
      <ul class="trade-funds-list">
        <li><span class="trade-funds-ic" aria-hidden="true">•</span><div><b>ETH</b> — ${esc(t(forKey))}<br><span>${esc(t('trade.funds.need'))} ≈ <b>${esc(need)}</b> · ${esc(t('trade.funds.have'))} ${esc(fmtEthFiat(weiToEth(f.ethBal)))} ${esc(t('trade.funds.onZk'))}${ethElsewhere}</span></div></li>
        ${imxRow}
      </ul>
      ${shortNote}
      <p class="trade-funds-net">${esc(t('trade.onramp.net'))}</p>
      <button class="trade-funds-btn" data-act="onramp" data-chain="ethereum" data-token="ETH" data-fiat="${esc(String(f.onrampFiat || ''))}" type="button">${esc(t('trade.onramp.btn'))} ↗</button>
      <p class="trade-funds-foot">${esc(t('trade.onramp.fundsFoot'))} · <a href="${BRIDGE_URL}" target="_blank" rel="noopener">${esc(t('trade.onramp.orBridge'))} ↗</a></p>
    </div>`;
}

// Read balances (zkEVM ETH + IMX, and mainnet ETH via the server), then show the panel.
// When the user has mainnet ETH, also ask the server for an exact-output Squid quote so
// the panel can offer one-tap bridging of precisely the shortfall.
//
// Shared by Buy (funds shortfall to PAY) and make-offer (funds shortfall to BACK a bid):
// `apply(fields)` merges into the owning state (buyState / offerState) and re-renders;
// `alive()` reports whether that state is still on the funds panel (user hasn't moved on).
async function gatherFundsHelp({ need, intent, apply, alive }) {
  apply({ phase: 'funds', intent, need, ethBal: null, imxBal: null, mainnetEthWei: null, quote: 'loading', onrampFiat: onrampFiatUsd(need + ONRAMP_BRIDGE_BUFFER_ETH) });
  const [ethBal, imxBal, elsewhere] = await Promise.all([
    readErc20(IMX_ETH_TOKEN, account),
    readNative(account),
    fetch(`/api/market/creatures/eth-elsewhere/${account}`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (!alive()) return;
  const mainnetEthWei = elsewhere?.mainnetEthWei ?? null;
  let mainnetEth = 0;
  try { mainnetEth = mainnetEthWei != null ? Number(BigInt(mainnetEthWei)) / 1e18 : 0; } catch { mainnetEth = 0; }

  // Shortfall on zkEVM (in ETH).
  const haveZk = ethBal != null ? Number(ethBal) / 1e18 : 0;
  const shortfall = Math.max(0, need - haveZk);
  // Can their mainnet ETH actually fund a bridge of the shortfall? They need the bridge
  // INPUT plus L1 gas headroom. ETH→ETH bridges ~1:1, so a quote's `fromEth` is the
  // shortfall plus Squid's fee — never less; if mainnet can't even cover shortfall + gas
  // reserve, no quote can be funded either, so don't suggest bridging an amount they don't
  // hold. Below this bar the panel shows the card top-off instead (acquire the difference).
  const canBridge = shortfall > 0 && mainnetEth >= shortfall + BRIDGE_GAS_RESERVE_ETH;
  // The card CTA buys ETH on Ethereum to then bridge. They need enough on Ethereum to bridge the
  // zkEVM shortfall PLUS the bridge fee + L1 gas (ONRAMP_BRIDGE_BUFFER_ETH) — but they may ALREADY
  // hold some mainnet ETH, so we only top up the difference (never below 0). This keeps them from
  // re-buying ETH they already have. The widget URL is minted on click; we stash the fiat here.
  const cardTopUpEth = Math.max(0, (shortfall || need) + ONRAMP_BRIDGE_BUFFER_ETH - mainnetEth);
  apply({ phase: 'funds', intent, need, ethBal, imxBal, mainnetEthWei, mainnetEth, canBridge, quote: canBridge ? 'loading' : null, cardTopUpEth, onrampFiat: onrampFiatUsd(cardTopUpEth) });
  if (!canBridge) return;

  try {
    const res = await fetch('/api/market/creatures/bridge/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ address: account, needEth: shortfall.toFixed(18).replace(/0+$/, '').replace(/\.$/, '') }),
    });
    const q = res.ok ? await res.json() : null;
    if (!alive()) return;
    // Re-check against the precise quote: the bridge input (fromEth, includes Squid's fee)
    // plus L1 gas must still fit within mainnet ETH. If fees push it over the edge, fall
    // back to the top-off rather than a one-tap bridge the wallet can't sign.
    if (q && q.tx && mainnetEth < (Number(q.fromEth) || Infinity) + BRIDGE_GAS_RESERVE_ETH) {
      apply({ canBridge: false, quote: null }); return;
    }
    apply({ quote: q });
  } catch {
    if (alive()) apply({ quote: null });
  }
}

function showFundsHelp(it) {
  const need = it.totalEth ?? it.priceEth;
  return gatherFundsHelp({
    need, intent: 'buy',
    apply: fields => { buyState = { ...buyState, ...fields }; patchModal(); },
    alive: () => buyState?.phase === 'funds',
  });
}

// Make-offer equivalent: the bid amount is what must be backed on zkEVM. Renders through
// offerStatusHtml (modal for a token offer, the collection strip in browse), so it patches
// both via setOffer's targets.
function showOfferFundsHelp(need, ctx) {
  offerCtx = ctx;
  return gatherFundsHelp({
    need, intent: 'offer',
    apply: fields => { offerState = { ...offerState, ...fields }; patchModal(); patchCollStrip(); },
    alive: () => offerState?.phase === 'funds',
  });
}

// --- Gas (IMX) help — shared by Buy, Sell and Transfer ---------------------------------
// The wall almost everyone hits at least once: trades settle on Immutable zkEVM, where
// IMX is the native gas coin — and a buy, a first-time sell approval, or a transfer all
// need a little of it. Bridged ETH can't pay it. So when a wallet's IMX runs dry we show
// the same warm, one-tap path the Buy funds panel uses, but pointed at native IMX.

function fmtImx(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 })} IMX`;
}

// Gas-bridge status, with a context-agnostic "you're set" line on completion (the buy
// "tap Buy again" copy would be wrong in Sell/Transfer). Other phases are asset-neutral,
// so they reuse the shared tracker.
function gasBridgeStatusHtml() {
  const b = bridgeJob;
  if (!b || b.kind !== 'gas') return '';
  if (b.phase === 'done') {
    return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.gas.bridge.done'))}</span></div>`;
  }
  return bridgeStatusHtml();
}

// The panel itself. Mirrors fundsHelpHtml's bridge branch but for native IMX. Source is
// chosen in showGasHelp: 'imx' bridges the mainnet IMX the user already holds (cheapest),
// 'eth' swaps a little mainnet ETH, null → no one-tap (prefilled Squid deep-link).
function gasHelpHtml() {
  const g = gasState;
  if (!g) return '';
  const imx = fmtWeiEth(g.imxBal);
  const fromImx = g.from === 'imx'; // source asset for the one-tap (and the matching copy)

  let bridgeArea;
  if (g.from && g.quote === 'loading') {
    bridgeArea = `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.bridge.quote.loading'))}</div>`;
  } else if (g.from && g.quote && g.quote.tx) {
    const q = g.quote;
    const mins = q.durationSeconds ? Math.max(1, Math.ceil(q.durationSeconds / 60)) : null;
    const meta = [
      q.feeUsd != null ? t('trade.bridge.quote.fees').replace('{f}', String(q.feeUsd)) : null,
      mins != null ? t('trade.bridge.quote.mins').replace('{m}', String(mins)) : null,
      t('trade.bridge.quote.by'),
    ].filter(Boolean).join(' · ');
    const busyBridge = bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase);
    // The "from" side is whatever they're sending (IMX or ETH); the "to" side is always IMX.
    const fromTxt = fromImx ? fmtImx(q.fromEth) : fmtEthFiat(q.fromEth);
    bridgeArea = `
      <div class="trade-bridge-quote">
        <div class="trade-bridge-line">${esc(t('trade.gas.bridge.line').replace('{x}', fromTxt).replace('{y}', fmtImx(q.toEth)))}</div>
        <div class="trade-bridge-meta">${esc(meta)}</div>
        ${bridgeJob?.phase === 'done' ? '' : `<button class="trade-funds-btn" data-act="gas-bridge-now" type="button" ${busyBridge ? 'disabled' : ''}>${esc(t('trade.gas.bridge.now'))}</button>`}
        ${gasBridgeStatusHtml()}
      </div>`;
  } else if (g.from) {
    // They DO hold something on mainnet (so g.from is set) but we couldn't auto-quote —
    // offer the matching manual bridge deep-link (IMX→IMX if they hold L1 IMX, else ETH→IMX).
    bridgeArea = `<a class="trade-funds-btn" href="${g.from === 'imx' ? GAS_BRIDGE_URL_IMX : GAS_BRIDGE_URL}" target="_blank" rel="noopener">${esc(t('trade.gas.getBtn'))} ↗</a>
      <p class="trade-funds-foot">${esc(t('trade.gas.foot'))}</p>`;
  } else {
    // Nothing on mainnet to bridge — they need to ACQUIRE IMX. Card on-ramp straight to zkEVM.
    bridgeArea = `<button class="trade-funds-btn" data-act="onramp" data-chain="zkevm" data-token="IMX" type="button">${esc(t('trade.onramp.btn'))} ↗</button>
      <p class="trade-funds-foot">${esc(t('trade.onramp.gasFoot'))}</p>`;
  }

  // The reassuring note names what's actually moving, so an IMX holder isn't told we'll
  // "swap your ETH" when their IMX is right there on Ethereum.
  const note = fromImx ? t('trade.gas.bridgeNote.imx') : g.from === 'eth' ? t('trade.gas.bridgeNote') : '';
  return `
    <div class="trade-funds trade-gas">
      <div class="trade-funds-h"><span aria-hidden="true">⛽</span> ${esc(t('trade.gas.h'))} ${tipHtml('trade.gas.p')}</div>
      <ul class="trade-funds-list">
        <li><span class="trade-funds-ic" aria-hidden="true">•</span><div>
          <b>IMX</b> — ${esc(t('trade.gas.imxLine'))}<br>
          <span>${esc(t('trade.funds.have'))} ${esc(imx)} IMX · ${esc(t('trade.funds.gasHint'))}</span>
        </div></li>
      </ul>
      ${note ? `<p class="trade-funds-net">${esc(note)}</p>` : ''}
      ${bridgeArea}
    </div>`;
}

// Read the zkEVM IMX balance + what the wallet holds on mainnet (IMX first, then ETH),
// pick the cheapest one-tap source, and quote an exact-output top-up of GAS_TARGET_IMX.
// Renders into whichever surface the calling flow lives in (Buy modal, or the inline
// Sell/Transfer status slot).
async function showGasHelp(ctx) {
  gasState = { ctx, imxBal: null, mainnetEthWei: null, mainnetImxWei: null, from: null, quote: 'loading' };
  patchGas();
  const [imxBal, elsewhere] = await Promise.all([
    readNative(account),
    fetch(`/api/market/creatures/eth-elsewhere/${account}`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (gasState?.ctx !== ctx) return; // user moved on
  const mainnetEthWei = elsewhere?.mainnetEthWei ?? null;
  const mainnetImxWei = elsewhere?.mainnetImxWei ?? null;
  // Prefer bridging IMX they already hold on mainnet (no swap, cheaper); else swap a little
  // mainnet ETH; else there's nothing to one-tap — fall back to the deep-link.
  let hasImxL1 = false, hasEth = false;
  try { hasImxL1 = mainnetImxWei != null && BigInt(mainnetImxWei) > 0n; } catch { hasImxL1 = false; }
  try { hasEth = mainnetEthWei != null && BigInt(mainnetEthWei) > 0n; } catch { hasEth = false; }
  const from = hasImxL1 ? 'imx' : hasEth ? 'eth' : null;
  gasState = { ctx, imxBal, mainnetEthWei, mainnetImxWei, from, quote: 'loading' };
  patchGas();

  if (!from) { gasState.quote = null; patchGas(); return; }
  // The server already retries Squid's 429s (the shared integrator id rate-limits easily), but
  // give it a second window here too: a null quote is what drops the user to the empty Squid
  // deep-link, so that fallback should mean "genuinely unavailable", not "one rate-limit blip".
  let q = await fetchGasQuote(from);
  if (q == null && gasState?.ctx === ctx) {
    await new Promise(r => setTimeout(r, 1200));
    if (gasState?.ctx === ctx) q = await fetchGasQuote(from);
  }
  if (gasState?.ctx === ctx) { gasState.quote = q; patchGas(); }
}

// One gas-quote request; null on any non-OK / error (caller decides whether to retry or fall
// back to the deep-link).
async function fetchGasQuote(from) {
  try {
    const res = await fetch('/api/market/creatures/bridge/gas/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ address: account, needImx: String(GAS_TARGET_IMX), from }),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// Ask the server to mint a card on-ramp session URL that lands on the right chain (network is
// pinned server-side; Transak's deprecated bare URLs defaulted to ETH-on-Ethereum). chain
// 'ethereum' is LAND; 'zkevm' is Creatures, where `token` picks ETH (price) or IMX (gas).
// Returns null when the on-ramp isn't configured/available — zkEVM callers then fall back to
// ONRAMP_URL_ZKEVM, LAND omits the CTA. `amount` (in `token` units) prefills the widget's buy
// amount as an editable default. The URL is single-use and expires in ~5 min, so callers mint
// it on click (see openOnramp), never ahead of time.
async function fetchOnrampUrl(chain, token = 'ETH', fiat = 0) {
  try {
    const f = Number(fiat) > 0 ? `&fiat=${encodeURIComponent(Math.round(Number(fiat)))}` : '';
    const r = await fetch(`/api/market/onramp?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(token)}&address=${account}${f}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.url || null;
  } catch { return null; }
}

// Open the card on-ramp in a new tab. Sessions are single-use and expire in ~5 min, so we mint
// ON CLICK, not ahead. The blank tab is opened synchronously first so it still counts as a user
// gesture (popup blockers would kill a window.open that comes after the await). `fiat` (USD)
// prefills the amount. zkEVM falls back to Immutable's keyless hosted page if minting fails;
// LAND has no keyless fallback, so the tab just closes.
async function openOnramp(chain, token, fiat) {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  let url = null;
  try { url = await fetchOnrampUrl(chain, token, fiat); } catch { url = null; }
  if (!url && chain === 'zkevm') url = ONRAMP_URL_ZKEVM;
  if (url) {
    if (tab) tab.location = url; else window.open(url, '_blank', 'noopener');
  } else if (tab) {
    tab.close();
  }
}

// Repaint the gas panel wherever it currently lives. Buy renders it inside the modal
// (buyStatusHtml), Sell inside its status row (sellStatusHtml), Transfer writes it into
// the form's status element directly.
function patchGas() {
  if (!gasState) return;
  if (gasState.ctx === 'buy')  return patchModal();
  if (gasState.ctx === 'sell') return patchSellStatus();
  if (gasState.ctx === 'transfer') {
    // #trade-status is hidden until it carries an is-* state class; for the full panel we
    // drop that class so the slot shows as a plain block (handleTransferSubmit restores
    // the status styling on the next attempt).
    const el = root()?.querySelector('#trade-status');
    if (el) { el.className = 'trade-gas-slot'; el.innerHTML = gasHelpHtml(); }
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
    return `<div class="trade-bridgebar is-ok"><span aria-hidden="true">✓</span><span>${esc(t(isGasBridge(b) ? 'trade.gas.bridgebar.done' : 'trade.bridgebar.done'))}</span><span class="trade-bridgebar-links">${bridgeLinksHtml(b)}</span>${dismiss}</div>`;
  }
  if (b.phase === 'error') {
    return `<div class="trade-bridgebar is-bad"><span aria-hidden="true">⚠</span><span>${esc(b.msg || t('trade.bridge.failed'))}</span><span class="trade-bridgebar-links">${bridgeLinksHtml(b)}</span>${dismiss}</div>`;
  }
  const slow = b.phase === 'slow' ? ` ${esc(t('trade.bridgebar.slowTag'))}` : '';
  return `
    <div class="trade-bridgebar" role="status" aria-live="polite">
      <span class="trade-mini-spin" aria-hidden="true"></span>
      <span>${esc(t(isGasBridge(b) ? 'trade.gas.bridgebar.bridging' : 'trade.bridgebar.bridging'))} — ${esc(t(stageKey))}${slow} · <b data-bridge-elapsed>${esc(fmtElapsed(Date.now() - b.startedAt))}</b>${b.mins ? ` / ~${esc(String(b.mins))} min` : ''}</span>
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
  if (b.phase === 'done')  return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t(isGasBridge(b) ? 'trade.gas.bridge.done' : 'trade.bridge.done'))}</span></div>`;
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
  patchGas(); // keep the inline Sell/Transfer gas panels in step with the bridge
  if (patchFields.phase === 'done') refreshAfterBridge();
}

// A bridge just landed funds on zkEVM (the ETH ERC-20 for a price bridge, native IMX for a
// gas top-up). Refresh the wallet-bar balances so the new funds show WITHOUT a reload — the
// old code only repainted the tracker, leaving the balances stale until the next full render.
// Staggered because the injected wallet provider can serve a cached balance for a beat after
// the mainnet→zkEVM switch dance, until it sees a fresh block.
let bridgeRefreshTimers = [];
function refreshAfterBridge() {
  bridgeRefreshTimers.forEach(clearTimeout);
  refreshBalance();
  bridgeRefreshTimers = [4000, 10000, 20000].map(ms => setTimeout(() => { if (account) refreshBalance(); }, ms));
}

// A gas bridge moves native IMX (not the ETH ERC-20), so it lands in a different balance
// and gets its own copy. kind defaults to 'eth' for older persisted jobs.
const isGasBridge = b => (b || bridgeJob)?.kind === 'gas';

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
    // Watch the asset the bridge actually delivers: native IMX for a gas top-up, the
    // ETH ERC-20 for a price bridge.
    const bal = isGasBridge(job) ? await readNative(job.account) : await readErc20(IMX_ETH_TOKEN, job.account);
    if (bal != null && bal >= needWei) return setBridgeJob({ phase: 'done', stage: 'arrived' });
    if (tick++ % 2 === 0) { // status every ~20s — visible movement without rate pressure
      try {
        const r = await fetch(`/api/market/creatures/bridge/status?tx=${job.hash}&quoteId=${encodeURIComponent(job.quoteId || '')}&requestId=${encodeURIComponent(job.requestId || '')}`);
        if (r.ok) {
          const s = await r.json();
          if (bridgeJob !== job || job.phase !== 'waiting') return;
          if (s.stage === 'failed' || s.stage === 'failed_src') return setBridgeJob({ phase: 'error', msg: t('trade.bridge.failed'), axelarUrl: s.axelarUrl || job.axelarUrl });
          if (s.stage === 'needs_gas') return setBridgeJob({ phase: 'error', msg: t('trade.bridge.needsGas'), axelarUrl: s.axelarUrl || job.axelarUrl });
          // Squid reports the funds have landed on zkEVM — complete NOW rather than waiting on
          // the wallet balance read, which the injected provider can serve stale after the
          // chain switch (the old bug: tracker never flipped to done until a reload).
          if (s.stage === 'arrived') return setBridgeJob({ phase: 'done', stage: 'arrived', axelarUrl: s.axelarUrl || job.axelarUrl });
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

// Send the prepared Squid bridge tx, then hand off to the resumable tracker. Shared by
// the ETH price bridge (Buy) and the IMX gas top-up (Buy/Sell/Transfer); `kind` and the
// arrival target `needWei` are all that differ.
async function runBridge(q, { kind, needWei }) {
  if (!q || q === 'loading' || !q.tx) return;
  if (bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase)) return; // one bridge at a time
  try {
    bridgeJob = { phase: 'switch', account, mins: null, startedAt: Date.now(), kind };
    patchModal();
    patchGas();
    await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
    setBridgeJob({ phase: 'confirm' });
    const hash = await eth().request({
      method: 'eth_sendTransaction',
      params: [{ from: account, to: q.tx.to, data: q.tx.data, value: q.tx.value, ...(q.tx.gas ? { gas: q.tx.gas } : {}) }],
    });
    setBridgeJob({ phase: 'back', hash });
    await ensureNetwork(); // back to Immutable zkEVM
    const mins = q.durationSeconds ? Math.max(1, Math.ceil(q.durationSeconds / 60)) : null;
    setBridgeJob({
      phase: 'waiting', hash, mins, startedAt: Date.now(), stage: 'submitted', kind,
      axelarUrl: null, needWei: needWei.toString(), quoteId: q.quoteId || '', requestId: q.requestId || '', account,
    });
    trackBridge();
  } catch (err) {
    console.error('Bridge failed:', err);
    setBridgeJob({ phase: 'error', msg: friendlyError(err) });
  }
}

function handleBridgeNow() {
  // The funds panel is shared: it's driven by buyState during a Buy and offerState during a
  // make-offer. Bridge whichever one is currently showing it.
  const f = offerState?.phase === 'funds' ? offerState : buyState;
  const needWei = BigInt(Math.round((f?.need ?? 0) * 1e6)) * 10n ** 12n; // arrive when the ETH amount is covered
  return runBridge(f?.quote, { kind: 'eth', needWei });
}

function handleGasBridgeNow() {
  // Arrive when the top-up target's worth of native IMX has landed.
  const needWei = BigInt(Math.round(GAS_TARGET_IMX * 1e6)) * 10n ** 12n;
  return runBridge(gasState?.quote, { kind: 'gas', needWei });
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
  // skey() swaps in the LAND variant when buying a parcel ("...another parcel", mainnet
  // wording) and falls back to the Creature copy otherwise.
  return t(skey(KEY[code] || 'trade.err.unavailable'));
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

// A listing that turned out to be already sold/cancelled: remove it from the local grid
// now (instant feedback) and pull a fresh page so it's gone everywhere.
function dropStaleListing(listingId) {
  listings = listings.filter(l => l.listingId !== listingId);
  patchGrid();
  loadListings(true);
}

// LAND buy: Ethereum mainnet, native-ETH value transaction, no approvals. The
// prepared calldata is zone-bound to this buyer, so it can't be hijacked.
async function handleBuyLand(it) {
  try {
    setBuy('prepare');
    const needWei = BigInt(Math.round((it.totalEth ?? it.priceEth) * 1e6)) * 10n ** 12n + 10n ** 16n; // +0.01 ETH gas cushion
    // Switch to mainnet first so the pre-flight reads the AUTHORITATIVE balance straight
    // from the wallet — the exact figure MetaMask shows and uses to fund the tx. A
    // third-party RPC (e.g. Blockscout) can lag a recent top-up and wrongly block a funded
    // buyer; the wallet's own eth_getBalance never does. null = read failed → let it through
    // (the wallet still guards at signing).
    await switchToChain('0x1');
    const balWei = await readNative(account);
    if (balWei != null && balWei < needWei) {
      // Short on mainnet ETH — offer a card on-ramp that delivers ETH straight to Ethereum
      // (Transak, if configured). Minted on click; stash the shortfall (in USD) to prefill.
      const shortEth = Number(needWei - balWei) / 1e18;
      setBuy('error', { msg: t('trade.err.landFunds').replace('{x}', fmtEth(Number(needWei) / 1e18)).replace('{y}', fmtEth(Number(balWei) / 1e18)), onramp: { chain: 'ethereum', token: 'ETH', fiat: onrampFiatUsd(shortEth) } });
      return;
    }

    const res = await fetch('/api/market/land/buy/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderHash: it.listingId, protocolAddress: it.protocolAddress, takerAddress: account }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBuy('error', { msg: buyServerError(data.error) });
      // OpenSea already knows it's filled/cancelled — drop the stale tile + refresh the grid.
      if (data.error === 'not_active' || data.error === 'not_found') dropStaleListing(it.listingId);
      return;
    }

    for (const tx of (data.transactions || [])) {
      setBuy('fulfill');
      // Simulate before signing. OpenSea can still hand out a "fulfillable" order for a few
      // seconds after a sale, but Seaport reverts an already-filled order — so estimateGas
      // reverts here. Bail with a clear message + refresh instead of charging the buyer gas
      // for a doomed tx (funds are never at risk — Seaport reverts atomically either way).
      try {
        await eth().request({ method: 'eth_estimateGas', params: [{ from: account, to: tx.to, data: tx.data, value: tx.value && tx.value !== '0x0' ? tx.value : '0x0' }] });
      } catch (simErr) {
        console.warn('LAND buy pre-flight reverted (likely just sold):', simErr?.message);
        setBuy('error', { msg: t(skey('trade.err.gone')) });
        dropStaleListing(it.listingId);
        return;
      }
      const hash = await eth().request({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: tx.to, data: tx.data, value: tx.value && tx.value !== '0x0' ? tx.value : undefined }],
      });
      setBuy('fulfillWait', { hash });
      const receipt = await waitForReceipt(hash);
      // A revert here means someone won the same-block race; funds are safe, only gas spent.
      if (!receipt || receipt.status !== '0x1') { setBuy('error', { msg: t(skey('trade.err.txFailed')) }); dropStaleListing(it.listingId); return; }
      setBuy('done', { hash });
      listings = listings.filter(l => l.listingId !== it.listingId);
      patchGrid();
      refreshAfterTx(); // they gained a LAND (+ it left the market) — refresh, then retry as OpenSea indexes
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
    // Has the ETH but no gas — the exact wall in the Discord report. Same guided IMX
    // top-up the Sell/Transfer flows now use, instead of a terse "add some IMX".
    if (imxBal != null && imxBal < GAS_MIN_WEI) { setBuy('gas'); showGasHelp('buy'); return; }

    // Up to a couple of passes: a first-time buyer's ERC-20 spend approval must be MINED
    // before the fulfilment can be built (estimateGas needs the allowance in place), so
    // the first prepare returns just the approval; we re-prepare once it confirms.
    for (let pass = 0; pass < 3; pass++) {
      setBuy('prepare');
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
          refreshAfterTx(); // they gained a Creature (+ it left the market) — refresh, then retry as Immutable indexes
          return;
        }
      }
      // Only the spend approval this pass — re-prepare to fetch the now-buildable fulfilment.
      if (!data.needsRefulfill) break;
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
  clearTimeout(collOffersRetryTimer); collOffersRetryTimer = null; // supersede any pending auto-retry
  try {
    const res = await fetch('/api/market/creatures/offers/collection', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`offers/collection HTTP ${res.status}`);
    collOffers = (await res.json()).offers || [];
    collOffersError = false;
    collOffersRetryAttempt = 0; // healthy again — reset the backoff
  } catch (err) {
    // Don't blank a populated strip into a misleading "none right now" — keep the last
    // good offers (stale-while-error) and flag the failure so an EMPTY strip can say so.
    console.error('Load collection offers failed:', err.message);
    collOffersError = true;
    if (collOffers == null) collOffers = [];
    scheduleCollOffersRetry(); // self-heal without the user tapping Refresh
  }
  patchCollStrip();
  patchSellView();
}

// Auto-recover a failed offers load: re-fetch on a capped backoff (4s → 8s → 16s →
// 30s…) until it succeeds. One timer at a time; a manual Refresh or any successful
// load supersedes it and resets the backoff. The timer skips firing when the
// Creatures strip isn't the active view, so we never poll needlessly in the background.
function scheduleCollOffersRetry() {
  if (collOffersRetryTimer) return;
  const delay = Math.min(30000, 4000 * 2 ** collOffersRetryAttempt);
  collOffersRetryAttempt++;
  collOffersRetryTimer = setTimeout(() => {
    collOffersRetryTimer = null;
    if (coll === 'creatures' && root()) loadCollOffers();
  }, delay);
}

// LAND standing offers (read-only for now) — same shape + self-healing as the Creature set.
async function loadLandCollOffers() {
  clearTimeout(landCollOffersRetryTimer); landCollOffersRetryTimer = null;
  try {
    const res = await fetch('/api/market/land/offers/collection', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`land offers/collection HTTP ${res.status}`);
    landCollOffers = (await res.json()).offers || [];
    landCollOffersError = false;
    landCollOffersRetryAttempt = 0;
  } catch (err) {
    console.error('Load LAND collection offers failed:', err.message);
    landCollOffersError = true;
    if (landCollOffers == null) landCollOffers = [];
    scheduleLandCollOffersRetry();
  }
  patchLandOfferStrip();
  patchSellView(); // the LAND instant-sell card on the Sell tab reads these too
}
function scheduleLandCollOffersRetry() {
  if (landCollOffersRetryTimer) return;
  const delay = Math.min(30000, 4000 * 2 ** landCollOffersRetryAttempt);
  landCollOffersRetryAttempt++;
  landCollOffersRetryTimer = setTimeout(() => {
    landCollOffersRetryTimer = null;
    if (coll === 'land' && root()) loadLandCollOffers();
  }, delay);
}
async function loadMyOffers() {
  if (!account) { myOffers = null; return; }
  try {
    const res = await fetch(`/api/market/creatures/offers/mine/${account}`, { headers: { Accept: 'application/json' } });
    myOffers = res.ok ? ((await res.json()).offers || []) : [];
  } catch { myOffers = []; }
  patchCollStrip();
}
async function loadLandMyOffers() {
  if (!account) { landMyOffers = null; return; }
  try {
    const res = await fetch(`/api/market/land/offers/mine/${account}`, { headers: { Accept: 'application/json' } });
    landMyOffers = res.ok ? ((await res.json()).offers || []) : [];
  } catch { landMyOffers = []; }
  patchLandOfferStrip();
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
  // Offer is short on zkEVM ETH — reuse the Buy flow's warm funds panel (balances +
  // one-tap bridge / card top-off), themed for the offer intent.
  if (offerState.phase === 'funds') return fundsHelpHtml(offerState);
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
    // Proceeds land as the zkEVM ETH token — invisible in MetaMask until it's added, and on
    // a different network than mainnet. Say where it is + offer to add it / bridge it out, so
    // sellers don't go hunting (and accidentally move the wrong thing).
    const amt = acceptState.netEth != null ? fmtEthFiat(acceptState.netEth) : null;
    const explorer = acceptState.hash ? `<a class="trade-sold-btn" href="${esc(EXPLORER)}/tx/${esc(acceptState.hash)}" target="_blank" rel="noopener">${esc(t('trade.status.view'))} ↗</a>` : '';
    return `<div class="trade-status is-ok trade-sold">
        <div class="trade-sold-top"><span aria-hidden="true">✓</span><span>${esc(amt ? t('trade.accept.doneAmt').replace('{x}', amt) : t('trade.accept.done'))}</span></div>
        <p class="trade-sold-where">${esc(t('trade.accept.doneWhere'))}</p>
        <div class="trade-sold-actions">
          <button class="trade-sold-btn is-primary" data-act="cashout-open" type="button">${esc(t('trade.accept.cashout'))}</button>
          <button class="trade-sold-btn" data-act="add-eth-token" type="button">${esc(t('trade.accept.addToken'))}</button>
          ${explorer}
        </div>
      </div>`;
  }
  if (acceptState.phase === 'error') return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(acceptState.msg)}</span></div>`;
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP[acceptState.phase]))}</span></div>`;
}

// Sale confirmation gate. Instant-sell takes the BEST STANDING offer at click time, and
// those move — so before any wallet popup we show the exact, current payout and make the
// user confirm. (A holder once expected a price they'd seen earlier and was surprised by
// the lower live one; this removes that surprise — the sale is final and can't be undone.)
function askAccept(offerId, tokenId) {
  if (acceptBusyId) return;
  const offer = [...(collOffers || []), ...(tokenOffers || []), ...(myOffers || []), ...(sellPickOffers || [])].find(o => o.offerId === offerId);
  if (!offer) { // it was taken/cancelled between render and click — refresh instead of confirming a ghost
    loadCollOffers();
    if (modalToken) loadTokenOffers(modalToken);
    return;
  }
  pendingAccept = { kind: 'creature', offerId, tokenId: tokenId ?? null, netEth: offer.netEth };
  patchConfirmAccept();
}
function confirmAcceptHtml() {
  if (!pendingAccept) return '';
  return `
    <div class="trade-modal trade-confirm" role="dialog" aria-modal="true" aria-label="${esc(t('trade.confirm.aria'))}">
      <div class="trade-modal-backdrop" data-act="accept-cancel"></div>
      <div class="trade-confirm-card">
        <span class="trade-confirm-ico" aria-hidden="true">⚡</span>
        <h3 class="trade-confirm-h">${esc(t('trade.confirm.h'))}</h3>
        <p class="trade-confirm-amt">${esc(fmtEthFiat(pendingAccept.netEth))}</p>
        <p class="trade-confirm-sub">${esc(t(pendingAccept.kind === 'land' ? 'trade.confirm.sub.land' : 'trade.confirm.sub'))}</p>
        <p class="trade-confirm-note">${esc(t('trade.confirm.note'))}</p>
        <div class="trade-confirm-actions">
          <button class="apply-btn-ghost" data-act="accept-cancel" type="button">${esc(t('trade.confirm.cancel'))}</button>
          <button class="trade-send" data-act="accept-confirm" type="button">${esc(t('trade.confirm.ok'))}</button>
        </div>
      </div>
    </div>`;
}
function patchConfirmAccept() {
  const slot = root()?.querySelector('#trade-confirm-slot');
  if (slot) slot.innerHTML = confirmAcceptHtml();
  document.body.classList.toggle('trade-modal-open', !!pendingAccept || !!modalToken);
}

// Add the zkEVM ETH token to MetaMask so a seller can actually SEE their proceeds (it's an
// ERC-20, so it won't appear under the native balance). No-op if the user dismisses.
async function addEthToken() {
  if (!eth()) return;
  try {
    await eth().request({ method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address: IMX_ETH_TOKEN, symbol: 'ETH', decimals: 18 } } });
  } catch (err) { if (err?.code !== 4001) console.error('watchAsset failed:', err.message); }
}
// WETH (a seller's LAND-offer proceeds) is an ERC-20 on mainnet — add it so they can see it.
async function addWethToken() {
  if (!eth()) return;
  try {
    await eth().request({ method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address: WETH_TOKEN, symbol: 'WETH', decimals: 18 } } });
  } catch (err) { if (err?.code !== 4001) console.error('watchAsset WETH failed:', err.message); }
}
// One-tap WETH → native ETH unwrap (withdraw): turns a seller's WETH proceeds into plain ETH,
// 1:1, gas only — no DEX/swap. Unwraps the full WETH balance.
function setUnwrap(phase, extra) { unwrapState = { phase, ...extra }; patchSellView(); patchCashout(); }
async function handleUnwrapWeth() {
  if (unwrapState && (unwrapState.phase === 'send' || unwrapState.phase === 'wait')) return;
  try {
    await switchToChain('0x1'); // WETH is on Ethereum mainnet
    const bal = await readErc20(WETH_TOKEN, account);
    if (bal == null || bal <= 0n) { setUnwrap('error', { msg: t('trade.unwrap.none') }); return; }
    setUnwrap('send', { amtEth: weiToEth(bal) });
    const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to: WETH_TOKEN, data: SEL_WETH_WITHDRAW + word(bal) }] });
    setUnwrap('wait', { hash, amtEth: weiToEth(bal) });
    const receipt = await waitForReceipt(hash);
    if (!receipt || receipt.status !== '0x1') { setUnwrap('error', { msg: t('trade.err.txFailed') }); return; }
    setUnwrap('done', { hash, amtEth: weiToEth(bal) });
    refreshBalance();
  } catch (err) {
    console.error('Unwrap WETH failed:', err);
    setUnwrap('error', { msg: friendlyError(err) });
  }
}
function unwrapStatusHtml() {
  if (!unwrapState) return '';
  if (unwrapState.phase === 'done') {
    const amt = unwrapState.amtEth != null ? fmtEthFiat(unwrapState.amtEth) : null;
    return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(amt ? t('trade.unwrap.doneAmt').replace('{x}', amt) : t('trade.unwrap.done'))}</span></div>`;
  }
  if (unwrapState.phase === 'error') return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(unwrapState.msg)}</span></div>`;
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t('trade.unwrap.busy'))}</span></div>`;
}

// --- LAND offer accept (sell a parcel into a standing bid; mainnet + WETH) ---
// Separate from the Creature accept: different chain, different proceeds token, and OpenSea
// hands us a ready fulfilment (no local gas estimation), so it's a straight approve→fulfil.
function setLandAccept(phase, extra) { landAcceptState = { phase, ...extra }; patchSellView(); }
function landAcceptServerError(code) {
  const KEY = {
    not_owner: 'trade.err.notOwner', not_found: 'trade.err.offerGone', not_active: 'trade.err.offerGone',
    rate_limited: 'trade.err.rate', blocked_account: 'trade.err.osBlocked', disabled: 'trade.err.sellDisabled',
  };
  return t(KEY[code] || 'trade.err.acceptUnavailable');
}
function askAcceptLand(orderHash, protocolAddress, tokenId) {
  if (landAcceptBusy) return;
  const offer = (landCollOffers || []).find(o => o.offerId === orderHash) || landCollOffers?.[0];
  if (!offer) { loadLandCollOffers(); return; } // vanished between render + click
  pendingAccept = { kind: 'land', orderHash, protocolAddress: protocolAddress || offer.protocolAddress, tokenId, netEth: offer.netEth };
  patchConfirmAccept();
}
function landAcceptStatusHtml() {
  if (!landAcceptState) return '';
  const STEP = {
    prepare: 'trade.accept.preparing', approve: 'trade.accept.approve', approveWait: 'trade.accept.approveWait',
    fulfill: 'trade.accept.confirm', fulfillWait: 'trade.accept.confirmWait',
  };
  if (landAcceptState.phase === 'done') {
    const amt = landAcceptState.netEth != null ? fmtEthFiat(landAcceptState.netEth) : null;
    const explorer = landAcceptState.hash ? `<a class="trade-sold-btn" href="https://etherscan.io/tx/${esc(landAcceptState.hash)}" target="_blank" rel="noopener">${esc(t('trade.status.view'))} ↗</a>` : '';
    const unwrapBusy = unwrapState && (unwrapState.phase === 'send' || unwrapState.phase === 'wait');
    return `<div class="trade-status is-ok trade-sold">
        <div class="trade-sold-top"><span aria-hidden="true">✓</span><span>${esc(amt ? t('trade.accept.doneAmt').replace('{x}', amt) : t('trade.accept.done'))}</span></div>
        <p class="trade-sold-where">${esc(t('trade.landaccept.doneWhere'))}</p>
        <div class="trade-sold-actions">
          <button class="trade-sold-btn" data-act="unwrap-weth" type="button" ${unwrapBusy ? 'disabled' : ''}>${esc(t('trade.landaccept.unwrap'))}</button>
          <button class="trade-sold-btn" data-act="add-weth-token" type="button">${esc(t('trade.landaccept.addToken'))}</button>
          ${explorer}
        </div>
        ${unwrapStatusHtml()}
      </div>`;
  }
  if (landAcceptState.phase === 'error') return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(landAcceptState.msg)}</span></div>`;
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP[landAcceptState.phase]))}</span></div>`;
}
async function handleAcceptLandOffer(orderHash, protocolAddress, tokenId, netEth) {
  if (landAcceptBusy) return;
  landAcceptBusy = true;
  unwrapState = null; // fresh sale — drop any prior unwrap result from the done panel
  try {
    await switchToChain('0x1'); // LAND settles on Ethereum mainnet
    setLandAccept('prepare');
    const res = await fetch('/api/market/land/offer/accept/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderHash, protocolAddress, tokenId, takerAddress: account }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Accept LAND offer: prepare rejected', { orderHash, status: res.status, code: data.error });
      setLandAccept('error', { msg: landAcceptServerError(data.error) });
      if (['not_active', 'not_found'].includes(data.error)) loadLandCollOffers();
      return;
    }
    for (const tx of (data.transactions || [])) {
      const isApproval = tx.purpose === 'APPROVAL';
      setLandAccept(isApproval ? 'approve' : 'fulfill');
      // Pre-flight the fulfilment (mainnet gas is real) — if the offer was just taken or
      // became unfunded, estimateGas reverts and we bail with a clear message, no gas spent.
      if (!isApproval) {
        try {
          await eth().request({ method: 'eth_estimateGas', params: [{ from: account, to: tx.to, data: tx.data, value: tx.value && tx.value !== '0x0' ? tx.value : '0x0' }] });
        } catch (simErr) {
          console.warn('LAND accept pre-flight reverted (offer likely gone):', simErr?.message);
          setLandAccept('error', { msg: t('trade.err.offerGone') });
          loadLandCollOffers();
          return;
        }
      }
      const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to: tx.to, data: tx.data, value: tx.value && tx.value !== '0x0' ? tx.value : undefined }] });
      setLandAccept(isApproval ? 'approveWait' : 'fulfillWait', { hash });
      const receipt = await waitForReceipt(hash);
      if (!receipt || receipt.status !== '0x1') { setLandAccept('error', { msg: t('trade.err.txFailed') }); return; }
      if (!isApproval) {
        setLandAccept('done', { hash, netEth });
        sellSel = null;
        refreshAfterTx(); // sold a parcel — refresh holdings, retry as OpenSea indexes
        loadLandCollOffers();
        return;
      }
    }
    setLandAccept('error', { msg: t('trade.err.acceptUnavailable') });
  } catch (err) {
    console.error('Accept LAND offer failed:', err);
    setLandAccept('error', { msg: friendlyError(err) });
  } finally {
    landAcceptBusy = false;
    patchSellView();
  }
}

// Offer rows for the token modal: list + accept (owner) or make-an-offer (everyone else).
function modalOffersHtml(meta) {
  const isOwner = account && meta?.owner && meta.owner === account;
  const rows = tokenOffers === null
    ? `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.offers.loading'))}</div>`
    : (tokenOffers.length
        ? `<ul class="trade-offer-list">${tokenOffers.slice(0, 3).map((o, i) => `
            <li${i === 0 ? ' class="is-top"' : ''}>
              <div class="trade-offer-main">
                <span class="trade-offer-price">${esc(fmtEthFiat(o.priceEth))}</span>
                <span class="trade-offer-meta">${esc(t('trade.offers.net').replace('{x}', fmtEthFiat(o.netEth)))} · ${esc(t('trade.offers.from'))} <code>${esc(shortWallet(o.from))}</code></span>
              </div>
              ${isOwner ? `<button class="trade-offer-accept" data-act="accept-offer" data-offer="${esc(o.offerId)}" type="button" ${acceptBusyId ? 'disabled' : ''}>${esc(acceptBusyId === o.offerId ? t('trade.accept.busy') : t('trade.offers.accept'))}</button>` : ''}
            </li>`).join('')}</ul>`
        : `<p class="trade-offers-none">${esc(t('trade.offers.none'))}</p>`);

  const makeBusy = offerState && OFFER_BUSY.has(offerState.phase);
  normOfferUnit();
  const offerPh = offerUnit === 'eth' ? t('trade.offers.make.ph') : t('trade.offers.make.phFiat');
  const makeForm = !isOwner && account && onZk()
    ? `<form class="trade-offer-form" id="trade-offer-form" data-token="${esc(modalToken)}" novalidate>
        <input id="trade-offer-price" type="text" inputmode="decimal" placeholder="${esc(offerPh)}" autocomplete="off" />
        <select id="trade-offer-unit" class="seg-select trade-offer-unit" aria-label="${esc(t('trade.sell.unitAria'))}" ${fiatReady() ? '' : 'disabled'}>${offerUnitOptions()}</select>
        <button class="trade-offer-btn" type="submit" ${makeBusy ? 'disabled' : ''}>${esc(t('trade.offers.make.btn'))}</button>
        <span class="trade-offer-conv" id="trade-offer-conv">${esc(offerConvHtml(''))}</span>
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
  normOfferUnit();
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
          <span class="trade-colloffer-price">${top ? esc(fmtEthFiat(top.priceEth)) : esc(t(collOffersError ? 'trade.coll.loadErr' : 'trade.coll.none'))}</span>
        </div>
        ${account && onZk() ? `
          <form class="trade-offer-form is-inline" id="trade-coll-offer-form" novalidate>
            <input id="trade-coll-offer-price" type="text" inputmode="decimal" placeholder="${esc(offerUnit === 'eth' ? t('trade.offers.make.ph') : t('trade.offers.make.phFiat'))}" autocomplete="off" />
            <select id="trade-coll-offer-unit" class="seg-select trade-offer-unit" aria-label="${esc(t('trade.sell.unitAria'))}" ${fiatReady() ? '' : 'disabled'}>${offerUnitOptions()}</select>
            <button class="trade-offer-btn" type="submit" ${makeBusy ? 'disabled' : ''}>${esc(t('trade.coll.make.btn'))}</button>
            <span class="trade-offer-conv" id="trade-coll-offer-conv">${esc(offerConvHtml(''))}</span>
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

// LAND standing-offer strip (read-only, Phase 1): surfaces the top OpenSea collection bid
// so holders can see real demand. Selling into / creating these comes in later phases.
// Reuses the Creature strip's classes for a consistent look.
function landOfferStripHtml() {
  if (coll !== 'land') return '';
  const top = landCollOffers?.[0];
  const makeBusy = landOfferState && OFFER_BUSY.has(landOfferState.phase);
  const mineRows = (landMyOffers && landMyOffers.length)
    ? `<div class="trade-myoffers">
        <span class="trade-myoffers-h">${esc(t('trade.coll.mine.h'))}</span>
        ${landMyOffers.map(o => `
          <span class="trade-myoffer-chip">
            ${esc(t('trade.coll.chipAny'))} · ${esc(fmtEthFiat(o.priceEth))}
            <button data-act="cancel-land-offer" data-offer="${esc(o.offerId)}" type="button" aria-label="${esc(t('trade.coll.cancel'))}" ${cancelBusy ? 'disabled' : ''}>×</button>
          </span>`).join('')}
      </div>`
    : '';
  return `
    <div class="trade-colloffer" id="trade-landoffer">
      <div class="trade-colloffer-row">
        <div class="trade-colloffer-info">
          <span class="trade-colloffer-label">${esc(t('trade.landoffer.top'))} ${tipHtml('trade.landoffer.tip')}</span>
          <span class="trade-colloffer-price">${top ? esc(fmtEthFiat(top.priceEth)) : esc(t(landCollOffersError ? 'trade.coll.loadErr' : 'trade.coll.none'))}</span>
        </div>
        ${account ? `
          <form class="trade-offer-form is-inline" id="trade-land-offer-form" novalidate>
            <input id="trade-land-offer-price" type="text" inputmode="decimal" placeholder="${esc(t('trade.offers.make.ph'))}" autocomplete="off" />
            <button class="trade-offer-btn" type="submit" ${makeBusy ? 'disabled' : ''}>${esc(t('trade.landoffer.make.btn'))}</button>
          </form>` : `<span class="trade-colloffer-hint">${esc(t('trade.coll.connectHint'))}</span>`}
      </div>
      ${landOfferStatusHtml()}
      ${mineRows}
    </div>`;
}
function patchLandOfferStrip() {
  const el = root()?.querySelector('#trade-landoffer');
  if (el) el.outerHTML = landOfferStripHtml();
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

// LAND instant-sell card (Sell tab): sell the picked parcel into the top standing offer.
// Only a collection-wide offer exists for LAND (no per-token bids surfaced), so the top is
// the target. The button carries the offer hash + protocol + picked tokenId for the accept.
function landInstantSellHtml() {
  const best = landCollOffers?.[0] || null;
  if (!best) return '';
  const busy = landAcceptBusy;
  let action;
  if (sellSel != null) {
    action = `<button class="trade-send trade-instant-btn" data-act="land-instant-sell" data-offer="${esc(best.offerId)}" data-protocol="${esc(best.protocolAddress)}" data-token="${esc(sellSel)}" type="button" ${busy ? 'disabled' : ''}>
      ${esc(t('trade.instant.btn').replace('{x}', fmtEthFiat(best.netEth)))}</button>`;
  } else {
    action = `<button class="trade-send trade-instant-btn" type="button" disabled>
        ${esc(t('trade.instant.btn').replace('{x}', fmtEthFiat(best.netEth)))}</button>
      <p class="trade-beta-micro">${esc(t('trade.landinstant.pick'))}</p>`;
  }
  return `
    <div class="trade-instant">
      <div class="trade-instant-head">
        <span class="trade-instant-ico" aria-hidden="true">⚡</span>
        <div>
          <b>${esc(t('trade.instant.h'))} </b>${tipHtml('trade.landinstant.tip')}
          <p>${esc(t('trade.landinstant.line').replace('{x}', fmtEthFiat(best.priceEth)).replace('{y}', fmtEthFiat(best.netEth)))}</p>
        </div>
      </div>
      ${action}
      ${landAcceptStatusHtml()}
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
  return t(KEY[code] || 'trade.err.acceptUnavailable');
}

function setOffer(phase, extra) { offerState = { phase, ...extra }; patchModal(); patchCollStrip(); }
function setAccept(phase, extra) { acceptState = { phase, ...extra }; patchModal(); patchSellView(); }

// Place an offer: prepare → (one-time ERC20 approval) → sign typed data → create.
async function handleMakeOffer(tokenId, priceRaw, ctx) {
  if (offerState && OFFER_BUSY.has(offerState.phase)) return;
  offerCtx = ctx;
  // The user may type the offer in ETH or a fiat currency — normalize to an ETH string
  // (the order is always created in ETH on-chain) using the live rate.
  const conv = unitPriceToEth(priceRaw, offerUnit);
  if (!conv.ok) return setOffer('error', { msg: conv.msg });
  const price = conv.eth;

  try {
    setOffer('prepare');

    // Pre-flight FIRST: an offer must be BACKED by zkEVM ETH (the SDK refuses to create a bid
    // the maker can't currently cover — that rejection was surfacing as a misleading "Buying
    // is temporarily unavailable"). Check the balance ourselves and, on a shortfall, go
    // straight to the warm funds panel (balances + one-tap bridge / card top-off) instead of
    // a dead-end error — they may well hold the ETH on Ethereum mainnet.
    const zkEthBal = await readErc20(IMX_ETH_TOKEN, account);
    const needWei = BigInt(Math.round(Number(price) * 1e6)) * 10n ** 12n;
    if (zkEthBal != null && zkEthBal < needWei) return showOfferFundsHelp(Number(price), ctx);

    const res = await fetch('/api/market/creatures/offer/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, priceEth: price, ...(tokenId != null ? { tokenId } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    // Server-confirmed shortfall (e.g. balance moved between the check above and prepare) —
    // route to the same funds panel rather than the bare insufficient-funds text.
    if (!res.ok) {
      if (data.error === 'insufficient') return showOfferFundsHelp(Number(price), ctx);
      return setOffer('error', { msg: offerServerError(data.error) });
    }

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
    if (!createRes.ok) {
      if (created.error === 'insufficient') return showOfferFundsHelp(Number(price), ctx);
      return setOffer('error', { msg: offerServerError(created.error) });
    }

    setOffer('done');
    loadMyOffers();
    if (tokenId != null) loadTokenOffers(tokenId); else loadCollOffers();
  } catch (err) {
    console.error('Make offer failed:', err);
    setOffer('error', { msg: friendlyError(err) });
  }
}

// --- LAND make-offer (create a collection bid; mainnet + WETH) ---
// Like the Creature make-offer but settles in WETH: prepare may include a one-time wrap
// (ETH→WETH for the shortfall) and a conduit approval before the gasless signature.
function setLandOffer(phase, extra) { landOfferState = { phase, ...extra }; patchLandOfferStrip(); }
function landOfferServerError(code) {
  const KEY = {
    bad_price: 'trade.err.badPrice', rate_limited: 'trade.err.rate',
    blocked_account: 'trade.err.osBlocked', disabled: 'trade.err.offerDisabled',
  };
  return t(KEY[code] || 'trade.err.acceptUnavailable');
}
function landOfferStatusHtml() {
  if (!landOfferState) return '';
  const STEP = {
    prepare: 'trade.offer.preparing', wrap: 'trade.landoffer.wrap', wrapWait: 'trade.landoffer.wrapWait',
    approve: 'trade.landoffer.approve', approveWait: 'trade.offer.approveWait',
    sign: 'trade.landoffer.sign', create: 'trade.offer.create',
  };
  if (landOfferState.phase === 'done')  return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.landoffer.done'))}</span></div>`;
  if (landOfferState.phase === 'error') return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(landOfferState.msg)}</span></div>`;
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP[landOfferState.phase] || 'trade.offer.preparing'))}</span></div>`;
}
async function handleMakeLandOffer(priceRaw) {
  if (landOfferState && OFFER_BUSY.has(landOfferState.phase)) return;
  if (!account) return setLandOffer('error', { msg: t('trade.coll.connectHint') });
  const price = (priceRaw || '').trim().replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,18})?$/.test(price) || Number(price) <= 0) return setLandOffer('error', { msg: t('trade.err.badPrice') });
  try {
    await switchToChain('0x1'); // offers settle on Ethereum mainnet
    setLandOffer('prepare');
    const res = await fetch('/api/market/land/offer/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, priceEth: price }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setLandOffer('error', { msg: landOfferServerError(data.error) });

    let signature = null;
    for (const action of (data.actions || [])) {
      if (action.type === 'TRANSACTION') {
        const isWrap = action.purpose === 'WRAP';
        setLandOffer(isWrap ? 'wrap' : 'approve');
        // Before the wrap, make sure they actually hold the native ETH to wrap — otherwise
        // MetaMask throws a cryptic "insufficient funds"; this says exactly what's needed.
        if (isWrap) {
          const need = BigInt(action.value || '0x0');
          const ethBal = await readNative(account);
          if (ethBal != null && ethBal < need) {
            return setLandOffer('error', { msg: t('trade.landoffer.needEth').replace('{x}', fmtEthFiat(weiToEth(need))) });
          }
        }
        const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to: action.to, data: action.data, value: action.value && action.value !== '0x0' ? action.value : undefined }] });
        setLandOffer(isWrap ? 'wrapWait' : 'approveWait');
        const receipt = await waitForReceipt(hash);
        if (!receipt || receipt.status !== '0x1') return setLandOffer('error', { msg: t('trade.err.txFailed') });
      } else if (action.type === 'SIGNABLE') {
        setLandOffer('sign');
        signature = await signTypedData(action.typedData);
      }
    }
    if (!signature) return setLandOffer('error', { msg: t('trade.err.acceptUnavailable') });

    setLandOffer('create');
    const createRes = await fetch('/api/market/land/offer/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderParameters: data.orderParameters, signature, criteria: data.criteria }),
    });
    const created = await createRes.json().catch(() => ({}));
    if (!createRes.ok) return setLandOffer('error', { msg: landOfferServerError(created.error) });

    setLandOffer('done');
    loadLandCollOffers();
    loadLandMyOffers(); // surface the offer you just placed in "your offers"
  } catch (err) {
    console.error('Make LAND offer failed:', err);
    setLandOffer('error', { msg: friendlyError(err) });
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
    // Up to a couple of passes: the first prepare may return ERC-20 / NFT approvals that
    // must be MINED before the fulfilment can be built — accepting a bid pulls the routed
    // creator royalty from the seller's ERC-20, so a first-time seller has an approval
    // pending. Once it confirms we re-prepare and the FULFILL_ORDER comes back buildable.
    for (let pass = 0; pass < 3; pass++) {
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
        console.error('Accept offer: prepare rejected', { offerId, status: res.status, code: data.error });
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
          setAccept('done', { hash, netEth: offer?.netEth });
          sellSel = null;
          refreshAfterTx(); // sold a Creature into a bid — refresh holdings/balance, retry as Immutable indexes
          loadCollOffers();
          if (modalToken) loadTokenOffers(modalToken);
          return;
        }
      }
      // Only approvals this pass — re-prepare so the now-buildable fulfilment comes back.
      if (!data.needsRefulfill) break;
    }
    console.error('Accept offer: prepare returned no fulfilment transaction', { offerId });
    setAccept('error', { msg: t('trade.err.acceptUnavailable') });
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
  // Wrong network is an action, not a status — the pill itself switches. The chip carries
  // both a full label (desktop) and a short one (mobile, where "Immutable zkEVM" beside the
  // address would overflow the wallet row); CSS shows one or the other.
  const netFull = coll === 'land' ? t('trade.net.eth') : t('trade.net.ok');
  const netShort = coll === 'land' ? t('trade.net.eth.short') : t('trade.net.ok.short');
  const net = onRightChain()
    ? `<span class="trade-net is-ok"><span class="trade-net-full">${esc(netFull)}</span><span class="trade-net-short">${esc(netShort)}</span></span>`
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
    <button class="trade-switch" data-act="switch-account" type="button" ${busy ? 'disabled' : ''}
      title="${esc(t('trade.switch.title'))}" aria-label="${esc(t('trade.switch.title'))}">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/></svg>
    </button>
    ${net}${bal ? `<span class="trade-bar-bals">${bal}</span>` : ''}
    ${(coll === 'creatures' && onZk()) || (coll === 'land' && onRightChain()) ? `<button class="trade-cashout-pill" data-act="cashout-open" type="button" title="${esc(t('trade.cashout.barTitle'))}"><span aria-hidden="true">💸</span> ${esc(t('trade.cashout.barBtn'))}</button>` : ''}
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

// LAND plot tier ("Tier" facet) as its own chip group — Standard / Premium, always
// visible, each with its collection-wide rarity %. Same toggle mechanism as any trait
// value (data-act="flt-val"), so it reuses the existing filter handler.
function tierFacet() {
  return (browseFacets || []).find(x => x.type === 'Tier') || null;
}
function tierChipsHtml() {
  const vals = new Map((tierFacet()?.values || []).map(o => [o.v, o]));
  return TIER_VALUES.map(name => {
    const o = vals.get(name);
    const sel = traitSelected('Tier', name);
    const n = browseFacets ? (o?.n ?? 0) : null; // unknown before first response → enabled
    const pctStr = o ? fmtTraitPct(o.pct) : '';
    return `<button type="button" class="trade-flt-rchip ${sel ? 'is-on' : ''}" data-tier="${esc(name.toLowerCase())}"
      data-act="flt-val" data-type="Tier" data-val="${esc(name)}" aria-pressed="${sel}" ${n === 0 && !sel ? 'disabled' : ''}>
      <span class="trade-flt-rdot" aria-hidden="true"></span>${esc(name)}${pctStr ? `<span class="trade-flt-n">${esc(pctStr)}</span>` : ''}
    </button>`;
  }).join('');
}

function traitPopHtml(f) {
  return `<div class="trade-flt-pop" role="listbox" aria-label="${esc(f.type)}">
    ${f.values.map(({ v, n, pct }) => {
      const sel = traitSelected(f.type, v);
      const pctStr = fmtTraitPct(pct);
      return `<button type="button" class="trade-flt-opt ${sel ? 'is-on' : ''}" role="option" aria-selected="${sel}"
        data-act="flt-val" data-type="${esc(f.type)}" data-val="${esc(v)}" ${n === 0 && !sel ? 'disabled' : ''}>
        <span class="trade-flt-check" aria-hidden="true">${sel ? '✓' : ''}</span>
        <span class="trade-flt-optv">${esc(v)}</span>${pctStr ? `<span class="trade-flt-pct" title="${esc(t('trade.filter.rarityPct'))}">${esc(pctStr)}</span>` : ''}<span class="trade-flt-n">${n}</span>
      </button>`;
    }).join('')}
  </div>`;
}

function traitDropsHtml() {
  if (!browseFacets) return `<span class="trade-flt-loading">${esc(t('trade.filter.loading'))}</span>`;
  // 'Tier' is rendered as its own chip group (see tierChipsHtml), so keep it out here.
  return browseFacets.filter(f => !/rarity/i.test(f.type) && f.type !== 'Tier').map(f => {
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
      ${coll === 'land' ? `<div class="trade-side-sec">
        <h4 class="trade-side-h">${esc(t('trade.filter.tierH'))}</h4>
        <div class="trade-flt-rar" id="flt-tier" role="group" aria-label="${esc(t('trade.filter.tierAria'))}">${tierChipsHtml()}</div>
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
  const tier = r.querySelector('#flt-tier');   if (tier) tier.innerHTML = tierChipsHtml();
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
    <button type="button" class="apply-btn-ghost trade-refresh" data-act="seller-refresh">${esc(t('trade.refresh'))}</button>
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
      ${coll === 'creatures' ? collStripHtml() : landOfferStripHtml()}
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

// After ANY on-chain action (buy / sell / transfer / cancel / accept), the user's holdings,
// listings and balance change — but the external indexers (OpenSea for LAND, Immutable for
// Creatures) take a few seconds to reflect a just-mined tx. So refresh now, then again twice
// over the next ~15s, so a freshly bought/sold/transferred item shows up on its own — no
// manual reconnect needed. loadSellerData() also refreshes the wallet bar (its `finally`).
let txRefreshTimers = [];
function refreshAfterTx() {
  const tick = () => { if (!account) return; loadSellerData(); loadListings(true); };
  tick();                                       // immediate (optimistic; may pre-date indexing)
  // Staggered retries — OpenSea NFT re-indexing after a buy/transfer is usually a few
  // seconds but can run 20s+; these catch it without the user reconnecting. The manual
  // Refresh button on the Sell/Transfer toolbar is the fallback for the rare slower case.
  txRefreshTimers.forEach(clearTimeout);
  txRefreshTimers = [5000, 12000, 25000].map(ms => setTimeout(tick, ms));
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
  if (sellState.phase === 'gas') return gasHelpHtml();
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

// --- Listing history (Creatures-only) -------------------------------------------------
// A read-only record of the wallet's past listings: sold (FILLED), cancelled, or expired.
// No actions — just a log — fetched lazily by address the first time the tab is opened.

// Load history once, by address, for the active collection (Creatures → Immutable, LAND →
// OpenSea). Read-only data, so it doesn't need the wallet on the collection's chain (unlike
// the seller hub) — just a connected account. Guards against a stale resolve landing after a
// collection switch.
async function loadHistory() {
  if (!account || historyLoading) return;
  const startColl = coll;
  historyLoading = true;
  patchHistoryView();
  try {
    const r = await fetch(`${COLLECTIONS[startColl].api}/history/${account}`, { headers: { Accept: 'application/json' } })
      .then(res => res.ok ? res.json() : null).catch(() => null);
    if (coll !== startColl || !account) return; // user moved on while it was in flight
    historyError = !r;
    histItems = r && Array.isArray(r.items) ? r.items : (histItems || []);
  } finally {
    historyLoading = false;
    patchHistoryView();
  }
}

function maybeLoadHistory() {
  if (account && histItems === null && !historyLoading) loadHistory();
}

// "Jun 12, 2026" in the user's locale — when the listing reached its terminal state.
function fmtHistoryDate(iso) {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  try { return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return ''; }
}

// Each history entry's `kind` drives its badge label + colour. Trades (bought/sold) and
// transfers (received/sent/minted) come from the on-chain activity feed; cancelled/expired
// are Creature listing-lifecycle events (LAND history is trades + transfers only). See
// getMyListingHistory (server.js) and myHistory (lib/land-market.js).
const HISTORY_KIND = {
  bought:    { key: 'trade.history.kind.bought',    cls: 'is-bought' },
  sold:      { key: 'trade.history.kind.sold',      cls: 'is-sold' },
  received:  { key: 'trade.history.kind.received',  cls: 'is-received' },
  sent:      { key: 'trade.history.kind.sent',      cls: 'is-sent' },
  minted:    { key: 'trade.history.kind.minted',    cls: 'is-minted' },
  cancelled: { key: 'trade.history.kind.cancelled', cls: 'is-cancelled' },
  expired:   { key: 'trade.history.kind.expired',   cls: 'is-expired' },
};

// One timeline entry: a kind-coloured node on the rail + the card row beside it. `i` drives
// a staggered entrance reveal (capped so a long history doesn't crawl in).
function historyCardHtml(h, i = 0) {
  const k = HISTORY_KIND[h.kind] || { key: null, cls: '' };
  // Secondary line: the trade price when there is one (bought/sold/listings), otherwise the
  // counterparty for a plain transfer ("from 0x12…34" / "to 0x12…34").
  let sub = '';
  if (h.priceEth != null) {
    sub = `<span class="trade-mine-price">${esc(fmtEthFiat(h.priceEth))}</span>`;
  } else if (h.with) {
    const lbl = t(h.kind === 'sent' ? 'trade.history.to' : 'trade.history.from');
    sub = `<span class="trade-history-with">${esc(lbl)} <code>${esc(shortWallet(h.with))}</code></span>`;
  }
  const whenEsc = esc(fmtHistoryDate(h.at));
  const txLink = h.tx
    ? `<a href="${esc(txExplorerUrl(h.tx))}" target="_blank" rel="noopener" class="trade-history-tx">${esc(t('trade.history.tx'))} ↗</a>`
    : '';
  const metaLine = [whenEsc, txLink].filter(Boolean).join(' · ');
  const delay = Math.min(i * 40, 400);
  return `
    <li class="trade-tl-item" style="animation-delay:${delay}ms">
      <span class="trade-tl-dot ${k.cls}" aria-hidden="true"></span>
      <div class="trade-mine-card trade-history-card">
        ${coll === 'land' && petUrl(h)
          ? `<img src="${esc(petUrl(h))}" ${h.image ? `data-fallback="${esc(h.image)}"` : ''} alt="" loading="lazy" />`
          : (h.image ? `<img src="${esc(h.image)}" alt="" loading="lazy" />` : '<div class="trade-tile-noimg">🐾</div>')}
        <div class="trade-mine-info">
          <span class="trade-mine-name">${esc(h.name)}</span>
          ${sub}
          ${metaLine ? `<span class="trade-history-when">${metaLine}</span>` : ''}
        </div>
        <span class="trade-history-badge ${k.cls}">${esc(k.key ? t(k.key) : h.kind)}</span>
      </div>
    </li>`;
}

function historyViewHtml() {
  // Read-only by address, so the wallet need not be on zkEVM — only connected.
  if (!eth() || !account) return walletGateHtml();
  const head = `<div class="trade-history-head">
      <h4 class="trade-form-h">${esc(t('trade.history.h'))}</h4>
      <button class="apply-btn-ghost trade-refresh" data-act="history-refresh" type="button" ${historyLoading ? 'disabled' : ''}>${esc(t('trade.refresh'))}</button>
    </div>`;
  if (histItems === null) {
    return `<div class="trade-history">${head}
      <div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.history.loading'))}</div></div>`;
  }
  const body = histItems.length
    ? `<ol class="trade-timeline">${histItems.map((h, i) => historyCardHtml(h, i)).join('')}</ol>`
    : `<p class="trade-form-p">${esc(t(historyError ? 'trade.history.error' : 'trade.history.none'))}</p>`;
  return `<div class="trade-history">${head}${body}</div>`;
}

function patchHistoryView() {
  const view = root()?.querySelector('#trade-view');
  if (!view || tradeTab !== 'history') return;
  view.innerHTML = historyViewHtml();
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
  // Both collections have a History tab: Creatures via Immutable's activities + orders APIs,
  // LAND via OpenSea's account events feed.
  const TABS = [['buy', 'trade.tab.buy'], ['sell', 'trade.tab.sell'], ['transfer', 'trade.tab.transfer'],
    ['history', 'trade.tab.history']];
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
  normSellUnit();
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
            <div class="trade-price-row">
              <input id="trade-sell-price" type="text" inputmode="decimal" placeholder="${esc(sellUnit === 'eth' ? t('trade.sell.price.ph') : t('trade.sell.price.phFiat'))}" autocomplete="off" />
              <select id="trade-sell-unit" class="seg-select trade-price-unit" aria-label="${esc(t('trade.sell.unitAria'))}" ${sellFiatReady() ? '' : 'disabled'}>
                ${sellUnitOptions()}
              </select>
            </div>
            <span class="trade-price-conv" id="trade-price-conv">${esc(sellConvHtml(''))}</span></label>
          ${isLand ? landSellDurationHtml() : ''}
          ${isLand ? `<div class="trade-sell-net" id="trade-sell-net">${landSellNetHtml('')}</div>` : ''}
          <button class="trade-send" id="trade-sell-submit" type="submit" ${sellBusy || !sellSel ? 'disabled' : ''}>
            ${esc(t('trade.sell.btn'))} <span aria-hidden="true">→</span></button>
          <div id="trade-sell-status" role="status" aria-live="polite">${sellStatusHtml()}</div>
        </form>
        ${isLand ? landInstantSellHtml() : instantSellHtml()}
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
  if (tradeTab === 'history') return `<section class="trade-actions" id="trade-view">${historyViewHtml()}</section>`;
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
  if (input && price) {
    input.value = price;
    const convEl = view.querySelector('#trade-price-conv');
    if (convEl) convEl.textContent = sellConvHtml(price);
    const net = view.querySelector('#trade-sell-net');
    if (net) net.innerHTML = landSellNetHtml(sellEthFromInput(price));
  }
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
  if (!sellSel) return setSell('error', { msg: t('trade.err.noSel') });
  const conv = sellPriceToEth(form.querySelector('#trade-sell-price').value);
  if (!conv.ok) return setSell('error', { msg: conv.msg });
  const priceEth = conv.eth;

  try {
    setSell('prepare');
    const res = await fetch('/api/market/creatures/sell/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, tokenId: sellSel, priceEth }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setSell('error', { msg: sellServerError(data.error) });

    let signature = null;
    for (const action of (data.actions || [])) {
      if (action.type === 'TRANSACTION') { // one-time collection approval
        // The only on-chain step in an otherwise gasless listing — so check for IMX gas
        // right here, not before prepare (a re-list with the approval already in place is
        // gasless and must never be blocked). No gas → guided top-up instead of MetaMask's
        // phantom "not enough IMX".
        const imxBal = await readNative(account);
        if (imxBal != null && imxBal < GAS_MIN_WEI) { setSell('gas'); showGasHelp('sell'); return; }
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
    refreshAfterTx();      // "my listings" + picker + browse; retries as the orderbook indexes
  } catch (err) {
    console.error('Sell failed:', err);
    setSell('error', { msg: friendlyError(err) });
  }
}

// LAND listing: build + sign a Seaport order on Ethereum mainnet, then relay it to
// OpenSea. The server constructs the order (so fees/recipients can't be tampered with);
// the wallet signs the EIP-712 order and, the first time only, a one-off conduit approval.
async function handleSellLand(form) {
  const durationDays = Number(form.querySelector('#trade-sell-duration')?.value) || 7;
  if (!sellSel) return setSell('error', { msg: t(skey('trade.err.noSel')) });
  const conv = sellPriceToEth(form.querySelector('#trade-sell-price').value);
  if (!conv.ok) return setSell('error', { msg: conv.msg });
  const priceEth = conv.eth;

  try {
    setSell('prepare');
    await switchToChain('0x1'); // sign + approve happen on mainnet (no-op if already there)
    const res = await fetch('/api/market/land/sell/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, tokenId: sellSel, priceEth, durationDays }),
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
    // "my listings" + picker + browse, with retries — OpenSea takes a few seconds to index
    // the order and the server re-warms its listings cache ~10s out, so the ~14s retry tick
    // captures the freshly-listed parcel on the On-sale browse.
    refreshAfterTx();
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
    refreshAfterTx(); // listing gone + token sellable again — refresh + retry as the orderbook indexes
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
    refreshAfterTx(); // listing gone + parcel sellable again — refresh + retry as OpenSea de-indexes
  } catch (err) {
    console.error('LAND cancel failed:', err);
    pendingFlash = err.friendly || friendlyError(err);
  } finally {
    cancelBusy = null;
    if (pendingFlash) render(); else patchSellView();
  }
}

// Cancel one of your own LAND offers — same on-chain Seaport cancel as a listing (the
// prepare endpoint resolves offer hashes too). Settles on mainnet; costs gas.
async function handleCancelLandOffer(orderHash) {
  if (cancelBusy) return;
  cancelBusy = orderHash; patchLandOfferStrip();
  try {
    const prepRes = await fetch('/api/market/land/cancel/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderHash, accountAddress: account }),
    });
    const prep = await prepRes.json().catch(() => ({}));
    if (!prepRes.ok) {
      const CK = { not_found: 'trade.err.offerGone', not_active: 'trade.err.offerGone', rate_limited: 'trade.err.rate' };
      throw Object.assign(new Error('prepare'), { friendly: t(CK[prep.error] || 'trade.err.generic') });
    }

    await switchToChain('0x1');
    for (const tx of (prep.transactions || [])) {
      const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to: tx.to, data: tx.data, value: tx.value && tx.value !== '0x0' ? tx.value : undefined }] });
      const receipt = await waitForReceipt(hash);
      if (!receipt || receipt.status !== '0x1') throw Object.assign(new Error('tx'), { friendly: t('trade.err.txFailed') });
    }
    landMyOffers = (landMyOffers || []).filter(o => o.offerId !== orderHash);
    loadLandCollOffers();
  } catch (err) {
    console.error('LAND offer cancel failed:', err);
    pendingFlash = err.friendly || friendlyError(err);
  } finally {
    cancelBusy = null;
    if (pendingFlash) render(); else patchLandOfferStrip();
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
    // A transfer is always an on-chain tx. On zkEVM that means native IMX for gas — guide
    // the user to top up rather than letting the send hit MetaMask's phantom shortfall.
    // (LAND transfers settle on Ethereum and burn mainnet ETH; that's a separate path.)
    if (coll === 'creatures') {
      const imxBal = await readNative(account);
      if (imxBal != null && imxBal < GAS_MIN_WEI) { showGasHelp('transfer'); btn.disabled = !transferSendAllowed(); return; }
    }
    info(t('trade.status.confirm'));
    const hash = await sendTransfer(C().contract, tokenId, to);
    done(t('trade.status.sent'), hash);
    transferSel = null; transferCheck = null; transferAck = false;
    form.querySelector('#trade-to').value = '';
    refreshAfterTx(); // the item left this wallet — refresh holdings/balance, retry as the indexer catches up
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
    el.textContent = Array.isArray(owned) ? String(owned.length) : '—';
    const ethEl = root()?.querySelector('#trade-bal-eth');
    // On mainnet, read straight from the wallet (authoritative — matches MetaMask exactly).
    // Off mainnet, fall back to the server (it can read mainnet whatever chain the wallet
    // sits on). A third-party RPC can lag a recent top-up, so prefer the wallet when we can.
    if (onRightChain()) {
      if (ethEl) ethEl.textContent = fmtWeiEth(await readNative(account));
    } else {
      try {
        const ee = await fetch(`/api/market/creatures/eth-elsewhere/${account}`).then(r => r.ok ? r.json() : null);
        if (ethEl) ethEl.textContent = ee?.mainnetEthWei != null ? fmtWeiEth(BigInt(ee.mainnetEthWei)) : '—';
      } catch { /* leave em-dash */ }
    }
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
  // Command bar, two deliberate tiers so it never wraps awkwardly: the top row pairs the
  // collection switcher (left) with the wallet bar (right) — context + identity on opposite
  // ends — and the action tabs (+ safety pill) sit on their own row below. One flat wrapping
  // row used to suffice, but four action tabs pushed the wallet onto a stray second line.
  el.innerHTML = `${flashBanner()}
    <div class="trade-command">
      <div class="trade-command-top">${collSwitcherHtml()}${walletBarHtml()}</div>
      <div class="trade-command-nav">${tradeTabsHtml()}</div>
    </div>
    <div id="trade-mmwarn-slot">${walletNoticeHtml()}</div>
    <div id="trade-bridgebar-slot">${bridgeBannerHtml()}</div>
    ${viewHtml()}${modalHtml()}${safetyHtml()}<div id="trade-confirm-slot">${confirmAcceptHtml()}</div><div id="trade-cashout-slot">${cashoutHtml()}</div>`;
  ensureDelegation();
  if (account && (coll === 'land' || onZk())) {
    refreshBalance();
    maybeLoadSeller();
    if (coll === 'creatures' && myOffers === null) loadMyOffers();
    else if (coll === 'land' && landMyOffers === null) loadLandMyOffers();
  }
  // History is read-only by address — load it even when the wallet isn't on the right chain.
  if (account && tradeTab === 'history') maybeLoadHistory();
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
      if (tradeTab === 'history') maybeLoadHistory();
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
      // The new collection settles on a different chain — move the wallet there now,
      // so the user doesn't land on a "wrong network" pill they have to tap themselves.
      autoSwitchNetwork();
      loadListings(true);
      if (coll === 'creatures') loadCollOffers(); else if (coll === 'land') loadLandCollOffers();
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
    case 'history-refresh':
      if (historyLoading) return;
      histItems = null; historyError = false;
      patchHistoryView();
      return loadHistory();
    case 'accept-offer':   return askAccept(target.dataset.offer);
    case 'instant-sell':   return askAccept(target.dataset.offer, sellSel);
    case 'land-instant-sell': return askAcceptLand(target.dataset.offer, target.dataset.protocol, target.dataset.token);
    case 'accept-confirm': {
      const p = pendingAccept; pendingAccept = null; patchConfirmAccept();
      if (!p) return;
      if (p.kind === 'land') handleAcceptLandOffer(p.orderHash, p.protocolAddress, p.tokenId, p.netEth);
      else handleAcceptOffer(p.offerId, p.tokenId ?? undefined);
      return;
    }
    case 'accept-cancel':  pendingAccept = null; return patchConfirmAccept();
    case 'add-eth-token':  return addEthToken();
    case 'add-weth-token': return addWethToken();
    case 'unwrap-weth':    return handleUnwrapWeth();
    case 'cashout-open':   cashoutOpen = true; cashoutStep = 'intent'; return patchCashout();
    case 'cashout-guide':  cashoutStep = 'guide'; return patchCashout();
    case 'cashout-back':   cashoutStep = 'intent'; return patchCashout();
    case 'cashout-close':  cashoutOpen = false; return patchCashout();
    case 'cancel-offer':   return handleCancelOffer(target.dataset.offer);
    case 'cancel-land-offer': return handleCancelLandOffer(target.dataset.offer);
    case 'bridge-now':     return handleBridgeNow();
    case 'gas-bridge-now': return handleGasBridgeNow();
    case 'onramp':         return openOnramp(target.dataset.chain, target.dataset.token, Number(target.dataset.fiat) || 0);
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
    case 'switch-account': return switchAccount();
    case 'disconnect': account = null; resetSellerState(); return render();
    case 'switch':     return switchNetwork(target);
    case 'loadmore':   return loadListings(false);
    case 'retry':      return loadListings(true);
    case 'refresh':    loadListings(true); if (coll === 'creatures') loadCollOffers(); else if (coll === 'land') loadLandCollOffers(); return;
    case 'seller-refresh': loadSellerData(); loadListings(true); return; // manual wallet refresh (Sell/Transfer)
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
  if (e.target?.id === 'trade-land-offer-form') {
    e.preventDefault();
    handleMakeLandOffer(e.target.querySelector('#trade-land-offer-price')?.value);
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
  if (e.target?.id === 'trade-sell-unit') {
    const newUnit = e.target.value;
    const input = root()?.querySelector('#trade-sell-price');
    if (input) {
      const n = parseFloat(String(input.value || '').trim().replace(',', '.'));
      if (Number.isFinite(n) && n > 0) {                 // carry the typed amount across units
        const eth = toEthAmount(n, sellUnit);
        const next = eth != null ? fromEthAmount(eth, newUnit) : null;
        if (next != null) input.value = String(Number(next.toFixed(newUnit === 'eth' ? 8 : 2)));
      }
      input.placeholder = newUnit === 'eth' ? t('trade.sell.price.ph') : t('trade.sell.price.phFiat');
    }
    sellUnit = newUnit;
    try { localStorage.setItem('hcc-trade-sellunit', sellUnit); } catch { /* private mode — fine */ }
    const convEl = root()?.querySelector('#trade-price-conv');
    if (convEl) convEl.textContent = sellConvHtml(input?.value || '');
    const net = root()?.querySelector('#trade-sell-net'); // LAND only
    if (net) net.innerHTML = landSellNetHtml(sellEthFromInput(input?.value || ''));
    return;
  }
  // Make-offer unit selector (token offer in the modal, or the collection-bid strip). Same
  // amount-carry behaviour as the Sell unit, against the shared offerUnit.
  if (e.target?.id === 'trade-offer-unit' || e.target?.id === 'trade-coll-offer-unit') {
    const isColl = e.target.id === 'trade-coll-offer-unit';
    const input = root()?.querySelector(isColl ? '#trade-coll-offer-price' : '#trade-offer-price');
    const newUnit = e.target.value;
    if (input) {
      const n = parseFloat(String(input.value || '').trim().replace(',', '.'));
      if (Number.isFinite(n) && n > 0) {
        const eth = toEthAmount(n, offerUnit);
        const next = eth != null ? fromEthAmount(eth, newUnit) : null;
        if (next != null) input.value = String(Number(next.toFixed(newUnit === 'eth' ? 8 : 2)));
      }
      input.placeholder = newUnit === 'eth' ? t('trade.offers.make.ph') : t('trade.offers.make.phFiat');
    }
    offerUnit = newUnit;
    try { localStorage.setItem('hcc-trade-offerunit', offerUnit); } catch { /* private mode — fine */ }
    const convEl = root()?.querySelector(isColl ? '#trade-coll-offer-conv' : '#trade-offer-conv');
    if (convEl) convEl.textContent = offerConvHtml(input?.value || '');
    return;
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
    const convEl = root()?.querySelector('#trade-price-conv');
    if (convEl) convEl.textContent = sellConvHtml(e.target.value);
    const net = root()?.querySelector('#trade-sell-net'); // LAND only — element absent for Creatures
    if (net) net.innerHTML = landSellNetHtml(sellEthFromInput(e.target.value));
    return;
  }
  if (e.target?.id === 'trade-offer-price' || e.target?.id === 'trade-coll-offer-price') {
    const convId = e.target.id === 'trade-coll-offer-price' ? '#trade-coll-offer-conv' : '#trade-offer-conv';
    const convEl = root()?.querySelector(convId);
    if (convEl) convEl.textContent = offerConvHtml(e.target.value);
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
  histItems = null; historyError = false; // per-collection; reload on demand
  myOffers = null; offerState = null; offerCtx = null; acceptState = null; acceptBusyId = null;
  landMyOffers = null; landOfferState = null; landAcceptState = null; landAcceptBusy = false; unwrapState = null;
  sellPickOffers = null;
  transferSel = null; transferCheck = null; transferAck = false;
  gasState = null; // an in-flight bridge keeps its own banner; this is just the help panel
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
    if (cashoutOpen) { cashoutOpen = false; patchCashout(); return; }
    if (pendingAccept) { pendingAccept = null; patchConfirmAccept(); return; }
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
  try { const u = localStorage.getItem('hcc-trade-sellunit'); if (u && CURRENCIES.includes(u)) sellUnit = u; } catch { /* fine */ }
  try { const u = localStorage.getItem('hcc-trade-offerunit'); if (u && CURRENCIES.includes(u)) offerUnit = u; } catch { /* fine */ }
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
  if (coll === 'creatures') loadCollOffers(); else if (coll === 'land') loadLandCollOffers();
  if (deepToken) openDeepLink(deepToken);
}

// Re-render from in-memory state on language switch (no refetch).
export function rerenderMarketplace() {
  if (loadedOnce && root()) render();
}
