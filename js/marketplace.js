import { t } from './i18n.js';
import { DISCORD_SVG } from './apply.js';
import { loadProfile } from './profile.js';

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
// Brand marks for each collection (real assets, not emoji): the HCC glyph for Creatures,
// the Highrise LAND emoji for LAND. cdn.discordapp.com is in the page CSP img-src.
const COLL_ICONS = {
  creatures: '/img/brands/icon_hcc.png',
  land:      'https://cdn.discordapp.com/emojis/974503320414744626.webp?size=128',
};
const collIco = id => `<img class="trade-coll-ico" src="${COLL_ICONS[id]}" alt="" aria-hidden="true" />`;
const COLLECTIONS = {
  creatures: { api: '/api/market/creatures', chainHex: ZK_CHAIN_ID_HEX, contract: CREATURE_CONTRACT, labelKey: 'trade.coll.creatures' },
  land:      { api: '/api/market/land',      chainHex: '0x1',           contract: LAND_CONTRACT_L1, labelKey: 'trade.coll.land' },
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
const SEL_APPROVE       = '0x095ea7b3'; // approve(address,uint256) — ERC-20, for the cash-out router
const SEL_ALLOWANCE     = '0xdd62ed3e'; // allowance(address,address)
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
const IMX_USDC_TOKEN = '0x6de8acc0d406837030ce4dd28e7c08c5a96a30d2'; // bridged USDC on zkEVM (6 decimals, verified on-chain)
const SQUID_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // Squid's native-coin placeholder
const BRIDGE_URL = `https://app.squidrouter.com/?chains=1,13371&tokens=${SQUID_NATIVE},${IMX_ETH_TOKEN}`;
// The reverse, for sellers cashing out their proceeds: ETH-on-zkEVM → ETH-on-Ethereum.
const CASHOUT_URL = `https://app.squidrouter.com/?chains=13371,1&tokens=${IMX_ETH_TOKEN},${SQUID_NATIVE}`;
// LAND offers settle in WETH on Ethereum mainnet — a seller's proceeds arrive as this ERC-20
// (invisible in MetaMask until added). Canonical mainnet WETH.
const WETH_TOKEN = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
// USDC on Ethereum mainnet (Circle) — the dollar-pegged LAND listing currency (6 decimals,
// verified on-chain). A USDC LAND buyer's balance/allowance are read against this.
const USDC_MAINNET_TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
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
let sellCurrency = 'eth';   // the currency the listing SETTLES in: 'eth' or 'usdc' (dollar-pegged)
let offerUnit = 'eth';      // unit the buyer types an offer/bid in: 'eth' or a fiat code
let offerCurrency = 'eth';  // the currency an offer/bid SETTLES in: 'eth' or 'usdc' (dollar-pegged)
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

// Sales History state — recent completed sales, filtered by the SAME `flt` as Browse
// (search / price / traits carry over), plus its own time-ordered sort. Facets come back
// counted over the sold set, so the shared filter bar reads them via curFacets() when this
// tab is active.
let salesItems = null;         // null = not loaded; [] = loaded, none matched
let salesLoading = false;
let salesError = false;
let salesPage = 0;
let salesHasMore = false;
let salesTotal = null;
let salesSort = 'recent';      // 'recent' | 'oldest' | 'price-asc' | 'price-desc'
let salesFacets = null;
let salesReqId = 0;
let fltOpenMobile = false;     // filter drawer expanded (mobile)
let fltDebounce = null;
let browseReqId = 0;           // drops stale responses when filters change mid-flight
let browseIndexTimer = null;   // quiet re-poll while the server is still cataloguing
// Wallet view: a full address typed into the Browse search flips the grid to that wallet's
// holdings. browseOwner echoes the address the server resolved (null = normal browse).
let browseOwner = null;
let browseOwnedTotal = null;   // how many assets the wallet holds (pre-filter denominator)
// Profile search: typing a public-profile username resolves to that profile's collection
// (the union of its wallets). browseOwnerProfile = {name, slug} when the server matched one.
let browseOwnerProfile = null;
let browseProfileExpandedFor = null; // query we've already auto-expanded to scope=all
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const isWalletQuery = s => WALLET_RE.test((s || '').trim());
// Creatures only come in two tiers — Legendary and Epic. (Rare/Uncommon/Common never
// existed in the collection; listing them just showed permanently-disabled chips.)
const RARITY_TIERS = ['Legendary', 'Epic'];
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
  browseOwner = null; browseOwnedTotal = null; browseOwnerProfile = null; browseProfileExpandedFor = null;
  // Sales History shares this collection scope — drop its sold set + facets so the new
  // collection reloads its own (via maybeLoadSales on the next render).
  salesItems = null; salesFacets = null; salesPage = 0; salesHasMore = false; salesTotal = null; salesError = false;
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

// Which action tab is active inside the Trade panel: 'buy' | 'sell' | 'transfer' |
// 'sales' | 'history' | 'profile'. 'sales' is the collection-wide Sales History (shares
// the Browse filter bar); 'history' is the connected wallet's own activity ("My History").
// 'profile' swaps the content area for the holder-profile view
// (own profile + manage card, or another member's showcase via profileViewSlug).
let tradeTab = 'buy';
// Whose profile the 'profile' view shows: a slug, or null for the signed-in member's
// own setup/manage state before a profile exists.
let profileViewSlug = null;

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
// Selection is multi-select (Set of stringified tokenIds), so the picker drives BOTH
// single listings/transfers and Token-Trove-style mass ops. `sellSel`/`transferSel` stay as
// the DERIVED single selection (the one token when exactly one is picked, else null) so every
// existing single-item path — offers, instant-sell, gas checks, LAND — keeps working
// untouched; the batch panels take over only at 2+. syncSellSel/syncTransferSel keep them in
// step after any selection change. See toggleSellPick / massSelectAll.
let sellSet = new Set();
let transferSet = new Set();
let sellPrices = new Map();  // tokenId -> typed price string (in sellUnit); shared by the single
                             // form and the per-item mass-list rows, so prices survive re-renders
let massState = null;        // batch run: { kind:'sell'|'transfer', total, done, failed:[], phase, msg }
let sellSel = null;        // tokenId picked for sale (derived: set.size === 1 ? theOne : null)
let sellPickOffers = null; // specific offers on the picked token (instant-sell target)

// Transfer state: picked Creature(s) + live recipient assessment.
let transferSel = null;    // derived single selection (transferSet.size === 1 ? theOne : null)
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
// A small, reusable copy-to-clipboard chip for long codes people need to lift out
// whole — a Creature's owner wallet (so they can hunt down a lost creature), its full
// token id. We keep the compact display and put the FULL value on the button. Shows a
// copy glyph; flips to a mint "Copied!" for a beat on success (handled in copyValue).
function copyBtnHtml(value, ariaKey) {
  if (!value) return '';
  const label = esc(t(ariaKey));
  return `<button type="button" class="trade-copy" data-act="copy" data-copy="${esc(value)}" aria-label="${label}" title="${label}">`
    + `<svg class="trade-copy-ic" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">`
    + `<rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>`
    + `<path d="M6 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`
    + `</svg>`
    + `<span class="trade-copy-label">${esc(t('trade.modal.copied'))}</span></button>`;
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
// The facet set feeding the shared filter bar: the Sales tab counts over the sold set, so
// its chips read "how many recent sales match", every other browse-like view uses the
// listing/collection facets. One helper so every facet renderer stays tab-agnostic.
function curFacets() { return tradeTab === 'sales' ? salesFacets : browseFacets; }

// Look up a trait value's rarity % from the current facets (collection-wide,
// scope-independent). Null when facets aren't loaded or the value isn't catalogued.
function traitPctOf(type, value) {
  const f = (curFacets() || []).find(x => x.type === type);
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

// A past sale's fiat value AT THE TIME OF SALE. The server already valued it in USD at that
// day's ETH rate (priceUsd); other display currencies scale by today's USD→X rate (exact
// for USD, a close proxy elsewhere — same approach the price chart uses). '' when showing ETH.
function fmtSaleFiat(usd) {
  if (currency === 'eth' || usd == null || !Number.isFinite(Number(usd))) return '';
  const rate = currency === 'usd' ? 1 : fxRates[currency];
  if (rate == null) return '';
  const val = Number(usd) * rate;
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

// Resolve a typed offer price into the {currency, price} the offer endpoints expect — the
// mirror of sellPricePayload. USDC is entered directly in dollars; ETH runs through the unit
// conversion. (LAND ETH offers settle in WETH on-chain, but the buyer still types plain ETH.)
function offerPricePayload(raw) {
  if (offerCurrency === 'usdc') {
    const s = String(raw || '').trim().replace(',', '.');
    if (!/^\d{1,9}(\.\d{1,6})?$/.test(s) || !(parseFloat(s) > 0)) return { ok: false, msg: t('trade.err.badPrice') };
    return { ok: true, currency: 'usdc', price: s };
  }
  const conv = unitPriceToEth(raw, offerUnit);
  return conv.ok ? { ok: true, currency: 'eth', price: conv.eth } : conv;
}
// Compact "OFFER IN ETH | USDC" segmented picker for the offer forms (shares offerCurrency).
function offerCurrencyPickerHtml() {
  return `<div class="seg trade-cur-seg trade-offer-cur" role="tablist" aria-label="${esc(t('trade.sell.currency'))}">
    ${LISTING_CURRENCIES.map(c => `<button type="button" role="tab" class="seg-btn ${offerCurrency === c ? 'is-active' : ''}"
      aria-selected="${offerCurrency === c}" data-act="offer-cur" data-cur="${c}">${esc(CUR_SYM[c])}</button>`).join('')}
  </div>`;
}
// Currency-aware offer amount/line — reuses the listing formatters by shaping the offer row
// into a listing-like object (offers carry currency + priceAmt/netAmt + priceUsd/netUsd +
// an ETH-equivalent). Falls back to ETH for untagged/legacy rows.
const offerAsListing = (o, useNet) => ({ currency: o.currency, totalAmt: useNet ? (o.netAmt ?? o.netEth) : (o.priceAmt ?? o.priceEth), totalEth: useNet ? o.netEth : o.priceEth, priceUsd: useNet ? o.netUsd : o.priceUsd });
const fmtOfferLine = o => (o.currency ? fmtListingLine(offerAsListing(o, false)) : fmtEthFiat(o.priceEth));
const fmtOfferNetLine = o => (o.currency ? fmtListingLine(offerAsListing(o, true)) : fmtEthFiat(o.netEth));

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
async function readAllowance(token, owner, spender) {
  try { return BigInt(await eth().request({ method: 'eth_call', params: [{ to: token, data: SEL_ALLOWANCE + word(owner) + word(spender) }, 'latest'] }) || '0x0'); }
  catch { return null; }
}
// Full-precision wei → decimal ETH string ("0.169923456789012345") — the cash-out Max
// sends the EXACT balance to the quote, so the route never overdraws by a rounding hair.
function weiToEthStr(wei) {
  const s = wei.toString().padStart(19, '0');
  const frac = s.slice(-18).replace(/0+$/, '');
  return frac ? `${s.slice(0, -18)}.${frac}` : s.slice(0, -18);
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
let cashoutOpen = false;     // the cash-out modal (Creature proceeds are zkEVM ETH)
let cashoutStep = 'intent';  // 'intent' → 'move' (Creatures, in-site) | 'guide' (LAND unwrap / external fallback)
let cashoutState = null;     // move screen: {phase:'load'|'ready', balWei, imxWei, amount, quote, err}
let cashoutSeq = 0;          // drops stale quote responses when the amount changes mid-flight
let cashoutQuoteTimer = null;
let topupOpen = false;       // the standalone Add-funds modal (mainnet → zkEVM, cash-out's mirror)
let topupStep = 'intent';    // 'intent' → 'eth' (move mainnet ETH over) | 'gas' (IMX top-up)
let topupState = null;       // {phase:'load'|'ready', mainnetEthWei, mainnetImxWei, imxWei, zkEthWei, amount, quote, err, gasQuote, gasFrom}
let topupSeq = 0;
let topupQuoteTimer = null;
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

// Cash-out: selling pays in a token novices misroute when "withdrawing".
//  • Creatures: ETH on Immutable zkEVM — sent straight to an exchange it's LOST (exchanges
//    credit only mainnet ETH). Safe path: move it to Ethereum first, then send. The move
//    runs IN-SITE (quote → approve → one confirm → live tracker) — sending novices to an
//    external bridge site cost real support tickets; anything that leaves the site reads
//    as a scam risk to them. The external deep-link survives only as the quote-less
//    fallback (Squid not configured / unavailable).
//  • LAND: WETH on Ethereum — already the right network, but WETH ≠ ETH (many exchanges
//    won't credit a WETH deposit). Safe path: unwrap to ETH first, then send.
// An intent-first modal routes them to the right path for the active collection.
function cashoutHtml() {
  if (!cashoutOpen) return '';
  const inner = cashoutStep === 'move' ? cashoutMoveInner()
    : cashoutStep === 'guide'
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
      <button class="trade-cashout-opt" data-act="${coll === 'land' ? 'cashout-guide' : 'cashout-move'}" type="button">
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
// Quote-less fallback (Squid not configured / unavailable): the old step guide with the
// external deep-link. Never the first resort — see the note on cashoutHtml.
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

// --- In-site cash-out ("Move to Ethereum") -------------------------------------------
// Token-Trove-style move screen: your wallet on Immutable zkEVM → the SAME wallet on
// Ethereum, an amount prefilled with the full balance, a live quote, one button. Born
// from a support ticket: a seller sent to the external Squid deep-link (unconnected
// wallet, zero balances) froze in fear of losing her proceeds — "anything with crypto
// that opens outside of the site is something I don't like."

// The typed amount as wei (comma-tolerant — half the community types "0,17"), or null
// when unparseable/zero.
function cashoutAmountWei() {
  const v = String(cashoutState?.amount ?? '').trim().replace(',', '.');
  const m = /^(\d{1,6})(?:\.(\d{1,18}))?$/.exec(v);
  if (!m) return null;
  const wei = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0'));
  return wei > 0n ? wei : null;
}

// The quoted route tx needs native IMX: its `value` (the cross-chain relay fee) plus a
// little headroom for the zkEVM execution gas itself (which is fractions of a cent).
const CASHOUT_IMX_GAS_HEADROOM = 5n * 10n ** 16n; // 0.05 IMX
function cashoutImxNeeded(q) {
  try { return BigInt(q.tx.value || '0x0') + CASHOUT_IMX_GAS_HEADROOM; } catch { return null; }
}

async function openCashoutMove() {
  cashoutStep = 'move';
  cashoutState = { phase: 'load', balWei: null, imxWei: null, amount: '', quote: null, err: null };
  patchCashout();
  try { if (!onZk()) await ensureNetwork(); } catch { /* reads below fail soft to em-dashes */ }
  const st = cashoutState;
  const [balWei, imxWei] = await Promise.all([readErc20(IMX_ETH_TOKEN, account), readNative(account)]);
  if (cashoutState !== st || cashoutStep !== 'move') return; // closed / navigated away
  const hasBal = balWei != null && balWei > 0n;
  cashoutState = { ...st, phase: 'ready', balWei, imxWei, amount: hasBal ? weiToEthStr(balWei) : '' };
  patchCashout();
  if (hasBal) fetchCashoutQuote();
}

function queueCashoutQuote(ms = 500) {
  clearTimeout(cashoutQuoteTimer);
  cashoutQuoteTimer = setTimeout(fetchCashoutQuote, ms);
}
async function fetchCashoutQuote() {
  const st = cashoutState;
  if (!st || cashoutStep !== 'move') return;
  const seq = ++cashoutSeq;
  const wei = cashoutAmountWei();
  if (wei == null) { st.quote = null; st.err = String(st.amount).trim() ? 'amount' : null; return patchCashoutMove(); }
  if (st.balWei != null && wei > st.balWei) { st.quote = null; st.err = 'over'; return patchCashoutMove(); }
  st.quote = 'loading'; st.err = null;
  patchCashoutMove();
  try {
    const res = await fetch('/api/market/creatures/cashout/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account, amountEth: weiToEthStr(wei) }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    if (cashoutSeq !== seq || cashoutState !== st) return; // superseded
    if (!res.ok) {
      st.quote = null;
      // not_configured → no in-site quoting at all; fall back to the external-link guide.
      if (body.error === 'not_configured') { cashoutStep = 'guide'; return patchCashout(); }
      st.err = body.error === 'no_route' ? 'small' : body.error === 'rate_limited' ? 'rate' : 'quote';
      return patchCashoutMove();
    }
    st.quote = body;
    // The move is signed on zkEVM, where gas is native IMX — flag a short wallet now
    // instead of letting MetaMask fail the confirm with a cryptic alert.
    const needImx = cashoutImxNeeded(body);
    st.err = (needImx != null && st.imxWei != null && st.imxWei < needImx) ? 'gas' : null;
    patchCashoutMove();
  } catch {
    if (cashoutSeq !== seq || cashoutState !== st) return;
    st.quote = null; st.err = 'quote';
    patchCashoutMove();
  }
}

function cashoutBalLineHtml() {
  const st = cashoutState || {};
  if (st.phase === 'load') return `<span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.cashout.move.balLoading'))}`;
  if (st.balWei == null) return esc(t('trade.cashout.move.balUnknown'));
  return esc(t('trade.cashout.move.bal').replace('{x}', fmtEthFiat(weiToEth(st.balWei))));
}
function cashoutQuoteAreaHtml() {
  const st = cashoutState || {};
  const q = st.quote;
  const ERR = { over: 'trade.cashout.move.err.over', amount: 'trade.cashout.move.err.amount', small: 'trade.cashout.move.err.small', rate: 'trade.err.rate', quote: 'trade.cashout.move.err.quote' };
  if (st.err && st.err !== 'gas') return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(t(ERR[st.err]))}</span></div>`;
  if (q === 'loading') return `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.bridge.quote.loading'))}</div>`;
  if (!q) return '';
  // Don't show Squid's durationSeconds here: it's calibrated to the slow (mainnet →
  // zkEVM) direction. A real cash-out executed in 72s while the quote claimed ~23 min —
  // an ETA that wrong reads as "something's broken" to a nervous seller.
  const meta = [
    q.feeUsd != null ? t('trade.bridge.quote.fees').replace('{f}', String(q.feeUsd)) : null,
    t('trade.cashout.move.mins'),
    t('trade.bridge.quote.by'),
  ].filter(Boolean).join(' · ');
  const gasShort = st.err === 'gas';
  const needImx = cashoutImxNeeded(q);
  const busy = bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase);
  return `
    <div class="trade-bridge-quote">
      <div class="trade-bridge-line">${esc(t('trade.cashout.move.quoteLine').replace('{y}', fmtEthFiat(q.toEth)))}</div>
      <div class="trade-bridge-meta">${esc(meta)}</div>
      ${gasShort ? `<div class="trade-status is-error"><span aria-hidden="true">⛽</span><span>${esc(t('trade.cashout.move.gasShort').replace('{x}', fmtImx(weiToEth(needImx))).replace('{y}', fmtImx(weiToEth(cashoutState?.imxWei ?? 0n))))}</span></div>` : ''}
      <button class="trade-funds-btn" data-act="cashout-now" type="button" ${gasShort || busy ? 'disabled' : ''}>${esc(t('trade.cashout.move.btn'))}</button>
      ${isCashout(bridgeJob) ? bridgeStatusHtml() : ''}
    </div>`;
}
// One route hop (From / To): the SAME wallet on each side — seeing their own address
// twice is what makes the move feel safe. MetaMask mark + short address + network chip.
function cashoutHopHtml(lblKey, netImg, netName, sub) {
  const short = account ? `${account.slice(0, 6)}…${account.slice(-4)}` : '—';
  return `
    <div class="trade-cashout-hop">
      <img class="trade-cashout-hop-mm" src="${METAMASK_IMG}" alt="" width="26" height="26">
      <span class="trade-cashout-hop-tx">
        <b>${esc(t(lblKey))} · ${esc(short)}</b>
        <span>${esc(t(sub))}</span>
      </span>
      <span class="trade-bchip"><img src="${netImg}" alt="" width="14" height="14">${esc(netName)}</span>
    </div>`;
}
function cashoutMoveInner() {
  // A move is underway/finished — the tracker card takes over the modal (same pattern as
  // the funds/gas panels), so there's exactly one source of truth on screen.
  if (isCashout(bridgeJob) && CARD_PHASES.has(bridgeJob.phase)) {
    return `
      <span class="apply-pill">${esc(t('trade.cashout.badge'))}</span>
      ${bridgeCardHtml(bridgeJob)}
      <p class="trade-safety-foot">${esc(t('trade.cashout.move.foot'))}</p>`;
  }
  const st = cashoutState || {};
  return `
    <span class="apply-pill">${esc(t('trade.cashout.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.cashout.move.h'))}</h3>
    <p class="trade-safety-p">${esc(t('trade.cashout.move.p'))}</p>
    <div class="trade-cashout-route" aria-hidden="false">
      ${cashoutHopHtml('trade.cashout.move.from', '/img/brands/immutable.png', 'Immutable zkEVM', 'trade.cashout.move.fromSub')}
      <div class="trade-cashout-hop-arrow" aria-hidden="true">↓</div>
      ${cashoutHopHtml('trade.cashout.move.to', '/img/brands/eth.png', 'Ethereum', 'trade.cashout.move.toSub')}
    </div>
    <label class="trade-cashout-amtlbl" for="trade-cashout-amt">${esc(t('trade.cashout.move.amount'))}</label>
    <div class="trade-cashout-amtrow">
      <input id="trade-cashout-amt" class="trade-cashout-amt" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
        value="${esc(st.amount || '')}" placeholder="0.0" ${st.phase === 'load' ? 'disabled' : ''}>
      <span class="trade-cashout-unit" aria-hidden="true">ETH</span>
      <button class="trade-cashout-max" data-act="cashout-max" type="button" ${st.balWei ? '' : 'disabled'}>${esc(t('trade.cashout.move.max'))}</button>
    </div>
    <p class="trade-cashout-balline" id="trade-cashout-balline">${cashoutBalLineHtml()}</p>
    <div id="trade-cashout-qslot">${cashoutQuoteAreaHtml()}</div>
    <div class="trade-safety-actions">
      <button class="apply-btn-ghost" data-act="cashout-back" type="button">${esc(t('trade.cashout.back'))}</button>
    </div>
    <p class="trade-safety-foot">${esc(t('trade.cashout.move.foot'))}<br>
      <a class="trade-cashout-diy" href="${CASHOUT_URL}" target="_blank" rel="noopener">${esc(t('trade.cashout.move.diy'))} ↗</a></p>`;
}
// Patch only the quote area + balance line — the amount input keeps focus while typing.
function patchCashoutMove() {
  const slot = root()?.querySelector('#trade-cashout-qslot');
  if (slot) slot.innerHTML = cashoutQuoteAreaHtml();
  const bal = root()?.querySelector('#trade-cashout-balline');
  if (bal) bal.innerHTML = cashoutBalLineHtml();
}
function cashoutMaxClick() {
  const st = cashoutState;
  if (!st?.balWei) return;
  st.amount = weiToEthStr(st.balWei);
  const input = root()?.querySelector('#trade-cashout-amt');
  if (input) input.value = st.amount;
  clearTimeout(cashoutQuoteTimer);
  fetchCashoutQuote();
}

// Sign and send the move: (one-time) ERC-20 approval for the router, then the quoted
// route tx — both on Immutable zkEVM — then hand off to the shared resumable tracker.
async function runCashout() {
  const st = cashoutState;
  const q = st?.quote;
  if (!q || q === 'loading' || !q.tx || st.err === 'gas') return;
  if (bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase)) return; // one bridge at a time
  try {
    bridgeJob = { phase: 'switch', dir: 'out', kind: 'cashout', account, mins: null, startedAt: Date.now(), fromSym: 'ETH', toSym: 'ETH', fromEth: q.fromEth, toEth: q.toEth };
    patchCashout();
    patchBridgeBanner();
    await ensureNetwork(); // the SOURCE chain this time — Immutable zkEVM (usually a no-op)
    // The router pulls the ETH ERC-20 from the wallet, so it needs an allowance — exactly
    // the quoted amount, no open-ended approvals.
    const fromWei = BigInt(q.fromWei);
    const allowance = await readAllowance(IMX_ETH_TOKEN, account, q.approveSpender);
    if (allowance == null || allowance < fromWei) {
      setBridgeJob({ phase: 'approve' });
      const aHash = await eth().request({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: IMX_ETH_TOKEN, data: SEL_APPROVE + word(q.approveSpender) + word(fromWei) }],
      });
      const rec = await waitForReceipt(aHash);
      if (!rec || rec.status !== '0x1') { setBridgeJob({ phase: 'error', msg: t('trade.cashout.move.err.approve') }); return; }
    }
    setBridgeJob({ phase: 'confirm' });
    const hash = await eth().request({
      method: 'eth_sendTransaction',
      params: [{ from: account, to: q.tx.to, data: q.tx.data, value: q.tx.value, ...(q.tx.gas ? { gas: q.tx.gas } : {}) }],
    });
    // mins stays null: Squid's estimate is calibrated to the slow funding direction
    // (a real cash-out landed in 72s vs a quoted ~23 min). Null renders the honest
    // "a few minutes" ETA, and the 25-min tracking window still guards the slow tail.
    setBridgeJob({
      phase: 'waiting', hash, mins: null, startedAt: Date.now(), stage: 'submitted', kind: 'cashout', dir: 'out',
      axelarUrl: null, needWei: '0', quoteId: q.quoteId || '', requestId: q.requestId || '', account,
      fromSym: 'ETH', toSym: 'ETH', fromEth: q.fromEth, toEth: q.toEth,
    });
    trackBridge();
  } catch (err) {
    console.error('Cash-out failed:', err);
    setBridgeJob({ phase: 'error', msg: friendlyError(err) });
  }
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
function syncTradeModalClass() {
  document.body.classList.toggle('trade-modal-open', cashoutOpen || topupOpen || !!modalToken || !!pendingAccept);
}
function patchCashout() {
  const slot = root()?.querySelector('#trade-cashout-slot');
  if (slot) slot.innerHTML = cashoutHtml();
  syncTradeModalClass();
}

// --- Add funds ("Move to Immutable zkEVM") -------------------------------------------
// The cash-out's mirror, opened from the wallet bar BEFORE the user is mid-purchase.
// The in-checkout bridge (funds panel) only appears once a buy comes up short — anyone
// wanting to fund their wallet ahead of time used to get the external Squid deep-link,
// the same leave-the-site jump that spooks novices. Two options: move mainnet ETH over
// (exact-input quote, native source so no approval) and the ~5 IMX gas top-up (reuses
// the existing exact-output gas quote + one-tap machinery).
const TOPUP_RESERVE_WEI = BigInt(Math.round(BRIDGE_GAS_RESERVE_ETH * 1e6)) * 10n ** 12n;

function topupHtml() {
  if (!topupOpen) return '';
  const inner = topupStep === 'eth' ? topupEthInner() : topupStep === 'gas' ? topupGasInner() : topupIntentInner();
  return `
    <div class="trade-modal trade-cashout" role="dialog" aria-modal="true" aria-label="${esc(t('trade.topup.aria'))}">
      <div class="trade-modal-backdrop" data-act="topup-close"></div>
      <div class="trade-safety-card trade-cashout-card">${inner}</div>
    </div>`;
}
function patchTopup() {
  const slot = root()?.querySelector('#trade-topup-slot');
  if (slot) slot.innerHTML = topupHtml();
  syncTradeModalClass();
}
// Patch only the quote area + balance line — the amount input keeps focus while typing.
function patchTopupMove() {
  const slot = root()?.querySelector('#trade-topup-qslot');
  if (slot) slot.innerHTML = topupQuoteAreaHtml();
  const bal = root()?.querySelector('#trade-topup-balline');
  if (bal) bal.innerHTML = topupBalLineHtml();
}

// Balances on BOTH chains: mainnet via the server (the wallet sits on zkEVM and can't
// read across chains; eth-elsewhere reads ETH + IMX there), zkEVM via the wallet.
async function refreshTopupBalances() {
  const st = topupState;
  if (!st) return;
  const [elsewhere, imxWei, zkEthWei] = await Promise.all([
    fetch(`/api/market/creatures/eth-elsewhere/${account}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
    readNative(account),
    readErc20(IMX_ETH_TOKEN, account),
  ]);
  if (topupState !== st || !topupOpen) return;
  Object.assign(st, {
    phase: 'ready', imxWei, zkEthWei,
    mainnetEthWei: elsewhere?.mainnetEthWei != null ? BigInt(elsewhere.mainnetEthWei) : null,
    mainnetImxWei: elsewhere?.mainnetImxWei != null ? BigInt(elsewhere.mainnetImxWei) : null,
  });
  patchTopup();
}
function openTopup() {
  topupOpen = true;
  cashoutOpen = false; // one wallet modal at a time
  topupStep = 'intent';
  topupState = { phase: 'load', mainnetEthWei: null, mainnetImxWei: null, imxWei: null, zkEthWei: null, amount: '', quote: null, err: null, gasQuote: null, gasFrom: null };
  patchCashout();
  patchTopup();
  refreshTopupBalances();
}

function topupIntentInner() {
  const st = topupState || {};
  const loading = st.phase === 'load';
  const ethSub = loading ? t('trade.topup.checking')
    : st.mainnetEthWei != null && st.mainnetEthWei > 0n
      ? t('trade.topup.opt.eth.have').replace('{x}', fmtEthFiat(weiToEth(st.mainnetEthWei)))
      : t('trade.topup.opt.eth.none');
  const gasSub = loading ? t('trade.topup.checking')
    : t('trade.topup.opt.gas.have').replace('{x}', fmtImx(weiToEth(st.imxWei ?? 0n)));
  const opt = (act, ico, h, sub) => `
    <button class="trade-cashout-opt" data-act="${act}" type="button" ${loading ? 'disabled' : ''}>
      <span class="trade-cashout-opt-ico" aria-hidden="true">${ico}</span>
      <span class="trade-cashout-opt-tx"><b>${esc(t(h))}</b><span>${esc(sub)}</span></span>
      <span class="trade-cashout-opt-arrow" aria-hidden="true">→</span>
    </button>`;
  return `
    <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.topup.h'))}</h3>
    <p class="trade-safety-p">${esc(t('trade.topup.p'))}</p>
    <div class="trade-cashout-opts">
      ${opt('topup-eth', '💎', 'trade.topup.opt.eth.h', ethSub)}
      ${opt('topup-gas', '⛽', 'trade.topup.opt.gas.h', gasSub)}
    </div>
    <p class="trade-safety-foot">${esc(t('trade.topup.foot'))}</p>`;
}

// The typed amount as wei (comma-tolerant), or null when unparseable/zero.
function topupAmountWei() {
  const v = String(topupState?.amount ?? '').trim().replace(',', '.');
  const m = /^(\d{1,6})(?:\.(\d{1,18}))?$/.exec(v);
  if (!m) return null;
  const wei = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0'));
  return wei > 0n ? wei : null;
}
// The most they can move: mainnet balance minus the L1 gas the move tx itself needs.
function topupMaxWei() {
  const st = topupState;
  if (st?.mainnetEthWei == null) return null;
  const max = st.mainnetEthWei - TOPUP_RESERVE_WEI;
  return max > 0n ? max : null;
}
function topupBalLineHtml() {
  const st = topupState || {};
  if (st.phase === 'load') return `<span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.cashout.move.balLoading'))}`;
  if (st.mainnetEthWei == null) return esc(t('trade.cashout.move.balUnknown'));
  return esc(t('trade.topup.eth.bal').replace('{x}', fmtEthFiat(weiToEth(st.mainnetEthWei))));
}
function topupQuoteAreaHtml() {
  const st = topupState || {};
  const q = st.quote;
  // Quoting unavailable altogether (Squid not configured) → the prefilled deep-link.
  if (st.err === 'fallback') return `<a class="trade-funds-btn" href="${BRIDGE_URL}" target="_blank" rel="noopener">${esc(t('trade.funds.bridgeBtn'))} ↗</a>`;
  const ERR = { over: 'trade.topup.eth.err.over', amount: 'trade.cashout.move.err.amount', small: 'trade.cashout.move.err.small', rate: 'trade.err.rate', quote: 'trade.cashout.move.err.quote' };
  if (st.err && st.err !== 'gas') return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(t(ERR[st.err]))}</span></div>`;
  if (q === 'loading') return `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.bridge.quote.loading'))}</div>`;
  if (!q) return '';
  const mins = q.durationSeconds ? Math.max(1, Math.ceil(q.durationSeconds / 60)) : null;
  const meta = [
    q.feeUsd != null ? t('trade.bridge.quote.fees').replace('{f}', String(q.feeUsd)) : null,
    mins != null ? t('trade.bridge.quote.mins').replace('{m}', String(mins)) : null,
    t('trade.bridge.quote.by'),
  ].filter(Boolean).join(' · ');
  const feesShort = st.err === 'gas';
  const busy = bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase);
  return `
    <div class="trade-bridge-quote">
      <div class="trade-bridge-line">${esc(t('trade.topup.eth.quoteLine').replace('{y}', fmtEthFiat(q.toEth)))}</div>
      <div class="trade-bridge-meta">${esc(meta)}</div>
      ${feesShort ? `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(t('trade.topup.eth.err.fees'))}</span></div>` : ''}
      <button class="trade-funds-btn" data-act="topup-now" type="button" ${feesShort || busy ? 'disabled' : ''}>${esc(t('trade.topup.eth.btn'))}</button>
      ${bridgeJob && !isGasBridge(bridgeJob) && !isOutBridge(bridgeJob) ? bridgeStatusHtml() : ''}
    </div>`;
}
function topupEthInner() {
  // A funding move is underway/finished — the tracker card takes over (this also covers
  // a checkout-shortfall bridge already in flight: same job, same truth).
  if (bridgeJob && !isGasBridge(bridgeJob) && !isOutBridge(bridgeJob) && CARD_PHASES.has(bridgeJob.phase)) {
    return `
      <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
      ${bridgeCardHtml(bridgeJob)}
      <p class="trade-safety-foot">${esc(t('trade.topup.foot'))}</p>`;
  }
  const st = topupState || {};
  // Known-empty mainnet wallet: nothing to move — route to the card on-ramp instead
  // (it delivers to Ethereum; the note says to come back and move it over).
  const noEth = st.phase === 'ready' && st.mainnetEthWei != null && st.mainnetEthWei <= TOPUP_RESERVE_WEI;
  const body = noEth ? `
    <p class="trade-cashout-balline">${esc(t('trade.topup.eth.none'))}</p>
    <button class="trade-funds-btn" data-act="onramp" data-chain="ethereum" data-token="ETH" type="button">${esc(t('trade.onramp.btn'))} ↗</button>
    <p class="trade-cashout-balline">${esc(t('trade.topup.eth.cardNote'))}</p>` : `
    <label class="trade-cashout-amtlbl" for="trade-topup-amt">${esc(t('trade.cashout.move.amount'))}</label>
    <div class="trade-cashout-amtrow">
      <input id="trade-topup-amt" class="trade-cashout-amt" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
        value="${esc(st.amount || '')}" placeholder="0.05" ${st.phase === 'load' ? 'disabled' : ''}>
      <span class="trade-cashout-unit" aria-hidden="true">ETH</span>
      <button class="trade-cashout-max" data-act="topup-max" type="button" ${topupMaxWei() ? '' : 'disabled'}>${esc(t('trade.cashout.move.max'))}</button>
    </div>
    <p class="trade-cashout-balline" id="trade-topup-balline">${topupBalLineHtml()}</p>
    <div id="trade-topup-qslot">${topupQuoteAreaHtml()}</div>`;
  return `
    <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.topup.eth.h'))}</h3>
    <p class="trade-safety-p">${esc(t('trade.topup.eth.p'))}</p>
    <div class="trade-cashout-route">
      ${cashoutHopHtml('trade.cashout.move.from', '/img/brands/eth.png', 'Ethereum', 'trade.topup.eth.fromSub')}
      <div class="trade-cashout-hop-arrow" aria-hidden="true">↓</div>
      ${cashoutHopHtml('trade.cashout.move.to', '/img/brands/immutable.png', 'Immutable zkEVM', 'trade.topup.eth.toSub')}
    </div>
    ${body}
    <div class="trade-safety-actions">
      <button class="apply-btn-ghost" data-act="topup-back" type="button">${esc(t('trade.cashout.back'))}</button>
    </div>
    <p class="trade-safety-foot">${esc(t('trade.topup.foot'))}</p>`;
}

function queueTopupQuote(ms = 500) {
  clearTimeout(topupQuoteTimer);
  topupQuoteTimer = setTimeout(fetchTopupQuote, ms);
}
async function fetchTopupQuote() {
  const st = topupState;
  if (!st || topupStep !== 'eth') return;
  const seq = ++topupSeq;
  const wei = topupAmountWei();
  if (wei == null) { st.quote = null; st.err = String(st.amount).trim() ? 'amount' : null; return patchTopupMove(); }
  if (st.mainnetEthWei != null && wei + TOPUP_RESERVE_WEI > st.mainnetEthWei) { st.quote = null; st.err = 'over'; return patchTopupMove(); }
  st.quote = 'loading'; st.err = null;
  patchTopupMove();
  try {
    const res = await fetch('/api/market/creatures/topup/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account, amountEth: weiToEthStr(wei) }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    if (topupSeq !== seq || topupState !== st) return; // superseded
    if (!res.ok) {
      st.quote = null;
      st.err = body.error === 'not_configured' ? 'fallback'
        : body.error === 'no_route' ? 'small' : body.error === 'rate_limited' ? 'rate' : 'quote';
      return patchTopupMove();
    }
    st.quote = body;
    // The move is signed on Ethereum: the wallet pays tx.value (input + relay fee) plus
    // that tx's own L1 gas — flag a shortfall before MetaMask fails it cryptically.
    try {
      st.err = (st.mainnetEthWei != null && st.mainnetEthWei < BigInt(body.tx.value || '0x0') + TOPUP_RESERVE_WEI) ? 'gas' : null;
    } catch { st.err = null; }
    patchTopupMove();
  } catch {
    if (topupSeq !== seq || topupState !== st) return;
    st.quote = null; st.err = 'quote';
    patchTopupMove();
  }
}
function topupMaxClick() {
  const st = topupState;
  const max = topupMaxWei();
  if (!st || max == null) return;
  st.amount = weiToEthStr(max);
  const input = root()?.querySelector('#trade-topup-amt');
  if (input) input.value = st.amount;
  clearTimeout(topupQuoteTimer);
  fetchTopupQuote();
}
async function runTopupEth() {
  const st = topupState;
  const q = st?.quote;
  if (!q || q === 'loading' || !q.tx || st.err === 'gas') return;
  // Arrival target for the tracker's balance signal: what's on zkEVM now plus most of
  // the quoted arrival (the estimate can drift a little; Squid's status is primary).
  let needWei = 0n;
  const cur = await readErc20(IMX_ETH_TOKEN, account);
  const toWei = BigInt(Math.round((Number(q.toEth) || 0) * 1e6)) * 10n ** 12n;
  if (cur != null && toWei > 0n) needWei = cur + (toWei * 95n) / 100n;
  return runBridge(q, { kind: 'eth', needWei });
}

// IMX gas option: reuses the exact-output gas quote (~5 IMX target) and one-tap flow the
// Buy/Sell/Transfer panels already use — just reachable before anything fails for gas.
async function openTopupGas() {
  const st = topupState;
  if (!st || st.phase !== 'ready') return;
  topupStep = 'gas';
  st.err = null;
  st.gasFrom = st.mainnetImxWei != null && st.mainnetImxWei > 0n ? 'imx'
    : st.mainnetEthWei != null && st.mainnetEthWei > TOPUP_RESERVE_WEI ? 'eth' : null;
  if (!st.gasFrom) { st.gasQuote = null; patchTopup(); return; }
  st.gasQuote = 'loading';
  patchTopup();
  const seq = ++topupSeq;
  try {
    const res = await fetch('/api/market/creatures/bridge/gas/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account, needImx: String(GAS_TARGET_IMX), from: st.gasFrom }),
      signal: AbortSignal.timeout(30000),
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (topupSeq !== seq || topupState !== st || topupStep !== 'gas') return;
    st.gasQuote = body && body.tx ? body : null;
    patchTopup();
  } catch {
    if (topupSeq !== seq || topupState !== st) return;
    st.gasQuote = null;
    patchTopup();
  }
}
function topupGasInner() {
  if (isGasBridge(bridgeJob) && CARD_PHASES.has(bridgeJob.phase)) {
    return `
      <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
      ${bridgeCardHtml(bridgeJob)}
      <p class="trade-safety-foot">${esc(t('trade.topup.foot'))}</p>`;
  }
  const st = topupState || {};
  const g = st.gasQuote;
  const gasOk = st.imxWei != null && st.imxWei >= GAS_OK_WEI;
  const balLine = st.phase === 'load'
    ? `<span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.cashout.move.balLoading'))}`
    : esc(t(gasOk ? 'trade.topup.gas.balOk' : 'trade.topup.gas.bal').replace('{x}', fmtImx(weiToEth(st.imxWei ?? 0n))));
  let area;
  if (g === 'loading') {
    area = `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.bridge.quote.loading'))}</div>`;
  } else if (g && g.tx) {
    const mins = g.durationSeconds ? Math.max(1, Math.ceil(g.durationSeconds / 60)) : null;
    const meta = [
      g.feeUsd != null ? t('trade.bridge.quote.fees').replace('{f}', String(g.feeUsd)) : null,
      mins != null ? t('trade.bridge.quote.mins').replace('{m}', String(mins)) : null,
      t('trade.bridge.quote.by'),
    ].filter(Boolean).join(' · ');
    const fromTxt = st.gasFrom === 'imx' ? fmtImx(g.fromEth) : fmtEthFiat(g.fromEth);
    const busy = bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase);
    area = `
      <div class="trade-bridge-quote">
        <div class="trade-bridge-line">${esc(t('trade.gas.bridge.line').replace('{x}', fromTxt).replace('{y}', fmtImx(g.toEth)))}</div>
        <div class="trade-bridge-meta">${esc(meta)}</div>
        <button class="trade-funds-btn" data-act="topup-gas-now" type="button" ${busy ? 'disabled' : ''}>${esc(t('trade.gas.bridge.now'))}</button>
        ${isGasBridge(bridgeJob) ? bridgeStatusHtml() : ''}
      </div>`;
  } else if (!st.gasFrom && st.phase === 'ready') {
    // Nothing on Ethereum to bridge or swap — the card on-ramp delivers IMX straight
    // to Immutable zkEVM.
    area = `
      <p class="trade-cashout-balline">${esc(t('trade.topup.gas.none'))}</p>
      <button class="trade-funds-btn" data-act="onramp" data-chain="zkevm" data-token="IMX" type="button">${esc(t('trade.onramp.btn'))} ↗</button>`;
  } else {
    // Quote failed / not configured — the matching manual deep-link.
    area = `<a class="trade-funds-btn" href="${st.gasFrom === 'imx' ? GAS_BRIDGE_URL_IMX : GAS_BRIDGE_URL}" target="_blank" rel="noopener">${esc(t('trade.gas.getBtn'))} ↗</a>`;
  }
  return `
    <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.topup.gas.h'))}</h3>
    <p class="trade-safety-p">${esc(t('trade.topup.gas.p'))}</p>
    <p class="trade-cashout-balline">${balLine}</p>
    ${area}
    <div class="trade-safety-actions">
      <button class="apply-btn-ghost" data-act="topup-back" type="button">${esc(t('trade.cashout.back'))}</button>
    </div>
    <p class="trade-safety-foot">${esc(t('trade.topup.foot'))}</p>`;
}
function runTopupGas() {
  const st = topupState;
  if (!st?.gasQuote || st.gasQuote === 'loading') return;
  const needWei = BigInt(Math.round(GAS_TARGET_IMX * 1e6)) * 10n ** 12n;
  return runBridge(st.gasQuote, { kind: 'gas', needWei, fromSym: st.gasFrom === 'imx' ? 'IMX' : 'ETH', toSym: 'IMX' });
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
// Chain WE just asked the wallet to switch to. Its `chainChanged` echo is handled in
// place by the initiating flow — without this flag the echo triggered a third full
// re-render on every collection switch (after the switch flow's own two), which is
// what made the wallet bar / profile / filters / grid visibly blink twice.
let expectedChainHex = null;

async function switchToChain(hex) {
  const want = String(hex).toLowerCase();
  expectedChainHex = want; // the coming chainChanged event is ours
  try {
    if (hex === ZK_CHAIN_ID_HEX) { await ensureNetwork(); return; }
    await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    chainId = await eth().request({ method: 'eth_chainId' });
  } catch (err) {
    if (expectedChainHex === want) expectedChainHex = null; // declined — future events are external
    throw err;
  }
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
  let switched = false;
  try { await switchToChain(C().chainHex); switched = true; }
  catch (err) { console.error('Auto network switch declined:', err); /* pill remains */ }
  finally { busy = false; }
  if (!switched) return; // declined — the view already shows the wrong-network pill
  // The chain settled under an already-rendered view. Patch only what the chain touches
  // — wallet bar, the sell/transfer network gates, the seller loads those gates blocked —
  // instead of a full re-render (the second whole-panel blink on collection switches).
  patchWalletBar();
  patchSellView();
  patchTransferView();
  maybeLoadSeller();
}

// Repaint just the wallet bar (network pill, balances, action pills) in place.
function patchWalletBar() {
  const bar = root()?.querySelector('.trade-command .trade-bar');
  if (bar) bar.outerHTML = walletBarHtml();
  if (account && (coll === 'land' || onZk())) refreshBalance();
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
    browseOwner = data.owner || null;
    browseOwnedTotal = data.ownedTotal ?? null;
    browseOwnerProfile = data.ownerProfile || null;
    browseHadFilters = hadFilters;
    if (data.facets) browseFacets = data.facets;
    if (data.priceRange) browsePriceRange = data.priceRange;
    // A profile-username match defaults to their WHOLE collection ("show all their NFTs"),
    // so flip to scope=all once per query, then let the toggle take over. Guard by query
    // string so it never loops (the reloaded 'all' response no longer trips the condition).
    if (browseOwnerProfile && flt.scope !== 'all' && browseProfileExpandedFor !== flt.q) {
      browseProfileExpandedFor = flt.q;
      flt.scope = 'all';
      patchFilters();
      loadBrowse(true);
      return;
    }
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

// The filter bar is shared by Buy and Sales History, so a filter change reloads whichever
// feed is on screen — the sold set on the Sales tab, the listings otherwise.
function reloadActiveFeed(reset = true) {
  return tradeTab === 'sales' ? loadSales(reset) : loadBrowse(reset);
}

// Re-fetch from page 0 after any filter change, debounced for typed input — every
// keystroke must not become a request (and the rate limiter agrees).
function applyFilters(debounceMs = 0) {
  clearTimeout(fltDebounce);
  if (!debounceMs) { patchFilters(); reloadActiveFeed(true); return; }
  patchFilters();
  fltDebounce = setTimeout(() => reloadActiveFeed(true), debounceMs);
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

// --- Listing currency (ETH + USDC on zkEVM) -------------------------------------------
// A listing carries its own `currency` ('eth'|'usdc') + native `priceAmt`/`totalAmt` + an
// all-in `priceUsd`. These helpers show the NATIVE price plus a secondary estimate in the
// user's chosen display currency, and degrade to the old ETH-only path for rows without a
// currency tag (LAND parcels, older cached rows).
const CUR_SYM = { eth: 'ETH', usdc: 'USDC' };
const LISTING_CURRENCIES = ['eth', 'usdc']; // seller's choice of listing denomination
function fmtListingAmt(it) {
  const cur = it.currency || 'eth';
  const amt = it.totalAmt ?? it.priceAmt ?? it.totalEth ?? it.priceEth;
  const n = Number(amt);
  if (!Number.isFinite(n)) return '—';
  return `${n.toLocaleString(undefined, { maximumFractionDigits: cur === 'usdc' ? 2 : 4 })} ${CUR_SYM[cur] || 'ETH'}`;
}
function fmtListingFiat(it) {
  if (it.currency && it.priceUsd != null) {
    // Showing prices in ETH: a USDC listing gets its ETH-equivalent as the secondary (when we
    // know it — some light surfaces like My Listings carry no rate), an ETH listing needs none.
    if (currency === 'eth') return it.currency === 'eth' || it.totalEth == null ? '' : `≈ ${fmtEth(it.totalEth)}`;
    const rate = currency === 'usd' ? 1 : fxRates[currency];
    if (rate == null) return '';
    const val = it.priceUsd * rate;
    try { return `≈ ${new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(val)}`; }
    catch { return `≈ ${Math.round(val).toLocaleString()} ${currency.toUpperCase()}`; }
  }
  return fmtFiat(it.totalEth ?? it.priceEth); // legacy / LAND rows (ETH-only)
}
// "0.15 ETH (≈ $282)" / "250 USDC (≈ $250)" — one-line native + estimate, for compact rows.
function fmtListingLine(it) {
  const fiat = fmtListingFiat(it);
  return fiat ? `${fmtListingAmt(it)} (${fiat})` : fmtListingAmt(it);
}

function tileHtml(it) {
  const unlisted = it.listed === false; // scope=all rows; LAND/listed rows lack the flag
  const fiat = unlisted ? '' : fmtListingFiat(it);
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
    : `<span class="trade-tile-price ${it.currency === 'usdc' ? 'is-usdc' : ''}">${esc(fmtListingAmt(it))}</span>`;
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
    // A resolved wallet with nothing to show: either it holds none of this collection, or
    // the extra filters emptied its holdings — say which, and offer the matching way out.
    if (isBrowseView() && browseOwner) {
      const noun = t(coll === 'land' ? 'trade.wallet.nounLand' : 'trade.wallet.noun');
      if (extraFiltersActive()) {
        return `<div class="trade-grid-state"><div class="trade-grid-state-ico" aria-hidden="true">🔍</div><p>${esc(t(browseDataset().noMatch))}</p>
          <button class="apply-btn-ghost" data-act="flt-clear" type="button">${esc(t('trade.filter.clear'))}</button></div>`;
      }
      return `<div class="trade-grid-state"><div class="trade-grid-state-ico" aria-hidden="true">👛</div><p>${esc(t('trade.wallet.empty').replace('{noun}', noun))}</p>
        <button class="apply-btn-ghost" data-act="flt-rm" data-kind="q" type="button">${esc(t('trade.wallet.clear'))}</button></div>`;
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
    // Listed parcels: the seller IS the current owner (you can't list what you don't
    // hold, and estate-locked parcels can't be listed). Unlisted parcels have no seller
    // here — openModal fills the owner in from the on-chain read.
    owner: it.seller || null,
  };
}
// Unlisted LAND has no seller in its browse row, so fetch the on-chain owner and patch
// it into the open modal. A nice-to-have — quietly do nothing if it fails or the user
// has already moved on to another token.
async function fetchLandOwner(tokenId) {
  try {
    const res = await fetch(`/api/market/land/token/${encodeURIComponent(tokenId)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    if (data.owner && modalMeta && !modalMeta.owner && String(modalToken) === String(tokenId)) {
      modalMeta.owner = data.owner;
      patchModal();
    }
  } catch { /* owner is optional detail — ignore */ }
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
    if (!modalMeta.owner) fetchLandOwner(tokenId); // unlisted parcel → fill owner from chain
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

async function openDeepLink(tokenId, opts = {}) {
  const wantColl = coll;
  // Known-unlisted (a profile tile told us): don't enter the "brand-new listing, syncing…"
  // hunt — that message is for a listing that may still be propagating, not for an item
  // the owner simply hasn't listed. Open the detail modal straight to "Not listed".
  if (opts.knownListed === false) { linkSync = null; openModal(tokenId); return; }
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

// Highrise LAND token ids pack the parcel coords as (x<<16)|y — decode them so the
// slime portrait can render even when neither the listing feed nor the token metadata
// carries coords (e.g. a profile-opened unlisted parcel).
function coordsFromLandId(tokenId) {
  const n = Number(tokenId);
  if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) return null;
  const x = n >>> 16, y = n & 0xffff;
  return x > 0 && y > 0 ? { x, y } : null;
}

function modalCardHtml() {
  const it = listingForToken(modalToken) || {};
  const meta = modalMeta || {};
  let image = meta.image || it.image;
  let imgFallback = '';
  // LAND leads with its slime portrait (same as the tiles), keeping the plot render as
  // the on-error fallback — the token endpoint's image is the plot, which reads wrong
  // next to a grid full of slimes.
  if (coll === 'land') {
    const c = meta.coords || it.coords || coordsFromLandId(modalToken);
    const pet = Number.isInteger(c?.x) && Number.isInteger(c?.y) ? `/api/market/land/pet/${c.x}/${c.y}` : null;
    if (pet && image !== pet) { imgFallback = image || ''; image = pet; }
  }
  const name = meta.name || it.name || `Highrise Creature #${modalToken}`;
  const img = image
    ? `<img class="trade-modal-img" src="${esc(image)}"${imgFallback ? ` data-fallback="${esc(imgFallback)}"` : ''} alt="${esc(name)}" />`
    : `<div class="trade-modal-img trade-tile-noimg" aria-hidden="true">🐾</div>`;

  const allIn = it.totalEth ?? it.priceEth;
  const modalFiat = it.currency ? fmtListingFiat(it) : fmtFiat(allIn);
  const modalPrice = it.currency ? fmtListingAmt(it) : fmtEth(allIn);
  const price = it.priceEth != null
    ? `<div class="trade-modal-price">
         <span class="trade-modal-price-eth ${it.currency === 'usdc' ? 'is-usdc' : ''}">${esc(modalPrice)}</span>
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

  const owner = meta.owner
    ? `<div class="trade-modal-meta-row">${esc(t('trade.modal.owner'))}: <code title="${esc(meta.owner)}">${esc(shortWallet(meta.owner))}</code>${copyBtnHtml(meta.owner, 'trade.modal.copyOwner')}</div>`
    : '';
  // Slimes live on a parcel — show its coordinates, not the parcel's 50-digit token id.
  const idRow = meta.isSlime
    ? `<div class="trade-modal-meta-row">${esc(t('trade.land.parcel'))}: <code>${esc(meta.parcelName || `(${meta.coords?.x}, ${meta.coords?.y})`)}</code></div>`
    : `<div class="trade-modal-meta-row">${esc(t('trade.modal.tokenId'))}: <code class="trade-modal-tokenid">${esc(modalToken)}</code>${copyBtnHtml(String(modalToken), 'trade.modal.copyId')}</div>`;
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
  // A price bridge is underway/finished — the tracker card takes over the panel (no duplicate
  // header/quote above it, and no double frame).
  if (bridgeJob && !isGasBridge(bridgeJob) && CARD_PHASES.has(bridgeJob.phase)) return bridgeCardHtml(bridgeJob);
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
          ${bridgeJob && !isGasBridge(bridgeJob) && bridgeJob.phase === 'done' ? '' : `<button class="trade-funds-btn" data-act="bridge-now" type="button" ${busy ? 'disabled' : ''}>${esc(t('trade.bridge.now'))}</button>`}
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
  // A gas bridge is underway/finished — the tracker card IS the panel now (no duplicate
  // "Almost there" header or quote line above it, and no double frame).
  if (isGasBridge(bridgeJob) && CARD_PHASES.has(bridgeJob.phase)) return bridgeCardHtml(bridgeJob);
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
        ${isGasBridge(bridgeJob) && bridgeJob.phase === 'done' ? '' : `<button class="trade-funds-btn" data-act="gas-bridge-now" type="button" ${busyBridge ? 'disabled' : ''}>${esc(t('trade.gas.bridge.now'))}</button>`}
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
    // noreferrer matters: Transak 403s the widget (T-INF-201) if a Referer outside the
    // partner account's whitelist reaches it. The server also sends Referrer-Policy:
    // same-origin site-wide; this is belt-and-braces for the popup fallback path.
    if (tab) tab.location = url; else window.open(url, '_blank', 'noopener,noreferrer');
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
// Phases where the tracker CARD takes over the panel (replacing its quote/CTA chrome). The
// transient switch/confirm/back phases stay as a small inline status line instead.
const CARD_PHASES = new Set(['waiting', 'slow', 'done', 'error']);

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
    // Only resume a bridge that's still in flight (waiting/slow). A finished job (done/error)
    // has no live purpose across a reload — restoring it just leaves a stale global that
    // suppresses the next top-up's action button and shows a day-old banner.
    if (j.phase === 'done' || j.phase === 'error') {
      localStorage.removeItem(BRIDGE_STORE);
      return null;
    }
    return j;
  } catch { return null; }
}
function dismissBridge() {
  const wasCashout = isCashout(bridgeJob);
  bridgeJob = null;
  try { localStorage.removeItem(BRIDGE_STORE); } catch { /* fine */ }
  patchBridgeBanner();
  patchModal();
  // Dismissing a cash-out from inside the move screen: re-read balances (the move just
  // changed them) so the refreshed screen offers what's actually left.
  if (wasCashout && cashoutOpen && cashoutStep === 'move') openCashoutMove();
  else patchCashout();
  // Same for the Add-funds modal: balances on both chains just moved.
  if (topupOpen && topupState) { topupState.phase = 'load'; patchTopup(); refreshTopupBalances(); }
  else patchTopup();
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// A cash-out runs the same rails the other way (zkEVM → mainnet) — dir 'out' flips the
// source-chain explorer, the route chips and the copy everywhere below.
const isOutBridge = b => b?.dir === 'out';

function bridgeLinksHtml(b) {
  if (!b?.hash) return '';
  const axelar = b.axelarUrl || `https://axelarscan.io/gmp/${b.hash}`;
  const src = isOutBridge(b)
    ? `<a href="${EXPLORER}/tx/${esc(b.hash)}" target="_blank" rel="noopener">${esc(t('trade.bridge.zkExplorer'))}</a>`
    : `<a href="https://etherscan.io/tx/${esc(b.hash)}" target="_blank" rel="noopener">${esc(t('trade.bridge.etherscan'))}</a>`;
  return `${src}
    · <a href="${esc(axelar)}" target="_blank" rel="noopener">${esc(t('trade.bridge.axelar'))}</a>`;
}

// --- Bridge tracker card (Squid-inspired, Highrise-branded) --------------------------------
// A self-contained card that becomes the focal element of the funds/gas panel while a bridge
// is underway — the panel drops its own quote/CTA chrome for it (see gasHelpHtml/fundsHelpHtml).
// Covers every card phase: waiting/slow (live stepper) and done/error (hero result).
const ETA_MINS = b => (b.mins ? `~${b.mins} ${t('trade.bridge.min')}` : t('trade.bridge.mins.few'));

// Amount in its own units — "0.0004 ETH" / "5.05 IMX".
function fmtBridgeAmt(v, sym) {
  if (v == null) return '—';
  return sym === 'IMX' ? fmtImx(v) : fmtEth(v);
}
// One token avatar (real brand mark); `gas` adds the ⛽ spark on the destination coin.
function bridgeCoinHtml(sym, gas) {
  const imx = sym === 'IMX';
  return `<span class="trade-bcoin trade-bcoin-${imx ? 'imx' : 'eth'}">
    <img src="${imx ? '/img/brands/imx.png' : '/img/brands/eth.png'}" alt="" width="30" height="30">
    ${gas ? '<span class="trade-bcoin-spark" aria-hidden="true">⛽</span>' : ''}
  </span>`;
}
// Source → destination token pair for the card header.
function bridgePairHtml(b) {
  const gas = isGasBridge(b);
  return `<div class="trade-bpair" aria-hidden="true">
    ${bridgeCoinHtml(b.fromSym || 'ETH')}
    <span class="trade-bpair-arrow">→</span>
    ${bridgeCoinHtml(b.toSym || (gas ? 'IMX' : 'ETH'), gas)}
  </div>`;
}
// The Squid-style from→to detail rows (Send/receive · Route · Time), or the summary on done.
function bridgeRowsHtml(b, done) {
  const gas = isGasBridge(b), out = isOutBridge(b);
  const fromSym = b.fromSym || 'ETH', toSym = b.toSym || (gas ? 'IMX' : 'ETH');
  const chip = (img, name) => `<span class="trade-bchip"><img src="${img}" alt="" width="14" height="14">${esc(name)}</span>`;
  const eth = chip('/img/brands/eth.png', 'Ethereum'), imm = chip('/img/brands/immutable.png', 'Immutable');
  const row = (ic, lbl, val) => `<div class="trade-brow"><span class="trade-brow-ic" aria-hidden="true">${ic}</span><span class="trade-brow-lbl">${esc(lbl)}</span><span class="trade-brow-val">${val}</span></div>`;
  const clock = `<b data-bridge-elapsed>${esc(fmtElapsed(Date.now() - b.startedAt))}</b>`;
  const rows = [];
  if (done) {
    rows.push(row('✓', t('trade.bridge.row.received'), `<span class="trade-brow-to">${esc(fmtBridgeAmt(b.toEth, toSym))}</span>`));
    rows.push(row('⛓', t('trade.bridge.row.on'), out ? eth : imm));
    rows.push(row('◷', t('trade.bridge.row.took'), clock));
  } else {
    if (b.fromEth != null) rows.push(row('↔', t('trade.bridge.row.sendrecv'), `${esc(fmtBridgeAmt(b.fromEth, fromSym))} <span class="trade-brow-sep">→</span> <span class="trade-brow-to">~${esc(fmtBridgeAmt(b.toEth, toSym))}</span>`));
    rows.push(row('⛓', t('trade.bridge.row.route'), out ? `${imm}<span class="trade-brow-sep">→</span>${eth}` : `${eth}<span class="trade-brow-sep">→</span>${imm}`));
    rows.push(row('◷', t('trade.bridge.row.time'), `${clock} ${esc(t('trade.bridge.elapsed'))} <span class="trade-brow-sep">→</span> <span class="trade-brow-to">${esc(ETA_MINS(b))}</span>`));
  }
  return `<div class="trade-brows">${rows.join('')}</div>`;
}
// Step labels for the live stepper — the source/destination pair flips with direction.
function bridgeStepKeys(b) {
  return isOutBridge(b)
    ? ['trade.bridge.step1.out', 'trade.bridge.step2.out', 'trade.bridge.step3']
    : ['trade.bridge.step1', 'trade.bridge.step2', 'trade.bridge.step3'];
}
function bridgeCardHtml(b) {
  const gas = isGasBridge(b), out = isOutBridge(b);
  if (b.phase === 'done') {
    return `<div class="trade-bcard is-ok" role="status" aria-live="polite">
      <div class="trade-bcard-hd"><div class="trade-bcard-badge" aria-hidden="true">✓</div>
        <h4>${esc(t(gas ? 'trade.gas.bridge.done' : out ? 'trade.cashout.move.done' : 'trade.bridge.done'))}</h4>
        ${out ? `<p>${esc(t('trade.cashout.move.doneSub'))}</p>` : ''}</div>
      <div class="trade-bcard-body">${bridgeRowsHtml(b, true)}
        ${out ? `<button class="trade-bcard-btn is-ghost" data-act="add-eth-mainnet" type="button">${esc(t('trade.cashout.move.seeInMM'))}</button>` : ''}
        <button class="trade-bcard-btn" data-act="bridge-dismiss" type="button">${esc(t('trade.bridge.card.done'))}</button>
        <div class="trade-bcard-links">${bridgeLinksHtml(b)}</div></div></div>`;
  }
  if (b.phase === 'error') {
    return `<div class="trade-bcard is-bad" role="alert">
      <div class="trade-bcard-hd"><div class="trade-bcard-badge" aria-hidden="true">!</div>
        <h4>${esc(t('trade.bridge.card.failedH'))}</h4>
        <p>${esc(b.msg || t('trade.bridge.failed'))}</p></div>
      <div class="trade-bcard-body">
        <button class="trade-bcard-btn is-retry" data-act="bridge-dismiss" type="button">${esc(t('trade.bridge.card.retry'))}</button>
        <div class="trade-bcard-links">${bridgeLinksHtml(b)}</div></div></div>`;
  }
  // Live — waiting / slow.
  const idx = { submitted: 0, src_confirmed: 1, bridging: 1, arrived: 2 }[b.stage] ?? 0;
  const fill = idx * (100 / 3); // node centres sit at 1/6, 3/6, 5/6 — fill runs centre-to-centre
  const steps = bridgeStepKeys(b).map((k, i) => {
    const cls = i < idx ? 'is-done' : i === idx ? 'is-active' : '';
    const ic = i < idx ? '✓' : i === idx ? '<span class="trade-mini-spin" aria-hidden="true"></span>' : '·';
    return `<div class="trade-bstep ${cls}"><span class="trade-bstep-dot">${ic}</span><span class="trade-bstep-lbl">${esc(t(k))}</span></div>`;
  }).join('');
  return `<div class="trade-bcard" role="status" aria-live="polite">
    <div class="trade-bcard-hd">
      ${bridgePairHtml(b)}
      <h4>${esc(t(gas ? 'trade.gas.bridgebar.bridging' : out ? 'trade.cashout.move.bridging' : 'trade.bridgebar.bridging'))}</h4>
      <p>${esc(t(gas ? 'trade.gas.card.sub' : out ? 'trade.cashout.move.card.sub' : 'trade.bridge.card.sub'))}</p>
      ${b.phase === 'slow' ? `<span class="trade-bcard-slow">${esc(t('trade.bridgebar.slowTag'))}</span>` : ''}
    </div>
    <div class="trade-bcard-body">
      <div class="trade-bsteps"><span class="trade-bsteps-fill" style="width:${fill}%"></span>${steps}</div>
      ${bridgeRowsHtml(b, false)}
      <div class="trade-bcard-links">${bridgeLinksHtml(b)}</div>
    </div></div>`;
}

// Slim always-visible banner (under the wallet bar) so the bridge stays in view —
// and survives — wherever the user goes. Dismissible once terminal.
function bridgeBannerHtml() {
  const b = bridgeJob;
  if (!b || (!b.hash && !BRIDGE_TERMINAL.has(b.phase))) return '';
  const stepKeys = bridgeStepKeys(b);
  const stageKey = { submitted: stepKeys[0], src_confirmed: stepKeys[1], bridging: stepKeys[1], arrived: stepKeys[2] }[b.stage] || stepKeys[0];
  const dismiss = BRIDGE_TERMINAL.has(b.phase)
    ? `<button class="trade-bridgebar-x" data-act="bridge-dismiss" type="button" aria-label="${esc(t('trade.bridgebar.dismiss'))}">×</button>` : '';
  if (b.phase === 'done') {
    return `<div class="trade-bridgebar is-ok"><span aria-hidden="true">✓</span><span>${esc(t(isGasBridge(b) ? 'trade.gas.bridgebar.done' : isOutBridge(b) ? 'trade.cashout.move.bardone' : 'trade.bridgebar.done'))}</span><span class="trade-bridgebar-links">${bridgeLinksHtml(b)}</span>${dismiss}</div>`;
  }
  if (b.phase === 'error') {
    return `<div class="trade-bridgebar is-bad"><span aria-hidden="true">⚠</span><span>${esc(b.msg || t('trade.bridge.failed'))}</span><span class="trade-bridgebar-links">${bridgeLinksHtml(b)}</span>${dismiss}</div>`;
  }
  const slow = b.phase === 'slow' ? ` ${esc(t('trade.bridgebar.slowTag'))}` : '';
  const coin = sym => sym === 'IMX' ? '/img/brands/imx.png' : '/img/brands/eth.png';
  return `
    <div class="trade-bridgebar" role="status" aria-live="polite">
      <span class="trade-bbar-pair" aria-hidden="true">
        <img src="${coin(b.fromSym || 'ETH')}" alt="" width="20" height="20">
        <img src="${coin(b.toSym || (isGasBridge(b) ? 'IMX' : 'ETH'))}" alt="" width="20" height="20">
      </span>
      <span class="trade-bbar-txt">${esc(t(isGasBridge(b) ? 'trade.gas.bridgebar.bridging' : isOutBridge(b) ? 'trade.cashout.move.bridging' : 'trade.bridgebar.bridging'))} — ${esc(t(stageKey))}${slow}</span>
      <span class="trade-bbar-bar" aria-hidden="true"><i data-bridge-bar></i></span>
      <span class="trade-bbar-time"><b data-bridge-elapsed>${esc(fmtElapsed(Date.now() - b.startedAt))}</b>${b.mins ? ` / ~${esc(String(b.mins))} min` : ''}</span>
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
  // waiting/slow/done/error render as the full card; the brief switch/approve/confirm/back
  // phases (before a tx hash exists) stay a small inline status line under the quote.
  if (CARD_PHASES.has(b.phase)) return bridgeCardHtml(b);
  const STEP = isOutBridge(b)
    ? { switch: 'trade.cashout.move.switch', approve: 'trade.cashout.move.approve', confirm: 'trade.cashout.move.confirm' }
    : { switch: 'trade.bridge.switch', confirm: 'trade.bridge.confirm', back: 'trade.bridge.back' };
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP[b.phase]))}</span></div>`;
}

function setBridgeJob(patchFields) {
  bridgeJob = { ...bridgeJob, ...patchFields };
  saveBridge();
  patchModal();
  patchBridgeBanner();
  patchGas(); // keep the inline Sell/Transfer gas panels in step with the bridge
  patchCashout(); // and the cash-out modal's move screen / tracker card
  patchTopup(); // and the Add-funds modal
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
// and gets its own copy. kind defaults to 'eth' for older persisted jobs. A cash-out is
// the reverse direction entirely (zkEVM ETH → mainnet ETH).
const isGasBridge = b => (b || bridgeJob)?.kind === 'gas';
const isCashout = b => (b || bridgeJob)?.kind === 'cashout';

// One server-side status read for a job (fresh Squid signal, not the wallet's cached balance).
// Timed out so it can't hang the caller; returns the parsed payload or null.
async function fetchBridgeStatus(job) {
  try {
    const dir = job.dir === 'out' ? '&dir=out' : '';
    const r = await fetch(`/api/market/creatures/bridge/status?tx=${job.hash}&quoteId=${encodeURIComponent(job.quoteId || '')}&requestId=${encodeURIComponent(job.requestId || '')}${dir}`, { signal: AbortSignal.timeout(9000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
// Apply a status payload to the active job. Returns true when the bridge is resolved (done /
// error) or the job is no longer active — i.e. the tracking loop should stop.
function applyBridgeStatus(job, s) {
  if (bridgeJob !== job || job.phase !== 'waiting') return true; // superseded — stop tracking
  if (s.stage === 'failed' || s.stage === 'failed_src') { setBridgeJob({ phase: 'error', msg: t('trade.bridge.failed'), axelarUrl: s.axelarUrl || job.axelarUrl }); return true; }
  if (s.stage === 'needs_gas') { setBridgeJob({ phase: 'error', msg: t('trade.bridge.needsGas'), axelarUrl: s.axelarUrl || job.axelarUrl }); return true; }
  // Squid reports the funds have landed on zkEVM — complete NOW rather than waiting on the
  // wallet balance read, which the injected provider can serve stale after the chain switch
  // (the old bug: tracker never flipped to done until a reload).
  if (s.stage === 'arrived') { setBridgeJob({ phase: 'done', stage: 'arrived', axelarUrl: s.axelarUrl || job.axelarUrl }); return true; }
  if (s.stage !== job.stage || (s.axelarUrl && s.axelarUrl !== job.axelarUrl)) setBridgeJob({ stage: s.stage, axelarUrl: s.axelarUrl || job.axelarUrl });
  return false;
}

// Background tabs get their timers throttled to ~once a minute, so while the user watches the
// bridge on Axelarscan the poll loop below is asleep. Kick one immediate status check the
// moment they return, so the tracker resolves on focus instead of up to a minute later.
let bridgeVisibilityWired = false;
function wireBridgeVisibility() {
  if (bridgeVisibilityWired || typeof document === 'undefined') return;
  bridgeVisibilityWired = true;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const job = bridgeJob;
    if (!job?.hash || job.phase !== 'waiting') return;
    const s = await fetchBridgeStatus(job);
    if (s) applyBridgeStatus(job, s);
  });
}

// The tracking loop — independent of any screen. Resumable: runs off bridgeJob alone,
// so it works identically right after sending and after a page reload mid-bridge.
async function trackBridge() {
  const job = bridgeJob;
  if (!job?.hash) return;
  startBridgeTicker();
  wireBridgeVisibility();
  const needWei = BigInt(job.needWei);
  // Wait ≥25 min (or 2× ETA) from when the bridge STARTED, with a 10-min floor from
  // now so a just-resumed old job still gets a fair polling window.
  const deadline = Math.max(job.startedAt + Math.max(25 * 60 * 1000, (job.mins || 0) * 120000), Date.now() + 10 * 60 * 1000);
  let tick = 0;
  // A read through the wallet provider can HANG indefinitely (zkEVM RPC slow/unresponsive, or
  // the tab backgrounded) — that must never stall the loop, or the reliable server-side status
  // poll never runs and the tracker sticks until a reload (the reported bug). So cap every
  // wallet read, and poll status FIRST.
  const readWithTimeout = (p, ms) => Promise.race([Promise.resolve(p).catch(() => null), new Promise(res => setTimeout(() => res(null), ms))]);
  while (Date.now() < deadline) {
    if (bridgeJob !== job || job.phase !== 'waiting') return;
    // PRIMARY signal — server-side Squid status. Every ~20s, and BEFORE the wallet read so a
    // slow read can't keep it from ever running.
    if (tick % 2 === 0) {
      const s = await fetchBridgeStatus(job);
      if (s && applyBridgeStatus(job, s)) return;
      if (bridgeJob !== job || job.phase !== 'waiting') return;
    }
    // SECONDARY signal — the balance actually crediting (covers the rare case Squid's status
    // lags the chain). Capped so a hung provider read can't freeze the loop. Not for
    // cash-outs: their destination balance lives on Ethereum mainnet, which the wallet
    // (sitting on zkEVM) can't read — Squid's status is the only signal there.
    if (job.dir !== 'out' && needWei > 0n) {
      const read = isGasBridge(job) ? readNative(job.account) : readErc20(IMX_ETH_TOKEN, job.account);
      const bal = await readWithTimeout(read, 9000);
      if (bal != null && bal >= needWei) return setBridgeJob({ phase: 'done', stage: 'arrived' });
    }
    tick++;
    await new Promise(r => setTimeout(r, 10000));
  }
  if (bridgeJob === job && job.phase === 'waiting') setBridgeJob({ phase: 'slow' });
}

// Send the prepared Squid bridge tx, then hand off to the resumable tracker. Shared by
// the ETH price bridge (Buy) and the IMX gas top-up (Buy/Sell/Transfer); `kind` and the
// arrival target `needWei` are all that differ.
async function runBridge(q, { kind, needWei, fromSym = 'ETH', toSym = 'ETH' }) {
  if (!q || q === 'loading' || !q.tx) return;
  if (bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase)) return; // one bridge at a time
  try {
    bridgeJob = { phase: 'switch', account, mins: null, startedAt: Date.now(), kind, fromSym, toSym, fromEth: q.fromEth, toEth: q.toEth };
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
      fromSym, toSym, fromEth: q.fromEth, toEth: q.toEth,
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
  return runBridge(gasState?.quote, { kind: 'gas', needWei, fromSym: gasState?.from === 'imx' ? 'IMX' : 'ETH', toSym: 'IMX' });
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
  const isUsdc = it.currency === 'usdc';
  try {
    setBuy('prepare');
    // Switch to mainnet first so the pre-flight reads the AUTHORITATIVE balance straight
    // from the wallet — the exact figure MetaMask shows and uses to fund the tx. A
    // third-party RPC (e.g. Blockscout) can lag a recent top-up and wrongly block a funded
    // buyer; the wallet's own read never does. null = read failed → let it through
    // (the wallet still guards at signing).
    await switchToChain('0x1');
    if (isUsdc) {
      // USDC listing: the price is paid in mainnet USDC (6 decimals); only gas is native ETH.
      // Check the USDC balance and keep a small ETH cushion for the approval + fulfil gas.
      // (A USDC buyer on-ramp is a follow-up — a buyer must already hold USDC on Ethereum.)
      const [usdcBal, ethBal] = await Promise.all([readErc20(USDC_MAINNET_TOKEN, account), readNative(account)]);
      const needUnits = BigInt(Math.round((it.totalAmt ?? it.priceAmt ?? 0) * 1e6));
      if (usdcBal != null && usdcBal < needUnits) { setBuy('error', { msg: t('trade.err.needUsdcLand').replace('{x}', fmtListingAmt(it)), onramp: { chain: 'ethereum', token: 'USDC', fiat: onrampFiatUsd(Math.max(1, (it.totalAmt ?? it.priceAmt ?? 0) - Number(usdcBal) / 1e6)) } }); return; }
      if (ethBal != null && ethBal < 3n * 10n ** 15n) { // < ~0.003 ETH → can't cover mainnet gas
        setBuy('error', { msg: t('trade.err.landGas'), onramp: { chain: 'ethereum', token: 'ETH', fiat: onrampFiatUsd(0.01) } });
        return;
      }
    } else {
      const needWei = BigInt(Math.round((it.totalEth ?? it.priceEth) * 1e6)) * 10n ** 12n + 10n ** 16n; // +0.01 ETH gas cushion
      const balWei = await readNative(account);
      if (balWei != null && balWei < needWei) {
        // Short on mainnet ETH — offer a card on-ramp that delivers ETH straight to Ethereum
        // (Transak, if configured). Minted on click; stash the shortfall (in USD) to prefill.
        const shortEth = Number(needWei - balWei) / 1e18;
        setBuy('error', { msg: t('trade.err.landFunds').replace('{x}', fmtEth(Number(needWei) / 1e18)).replace('{y}', fmtEth(Number(balWei) / 1e18)), onramp: { chain: 'ethereum', token: 'ETH', fiat: onrampFiatUsd(shortEth) } });
        return;
      }
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

    // A USDC buy carries a one-time conduit approval BEFORE the fulfilment (native ETH buys are
    // a single tx). Approve first (no pre-flight simulate — a plain ERC-20 approve won't revert),
    // then simulate + send the fulfilment.
    for (const tx of (data.transactions || [])) {
      const isApproval = tx.purpose === 'APPROVAL';
      if (isApproval) {
        setBuy('approve');
        const ah = await eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to: tx.to, data: tx.data, value: undefined }] });
        setBuy('approveWait', { hash: ah });
        const ar = await waitForReceipt(ah);
        if (!ar || ar.status !== '0x1') { setBuy('error', { msg: t(skey('trade.err.txFailed')) }); return; }
        continue;
      }
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
      notePendingOwned(it); // show it in Sell/Transfer NOW — OpenSea's owner index lags a buy by minutes
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
    // Currency-aware: a USDC listing is paid in USDC (6 decimals), not ETH — so check the
    // USDC balance and skip the ETH bridge helper (a USDC buyer on-ramp is a follow-up).
    if (it.currency === 'usdc') {
      const [usdcBal, imxBal] = await Promise.all([readErc20(IMX_USDC_TOKEN, account), readNative(account)]);
      const need = it.totalAmt ?? it.priceAmt ?? 0;
      const needUnits = BigInt(Math.round(need * 1e6));
      // Short on USDC → offer a card on-ramp that delivers USDC to zkEVM (if Transak lists it),
      // prefilled with the shortfall in dollars.
      if (usdcBal != null && usdcBal < needUnits) { setBuy('error', { msg: t('trade.err.needUsdc').replace('{x}', fmtListingAmt(it)), onramp: { chain: 'zkevm', token: 'USDC', fiat: onrampFiatUsd(Math.max(1, need - Number(usdcBal) / 1e6)) } }); return; }
      if (imxBal != null && imxBal < GAS_MIN_WEI) { setBuy('gas'); showGasHelp('buy'); return; }
    } else {
      const [zkEthBal, imxBal] = await Promise.all([readErc20(IMX_ETH_TOKEN, account), readNative(account)]);
      const needWei = BigInt(Math.round((it.totalEth ?? it.priceEth) * 1e6)) * 10n ** 12n;
      if (zkEthBal != null && zkEthBal < needWei) { await showFundsHelp(it); return; }
      // Has the ETH but no gas — the exact wall in the Discord report. Same guided IMX
      // top-up the Sell/Transfer flows now use, instead of a terse "add some IMX".
      if (imxBal != null && imxBal < GAS_MIN_WEI) { setBuy('gas'); showGasHelp('buy'); return; }
    }

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
          notePendingOwned(it); // show it in Sell/Transfer NOW — the owner index lags a buy
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
// After a cash-out lands: flip MetaMask to Ethereum so the arrived ETH is immediately
// visible — "where did my money go?" is the #1 post-bridge panic, and native mainnet ETH
// needs no watchAsset, just the right network selected.
async function showEthOnMainnet() {
  if (!eth()) return;
  try {
    await switchToChain('0x1');
    render();
  } catch (err) { if (err?.code !== 4001) console.error('mainnet switch failed:', err.message); }
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
        dropPendingOwned(tokenId); // if it was a fresh buy, don't let the optimistic copy resurrect it
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
                <span class="trade-offer-price ${o.currency === 'usdc' ? 'is-usdc' : ''}">${esc(fmtOfferLine(o))}</span>
                <span class="trade-offer-meta">${esc(t('trade.offers.net').replace('{x}', fmtOfferNetLine(o)))} · ${esc(t('trade.offers.from'))} <code>${esc(shortWallet(o.from))}</code></span>
              </div>
              ${isOwner ? `<button class="trade-offer-accept" data-act="accept-offer" data-offer="${esc(o.offerId)}" type="button" ${acceptBusyId ? 'disabled' : ''}>${esc(acceptBusyId === o.offerId ? t('trade.accept.busy') : t('trade.offers.accept'))}</button>` : ''}
            </li>`).join('')}</ul>`
        : `<p class="trade-offers-none">${esc(t('trade.offers.none'))}</p>`);

  const makeBusy = offerState && OFFER_BUSY.has(offerState.phase);
  normOfferUnit();
  const isUsdcOffer = offerCurrency === 'usdc';
  const offerPh = isUsdcOffer ? '250' : (offerUnit === 'eth' ? t('trade.offers.make.ph') : t('trade.offers.make.phFiat'));
  const makeForm = !isOwner && account && onZk()
    ? `<form class="trade-offer-form" id="trade-offer-form" data-token="${esc(modalToken)}" novalidate>
        ${offerCurrencyPickerHtml()}
        <input id="trade-offer-price" type="text" inputmode="decimal" placeholder="${esc(offerPh)}" autocomplete="off" />
        ${isUsdcOffer
          ? `<span class="trade-price-unit trade-cur-fixed">USDC</span>`
          : `<select id="trade-offer-unit" class="seg-select trade-offer-unit" aria-label="${esc(t('trade.sell.unitAria'))}" ${fiatReady() ? '' : 'disabled'}>${offerUnitOptions()}</select>`}
        <button class="trade-offer-btn" type="submit" ${makeBusy ? 'disabled' : ''}>${esc(t('trade.offers.make.btn'))}</button>
        <span class="trade-offer-conv" id="trade-offer-conv">${esc(isUsdcOffer ? '' : offerConvHtml(''))}</span>
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
            ${esc(o.collection ? t('trade.coll.chipAny') : `#…${String(o.tokenId).slice(-4)}`)} · <span class="${o.currency === 'usdc' ? 'is-usdc' : ''}">${esc(fmtOfferLine(o))}</span>
            <button data-act="cancel-offer" data-offer="${esc(o.offerId)}" type="button" aria-label="${esc(t('trade.coll.cancel'))}" ${acceptBusyId ? 'disabled' : ''}>×</button>
          </span>`).join('')}
      </div>`
    : '';
  const isUsdcOffer = offerCurrency === 'usdc';
  return `
    <div class="trade-colloffer" id="trade-colloffer">
      <div class="trade-colloffer-row">
        <div class="trade-colloffer-info">
          <span class="trade-colloffer-label">${esc(t('trade.coll.top'))} ${tipHtml('trade.coll.make.p')}</span>
          <span class="trade-colloffer-price ${top?.currency === 'usdc' ? 'is-usdc' : ''}">${top ? esc(fmtOfferLine(top)) : esc(t(collOffersError ? 'trade.coll.loadErr' : 'trade.coll.none'))}</span>
        </div>
        ${account && onZk() ? `
          <form class="trade-offer-form is-inline" id="trade-coll-offer-form" novalidate>
            ${offerCurrencyPickerHtml()}
            <input id="trade-coll-offer-price" type="text" inputmode="decimal" placeholder="${esc(isUsdcOffer ? '250' : (offerUnit === 'eth' ? t('trade.offers.make.ph') : t('trade.offers.make.phFiat')))}" autocomplete="off" />
            ${isUsdcOffer
              ? `<span class="trade-price-unit trade-cur-fixed">USDC</span>`
              : `<select id="trade-coll-offer-unit" class="seg-select trade-offer-unit" aria-label="${esc(t('trade.sell.unitAria'))}" ${fiatReady() ? '' : 'disabled'}>${offerUnitOptions()}</select>`}
            <button class="trade-offer-btn" type="submit" ${makeBusy ? 'disabled' : ''}>${esc(t('trade.coll.make.btn'))}</button>
            <span class="trade-offer-conv" id="trade-coll-offer-conv">${esc(isUsdcOffer ? '' : offerConvHtml(''))}</span>
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
            ${esc(t('trade.coll.chipAny'))} · <span class="${o.currency === 'usdc' ? 'is-usdc' : ''}">${esc(fmtOfferLine(o))}</span>
            <button data-act="cancel-land-offer" data-offer="${esc(o.offerId)}" type="button" aria-label="${esc(t('trade.coll.cancel'))}" ${cancelBusy ? 'disabled' : ''}>×</button>
          </span>`).join('')}
      </div>`
    : '';
  const isUsdcOffer = offerCurrency === 'usdc';
  return `
    <div class="trade-colloffer" id="trade-landoffer">
      <div class="trade-colloffer-row">
        <div class="trade-colloffer-info">
          <span class="trade-colloffer-label">${esc(t('trade.landoffer.top'))} ${tipHtml('trade.landoffer.tip')}</span>
          <span class="trade-colloffer-price ${top?.currency === 'usdc' ? 'is-usdc' : ''}">${top ? esc(fmtOfferLine(top)) : esc(t(landCollOffersError ? 'trade.coll.loadErr' : 'trade.coll.none'))}</span>
        </div>
        ${account ? `
          <form class="trade-offer-form is-inline" id="trade-land-offer-form" novalidate>
            ${offerCurrencyPickerHtml()}
            <input id="trade-land-offer-price" type="text" inputmode="decimal" placeholder="${esc(isUsdcOffer ? '250' : t('trade.offers.make.ph'))}" autocomplete="off" />
            ${isUsdcOffer ? `<span class="trade-price-unit trade-cur-fixed">USDC</span>` : ''}
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
    if (String(sellSel) === String(tokenId)) { sellPickOffers = offers; patchSellInstant(); }
  } catch { if (String(sellSel) === String(tokenId)) { sellPickOffers = []; patchSellInstant(); } }
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
  // Resolve the typed price to {currency, price}: USDC in dollars, ETH via the unit conversion.
  const pay = offerPricePayload(priceRaw);
  if (!pay.ok) return setOffer('error', { msg: pay.msg });
  const price = pay.price;

  try {
    setOffer('prepare');

    // Pre-flight FIRST: an offer must be BACKED by the offer currency (the SDK refuses to create
    // a bid the maker can't currently cover — that rejection surfaced as a misleading "Buying is
    // temporarily unavailable"). A USDC offer needs USDC (6 dec); an ETH offer needs zkEVM ETH —
    // on an ETH shortfall we open the warm funds panel (they may hold it on mainnet); a USDC
    // shortfall shows a plain "top up USDC" (a USDC on-ramp is a separate follow-up).
    if (pay.currency === 'usdc') {
      const usdcBal = await readErc20(IMX_USDC_TOKEN, account);
      const needUnits = BigInt(Math.round(Number(price) * 1e6));
      if (usdcBal != null && usdcBal < needUnits) return setOffer('error', { msg: t('trade.err.needUsdc').replace('{x}', `${price} USDC`) });
    } else {
      const zkEthBal = await readErc20(IMX_ETH_TOKEN, account);
      const needWei = BigInt(Math.round(Number(price) * 1e6)) * 10n ** 12n;
      if (zkEthBal != null && zkEthBal < needWei) return showOfferFundsHelp(Number(price), ctx);
    }

    const res = await fetch('/api/market/creatures/offer/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, currency: pay.currency, price, ...(tokenId != null ? { tokenId } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    // Server-confirmed shortfall (e.g. balance moved between the check above and prepare) —
    // route to the same funds panel rather than the bare insufficient-funds text.
    if (!res.ok) {
      if (data.error === 'insufficient') return pay.currency === 'usdc' ? setOffer('error', { msg: t('trade.err.needUsdc').replace('{x}', `${price} USDC`) }) : showOfferFundsHelp(Number(price), ctx);
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
  const pay = offerPricePayload(priceRaw);
  if (!pay.ok) return setLandOffer('error', { msg: pay.msg });
  const price = pay.price;
  try {
    await switchToChain('0x1'); // offers settle on Ethereum mainnet
    setLandOffer('prepare');
    const res = await fetch('/api/market/land/offer/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, currency: pay.currency, price }),
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
          if (fillToken != null) dropPendingOwned(fillToken); // fresh buy sold straight into a bid — don't resurrect it
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
  // Seed from the last-known values so a re-render doesn't flash '—' while the async
  // reads run; refreshBalance() overwrites (and re-caches) right after.
  const seed = balCache.get(`${account}|${coll}`) || {};
  const bal = coll === 'land'
    ? `<span class="trade-bar-bal" title="${esc(t('trade.balance.landLabel'))}"><img class="trade-bal-ico" src="${COLL_ICONS.land}" alt="" aria-hidden="true" /> <b id="trade-bal">${esc(seed.count ?? '—')}</b></span>
       <span class="trade-bar-bal">ETH <b id="trade-bal-eth">${esc(seed.eth ?? '—')}</b></span>`
    : (onZk()
        ? `<span class="trade-bar-bal" title="${esc(t('trade.balance.label'))}"><img class="trade-bal-ico" src="${COLL_ICONS.creatures}" alt="" aria-hidden="true" /> <b id="trade-bal">${esc(seed.count ?? '—')}</b></span>
           <span class="trade-bar-bal">ETH <b id="trade-bal-eth">${esc(seed.eth ?? '—')}</b></span>
           <span class="trade-bar-bal">IMX <b id="trade-bal-imx">${esc(seed.imx ?? '—')}</b></span>`
        : '');
  return `<div class="trade-bar is-connected">
    <img class="trade-mm-dot" src="${METAMASK_IMG}" alt="" />
    <code class="trade-addr" title="${esc(account)}">${esc(shortWallet(account))}</code>
    <button class="trade-switch" data-act="switch-account" type="button" ${busy ? 'disabled' : ''}
      title="${esc(t('trade.switch.title'))}" aria-label="${esc(t('trade.switch.title'))}">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/></svg>
    </button>
    ${net}${bal ? `<span class="trade-bar-bals">${bal}</span>` : ''}
    ${coll === 'creatures' && onZk() ? `<button class="trade-cashout-pill trade-topup-pill" data-act="topup-open" type="button" title="${esc(t('trade.topup.barTitle'))}"><span aria-hidden="true">💎</span> ${esc(t('trade.topup.barBtn'))}</button>` : ''}
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
  const f = (curFacets() || []).find(x => /rarity/i.test(x.type));
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
    const n = curFacets() ? (counts.get(tier) ?? 0) : null;
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
  return (curFacets() || []).find(x => x.type === 'Tier') || null;
}
function tierChipsHtml() {
  const vals = new Map((tierFacet()?.values || []).map(o => [o.v, o]));
  return TIER_VALUES.map(name => {
    const o = vals.get(name);
    const sel = traitSelected('Tier', name);
    const n = curFacets() ? (o?.n ?? 0) : null; // unknown before first response → enabled
    // Collection browse shows each tier's collection-wide rarity %; wallet/profile
    // views have no % (facets are per-holder) — show the holder's plot COUNT instead.
    const tag = (o ? fmtTraitPct(o.pct) : '') || (n != null ? String(n) : '');
    return `<button type="button" class="trade-flt-rchip ${sel ? 'is-on' : ''}" data-tier="${esc(name.toLowerCase())}"
      data-act="flt-val" data-type="Tier" data-val="${esc(name)}" aria-pressed="${sel}" ${n === 0 && !sel ? 'disabled' : ''}>
      <span class="trade-flt-rdot" aria-hidden="true"></span>${esc(name)}${tag ? `<span class="trade-flt-n">${esc(tag)}</span>` : ''}
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
  if (!curFacets()) return `<span class="trade-flt-loading">${esc(t('trade.filter.loading'))}</span>`;
  // 'Tier' is rendered as its own chip group (see tierChipsHtml), so keep it out here.
  return curFacets().filter(f => !/rarity/i.test(f.type) && f.type !== 'Tier').map(f => {
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

// Filters that narrow WITHIN a wallet's holdings (the address itself isn't one of them).
function extraFiltersActive() {
  return !!(flt.min || flt.max || flt.traits.size);
}

function countLineHtml() {
  // Everything here is response-time state (browse*) — mixing in live flt state mid-
  // fetch produced nonsense like "103 in the collection". Dim it while a fetch runs.
  if (tradeTab === 'sales') return salesCountHtml();
  const ds = browseDataset();
  if (browseOwner || browseOwnerProfile) {
    if (browseTotal == null || browseOwnedTotal == null) return '';
    const key = extraFiltersActive() ? 'trade.wallet.countFiltered' : 'trade.wallet.count';
    return `<span class="trade-flt-count ${listingsLoading ? 'is-stale' : ''}" role="status">${esc(t(key)
      .replace('{n}', browseTotal.toLocaleString()).replace('{total}', browseOwnedTotal.toLocaleString()))}</span>`;
  }
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
  // A wallet address (or a matched profile username) isn't a text filter — the owner
  // banner represents it instead.
  if (flt.q && !isWalletQuery(flt.q) && !browseOwnerProfile) chips.push({ k: 'q', label: `“${flt.q}”` });
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

// The "you're looking at one wallet's holdings" banner — shown whenever a wallet address
// resolved. Carries the count, the (copyable) address, and a one-tap way back to browsing.
function walletBannerHtml() {
  // Profile-username match: show whose collection this is + a link to their full profile.
  if (browseOwnerProfile) {
    const noun = t(coll === 'land' ? 'trade.wallet.nounLand' : 'trade.wallet.noun');
    const n = (browseOwnedTotal ?? 0).toLocaleString();
    return `<div class="trade-wallet-banner is-profile" role="status">
      <svg class="trade-wallet-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/>
        <path d="M4 20c1.4-3.6 4.4-5.5 8-5.5s6.6 1.9 8 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <span class="trade-wallet-txt">${esc(t('trade.profileSearch.showing').replace('{name}', browseOwnerProfile.name).replace('{n}', n).replace('{noun}', noun))}</span>
      <button type="button" class="trade-wallet-addr trade-profile-link" data-act="open-profile" data-slug="${esc(browseOwnerProfile.slug)}">${esc(t('trade.profileSearch.view'))}</button>
      <button type="button" class="trade-wallet-clear" data-act="flt-rm" data-kind="q">${esc(t('trade.wallet.clear'))}</button>
    </div>`;
  }
  if (!browseOwner) return '';
  const noun = t(coll === 'land' ? 'trade.wallet.nounLand' : 'trade.wallet.noun');
  const n = (browseOwnedTotal ?? 0).toLocaleString();
  return `<div class="trade-wallet-banner" role="status">
    <svg class="trade-wallet-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <rect x="3" y="6" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/>
      <path d="M3 9h13a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H3" fill="none" stroke="currentColor" stroke-width="2"/>
      <circle cx="16.5" cy="12.5" r="1.3" fill="currentColor"/>
    </svg>
    <span class="trade-wallet-txt">${esc(t('trade.wallet.showing').replace('{n}', n).replace('{noun}', noun))}</span>
    <span class="trade-wallet-addr">${esc(shortWallet(browseOwner))}${copyBtnHtml(browseOwner, 'trade.wallet.copyAria')}</span>
    <button type="button" class="trade-wallet-clear" data-act="flt-rm" data-kind="q">${esc(t('trade.wallet.clear'))}</button>
  </div>`;
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
  const wb  = r.querySelector('#trade-wallet-slot'); if (wb) wb.innerHTML = walletBannerHtml();
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
      <div id="trade-wallet-slot">${walletBannerHtml()}</div>
      ${coll === 'creatures' ? collStripHtml() : landOfferStripHtml()}
      <div class="trade-grid" id="trade-grid">${gridInnerHtml()}</div>
      <div class="trade-loadmore" id="trade-loadmore">${loadMoreHtml()}</div>
    </div>
  </section>`;
}

// --- Sales History (collection-wide completed sales, shares the Browse filter bar) --------
// The Buy tab shows what sellers ASK; this shows what buyers PAID — real comparables for
// price discovery. It reuses `flt` (search / price / traits carry straight over from Browse)
// plus its own time-ordered sort, and renders the same filter sidebar so tweaking a filter
// here narrows the sold set exactly as it narrows the listings next door.

// Wire format mirrors browseQuery, minus scope (a sale is a sale) and with the sales sort.
function salesQuery(page) {
  const p = new URLSearchParams();
  if (flt.q) p.set('q', flt.q);
  if (flt.min) p.set('min', flt.min);
  if (flt.max) p.set('max', flt.max);
  for (const [type, vals] of flt.traits) for (const v of vals) p.append('t', `${type}:${v}`);
  if (salesSort !== 'recent') p.set('sort', salesSort);
  if (page) p.set('page', String(page));
  return p.toString();
}

async function loadSales(reset = true) {
  if (!reset && (!salesHasMore || salesLoading)) return;
  const page = reset ? 0 : salesPage + 1;
  if (reset) salesError = false; // keep any current rows on screen through a filter reload (no flash)
  const rid = ++salesReqId;
  const startColl = coll;
  const api = `/api/market/${coll === 'land' ? 'land' : 'creatures'}/sales`;
  salesLoading = true;
  patchSalesGrid(); patchFilters();
  try {
    const qs = salesQuery(page);
    const res = await fetch(`${api}${qs ? '?' + qs : ''}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    if (rid !== salesReqId || coll !== startColl) return; // superseded by a newer request / view
    if (data.ethUsd != null) ethUsd = data.ethUsd;
    if (data.fxRates) fxRates = data.fxRates;
    const items = data.items || [];
    salesItems = reset ? items : (salesItems || []).concat(items);
    salesPage = data.page ?? page;
    salesHasMore = !!data.hasMore;
    salesTotal = data.total ?? null;
    if (data.facets) salesFacets = data.facets;
  } catch (err) {
    if (rid !== salesReqId) return;
    console.error('Sales history load failed:', err);
    if (reset) { salesItems = salesItems || []; salesError = true; }
  } finally {
    if (rid === salesReqId) { salesLoading = false; patchSalesGrid(); patchFilters(); }
  }
}
function maybeLoadSales() {
  if (salesItems === null && !salesLoading) loadSales(true);
}

// Toolbar above the sold list: search + a time-ordered sort + the mobile Filters toggle.
// No "On sale / All" scope — every row here is a completed sale.
function salesToolbarHtml() {
  const sorts = [['recent', 'sortRecent'], ['oldest', 'sortOldest'], ['price-desc', 'sortPriceDesc'], ['price-asc', 'sortPriceAsc']];
  return `
  <div class="trade-toolbar">
    <label class="trade-flt-search">
      <svg class="trade-flt-sico" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M16.5 16.5L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input id="flt-q" type="search" autocomplete="off" enterkeyhint="search" placeholder="${esc(t('trade.filter.search'))}" value="${esc(flt.q)}" aria-label="${esc(t('trade.filter.search'))}" />
    </label>
    <select id="sales-sort" class="seg-select trade-flt-sort" aria-label="${esc(t('trade.sales.sortAria'))}">
      ${sorts.map(([v, k]) => `<option value="${v}" ${salesSort === v ? 'selected' : ''}>${esc(t('trade.filter.' + k))}</option>`).join('')}
    </select>
    <button type="button" class="apply-btn-ghost trade-flt-toggle" data-act="flt-drawer" aria-expanded="${fltOpenMobile}" aria-controls="trade-side">
      ${esc(t('trade.filter.toggle'))}${fltCount() ? `<span class="trade-flt-badge">${fltCount()}</span>` : ''}
    </button>
  </div>
  <div class="trade-flt-active" id="flt-active">${activeChipsHtml()}</div>`;
}

// "142 recent sales" / "18 sales match" — response-time state, dimmed mid-fetch.
function salesCountHtml() {
  if (salesTotal == null) return '';
  const key = fltActive() ? 'trade.sales.countFiltered' : 'trade.sales.count';
  return `<span class="trade-flt-count ${salesLoading ? 'is-stale' : ''}" role="status">${esc(t(key).replace('{n}', salesTotal.toLocaleString()))}</span>`;
}

function salesHtml() {
  return `<section class="trade-browse has-side">
    ${filterSideHtml()}
    <div class="trade-main">
      <div class="trade-results-head">
        <h3 class="trade-browse-h">${esc(t('trade.sales.h'))} ${tipHtml(coll === 'land' ? 'trade.sales.subLand' : 'trade.sales.sub')}</h3>
        <div class="trade-browse-actions">
          <select class="seg-select trade-currency" id="trade-currency" aria-label="${esc(t('trade.currency.aria'))}">
            ${CURRENCIES.map(c => `<option value="${c}" ${currency === c ? 'selected' : ''}>${c.toUpperCase()}</option>`).join('')}
          </select>
          <button class="apply-btn-ghost trade-refresh" data-act="sales-refresh" type="button">${esc(t('trade.refresh'))}</button>
        </div>
      </div>
      ${salesToolbarHtml()}
      <div class="trade-sales" id="trade-sales-grid">${salesGridInnerHtml()}</div>
      <div class="trade-loadmore" id="trade-sales-loadmore">${salesLoadMoreHtml()}</div>
    </div>
  </section>`;
}

// "Jun 12, 2026" for the sale date, in the user's locale.
function fmtSaleDate(iso) {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  try { return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return ''; }
}

// The asset's type line: "Creature" / "LAND", with the plot tier or rarity tier when known.
function saleTypeLabel(s) {
  if (coll === 'land') {
    const tier = s.traits && (s.traits.Tier || s.traits.tier);
    return tier ? `${t('trade.sales.typeLand')} · ${tier}` : t('trade.sales.typeLand');
  }
  return t('trade.sales.typeCreature');
}

// Up to three notable traits as chips (rarity/tier are shown separately as the badge), so a
// comparable's defining features read at a glance without opening anything.
function saleTraitChips(s) {
  const traits = s.traits || {};
  const chips = Object.entries(traits)
    .filter(([k, v]) => !/rarity/i.test(k) && k !== 'Tier' && v && !/^none$/i.test(v))
    .slice(0, 3)
    .map(([, v]) => `<span class="trade-sale-trait">${esc(v)}</span>`);
  return chips.length ? `<div class="trade-sale-traits">${chips.join('')}</div>` : '';
}

function saleCardHtml(s, i = 0) {
  const pet = coll === 'land' ? petUrl(s) : null;
  const src = pet || s.image;
  const fallback = pet && s.image ? ` data-fallback="${esc(s.image)}"` : '';
  const img = src
    ? `<img class="trade-sale-img ${pet ? 'is-pet' : ''}" src="${esc(src)}"${fallback} alt="" loading="lazy" />`
    : `<div class="trade-sale-img trade-tile-noimg" aria-hidden="true">${coll === 'land' ? '🗺️' : '🐾'}</div>`;
  const fiat = fmtSaleFiat(s.priceUsd);
  const when = esc(fmtSaleDate(s.at));
  const listed = s.listedNow != null;
  // Open the asset inside OUR marketplace (buy modal if it's currently listed, detail +
  // make-offer if not). knownListed skips the "brand-new listing, syncing…" hunt when unlisted.
  const openAttrs = `data-act="sale-open" data-token="${esc(s.tokenId)}" data-listed="${listed ? '1' : '0'}"`;
  const wallets = [];
  if (s.seller) wallets.push(`<span class="trade-sale-party"><span class="trade-sale-party-k">${esc(t('trade.sales.seller'))}</span><code>${esc(shortWallet(s.seller))}</code></span>`);
  if (s.buyer) wallets.push(`<span class="trade-sale-party"><span class="trade-sale-party-k">${esc(t('trade.sales.buyer'))}</span><code>${esc(shortWallet(s.buyer))}</code></span>`);
  const txLink = s.tx
    ? `<a href="${esc(txExplorerUrl(s.tx))}" target="_blank" rel="noopener" class="trade-sale-link">${esc(t('trade.sales.tx'))} ↗</a>` : '';
  const assetLink = `<a href="${esc(tokenExplorerUrl(s.tokenId))}" target="_blank" rel="noopener" class="trade-sale-link">${esc(t('trade.sales.asset'))} ↗</a>`;
  const viewBtn = `<button type="button" class="trade-sale-link is-view" ${openAttrs}>${esc(t('trade.sales.view'))}</button>`;
  // Status: currently for sale (with its live all-in price) or not listed. Doubles as the
  // rank/rarity tag row so nothing collides in the little thumbnail corner.
  const status = listed
    ? `<span class="trade-sale-status is-listed">${esc(t('trade.sales.forSale'))} · ${esc(fmtEth(s.listedNow))}</span>`
    : `<span class="trade-sale-status is-unlisted">${esc(t('trade.sales.notListed'))}</span>`;
  const delay = Math.min(i * 35, 350);
  return `
    <article class="trade-sale-card" style="animation-delay:${delay}ms">
      <button type="button" class="trade-sale-media" ${openAttrs} aria-label="${esc(t('trade.sales.view'))}">${img}</button>
      <div class="trade-sale-body">
        <div class="trade-sale-top">
          <button type="button" class="trade-sale-name" ${openAttrs}>${esc(s.name)}</button>
          <span class="trade-sale-type">${esc(saleTypeLabel(s))}</span>
        </div>
        <div class="trade-sale-tags">${rarityChip(s.rarity)}${rankChip(s.rank)}${status}</div>
        ${saleTraitChips(s)}
        <div class="trade-sale-meta">
          ${wallets.join('')}
          ${when ? `<span class="trade-sale-when">${when}</span>` : ''}
        </div>
        <div class="trade-sale-links">${viewBtn}${assetLink}${txLink}</div>
      </div>
      <div class="trade-sale-price">
        <span class="trade-sale-eth ${s.currency === 'usdc' ? 'is-usdc' : ''}">${esc(s.currency ? fmtListingAmt({ currency: s.currency, totalAmt: s.priceAmt, totalEth: s.priceEth }) : fmtEth(s.priceEth))}</span>
        ${fiat ? `<span class="trade-sale-usd">${esc(fiat)}</span>` : ''}
      </div>
    </article>`;
}

function salesGridInnerHtml() {
  if (salesLoading && !(salesItems && salesItems.length)) {
    return `<div class="trade-grid-state"><span class="trade-mini-spin" aria-hidden="true"></span><p>${esc(t('trade.sales.loading'))}</p></div>`;
  }
  if (salesError && !(salesItems && salesItems.length)) {
    return `<div class="trade-grid-state"><p>${esc(t('trade.sales.error'))}</p>
      <button class="apply-btn-ghost" data-act="sales-retry" type="button">${esc(t('trade.browse.retry'))}</button></div>`;
  }
  if (!salesItems || !salesItems.length) {
    if (fltActive()) {
      return `<div class="trade-grid-state"><div class="trade-grid-state-ico" aria-hidden="true">🔍</div><p>${esc(t('trade.sales.noneFiltered'))}</p>
        <button class="apply-btn-ghost" data-act="flt-clear" type="button">${esc(t('trade.filter.clear'))}</button></div>`;
    }
    return `<div class="trade-grid-state"><div class="trade-grid-state-ico" aria-hidden="true">🧾</div><p>${esc(t('trade.sales.none'))}</p></div>`;
  }
  return salesItems.map((s, i) => saleCardHtml(s, i)).join('');
}

function salesLoadMoreHtml() {
  if (!(salesItems && salesItems.length) || !salesHasMore) return '';
  return `<button class="apply-btn-ghost" data-act="sales-loadmore" type="button" ${salesLoading ? 'disabled' : ''}>${esc(salesLoading ? t('trade.browse.loadingMore') : t('trade.browse.loadMore'))}</button>`;
}

function patchSalesGrid() {
  if (tradeTab !== 'sales') return;
  const g = root()?.querySelector('#trade-sales-grid');
  if (g) g.innerHTML = salesGridInnerHtml();
  const lm = root()?.querySelector('#trade-sales-loadmore');
  if (lm) lm.innerHTML = salesLoadMoreHtml();
}

// --- Seller hub (my listings + sell + transfer) ---

// --- Optimistic ownership: a just-bought item, before the indexer knows -------------------
// The Sell/Transfer pickers are fed by the external indexers (OpenSea for LAND, Immutable
// for Creatures), whose OWNER index can lag a mined buy by minutes — well past the
// refreshAfterTx retry window. History showed the buy while Sell/Transfer stayed empty.
// So on buy success we remember what was bought and merge it into `owned` until the
// indexer reports it (or a TTL expires). Scoped per wallet + collection.
let pendingOwned = [];
const PENDING_OWNED_TTL_MS = 10 * 60 * 1000;
function notePendingOwned(it) {
  pendingOwned = pendingOwned.filter(p => !(p.coll === coll && String(p.tokenId) === String(it.tokenId)));
  pendingOwned.push({
    coll, account, at: Date.now(),
    item: { tokenId: String(it.tokenId), name: it.name || `#${it.tokenId}`, image: it.image || null,
            coords: it.coords || null, traits: it.traits || {}, rank: it.rank ?? null },
  });
}
function dropPendingOwned(tokenId) {
  pendingOwned = pendingOwned.filter(p => String(p.item.tokenId) !== String(tokenId));
}
function mergePendingOwned(items) {
  const now = Date.now();
  const have = new Set(items.map(i => String(i.tokenId)));
  // Expired, indexed (server now reports it), or foreign entries don't merge; indexed ones
  // are dropped for good — the optimistic copy has served its purpose.
  pendingOwned = pendingOwned.filter(p => now - p.at < PENDING_OWNED_TTL_MS
    && !(p.coll === coll && p.account === account && have.has(String(p.item.tokenId))));
  const extra = pendingOwned.filter(p => p.coll === coll && p.account === account).map(p => p.item);
  return extra.length ? [...extra, ...items] : items;
}

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
      owned = mergePendingOwned(o.items || []);
      mine = m.items || [];
    } else {
      const [o, m] = await Promise.all([
        fetch(`/api/market/creatures/owned/${account}`).then(r => r.ok ? r.json() : { items: [] }),
        fetch(`/api/market/creatures/mine/${account}`).then(r => r.ok ? r.json() : { items: [] }),
      ]);
      owned = mergePendingOwned(o.items || []);
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
              <span class="trade-mine-price">${esc(l.currency ? fmtListingLine(l) : fmtEthFiat(l.priceEth))}</span>
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

// Select-all / clear bar above a multi-select picker. "Select all" acts on the CURRENTLY
// FILTERED set (a trait filter narrows what "all" means); flips to "Deselect all" once the
// whole filtered set is picked. Shows a live count.
function pickBarHtml(set) {
  const ids = invFilteredItems().map(o => String(o.tokenId));
  const allOn = ids.length > 0 && ids.every(id => set.has(id));
  const n = set.size;
  return `<div class="trade-pick-bar">
    <button type="button" class="trade-pick-all" data-act="mass-all" ${ids.length ? '' : 'disabled'}>${esc(t(allOn ? 'trade.mass.deselectAll' : 'trade.mass.selectAll'))}</button>
    ${n ? `<span class="trade-pick-count" role="status">${esc(t('trade.mass.selected').replace('{n}', String(n)))}</span>
    <button type="button" class="trade-pick-clear" data-act="mass-clear">${esc(t('trade.mass.clear'))}</button>` : ''}
  </div>`;
}

// One multi-select tile: a checkbox overlay + is-sel highlight, membership from `set`.
function pickTileHtml(o, act, set) {
  const on = set.has(String(o.tokenId));
  const art = coll === 'land' && petUrl(o)
    ? `<img src="${esc(petUrl(o))}" ${o.image ? `data-fallback="${esc(o.image)}"` : ''} alt="" loading="lazy" />`
    : (o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy" />` : '<div class="trade-tile-noimg">🐾</div>');
  return `
    <button class="trade-pick-tile ${on ? 'is-sel' : ''}" type="button"
      role="option" aria-selected="${on}"
      data-act="${act}" data-token="${esc(o.tokenId)}" title="${esc(o.name)}">
      <span class="trade-pick-check" aria-hidden="true">✓</span>
      ${art}
      <span>${esc(o.name.replace(/^Highrise (Creature|LAND) /, ''))}</span>
    </button>`;
}

function sellPickerHtml() {
  if (owned === null) return `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t(skey('trade.sell.loadingOwned')))}</div>`;
  if (!invBase().length) return `<p class="trade-form-p">${esc(t(skey('trade.sell.none')))}</p>`;
  const sellable = invFilteredItems();
  if (!sellable.length) return `<p class="trade-form-p">${esc(t('trade.filter.invNone'))} <button type="button" class="trade-flt-clearall" data-act="inv-clear">${esc(t('trade.filter.clear'))}</button></p>`;
  return `${pickBarHtml(sellSet)}
    <div class="trade-pick" role="listbox" aria-multiselectable="true" aria-label="${esc(t(skey('trade.sell.pickAria')))}">
      ${sellable.map(o => pickTileHtml(o, 'sell-pick', sellSet)).join('')}
    </div>`;
}

// Collection scope: Creatures (zkEVM) ⟷ LAND (Ethereum). Sits above the action tabs.
function collSwitcherHtml() {
  return `<div class="seg trade-coll-switch" role="tablist" aria-label="${esc(t('trade.coll.aria'))}">
    ${Object.entries(COLLECTIONS).map(([id, c]) => `
      <button type="button" role="tab" class="seg-btn ${coll === id ? 'is-active' : ''}"
        aria-selected="${coll === id}" data-act="coll" data-coll="${id}">${collIco(id)} ${esc(t(c.labelKey))}</button>`).join('')}
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
    ['sales', 'trade.tab.sales'], ['history', 'trade.tab.myhistory']];
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

// --- Public holder profile (opt-in showcase) ---
// The profile lives INSIDE the marketplace: a compact pill at the right end of the
// action-tab row opens the 'profile' view (manage card + live preview) in the content
// area, and other members' profiles render the same way (search banner, /profile/{slug}
// deep links). Identity comes from the Discord session (/api/me), NOT from the connected
// MetaMask account — the pill works even before MetaMask connects.
let meState = null;      // /api/me payload, or null until fetched
let meLoading = false;
let hpBusy = false;      // enable/disable POST in flight
let hpError = false;
let hpLinkBusy = false;  // wallet link/unlink POST in flight
let hpLinkError = null;  // i18n key for the last wallet-link failure, or null
let hpWalletsOpen = false; // manage-strip wallet drawer expanded?

async function fetchMeForProfile() {
  if (meLoading || meState !== null) return;
  meLoading = true;
  try {
    const res = await fetch('/api/me', { headers: { Accept: 'application/json' } });
    meState = res.ok ? await res.json() : { authenticated: false };
  } catch {
    meState = { authenticated: false };
  } finally {
    meLoading = false;
    patchProfileCard();
    // If the session resolved while the setup view was open and a profile already
    // exists, upgrade in place to the live preview (same view, now with a slug).
    if (tradeTab === 'profile' && !profileViewSlug && meState?.holderProfile?.enabled) {
      openProfileView(meState.holderProfile.slug, { replace: true });
    }
  }
}

async function setHolderProfile(enable) {
  if (hpBusy) return;
  hpBusy = true; hpError = false;
  patchProfileCard();
  try {
    const res = await fetch(`/api/profile/${enable ? 'enable' : 'disable'}`, { method: 'POST', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    if (meState) {
      // Seed the wallet list with the Highrise anchor (the server just added it) so the
      // manage-wallets UI is populated immediately without a second round-trip.
      const anchor = (meState.eligibility?.ethWallet || '').toLowerCase();
      meState.holderProfile = data.enabled
        ? { enabled: true, slug: data.slug, wallets: anchor ? [{ wallet: anchor, highriseLinked: true, verified: false }] : [] }
        : { enabled: false };
    }
    // Keep the open profile view in step: enabling loads the fresh live preview,
    // disabling drops back to the setup card (the public URL is gone either way).
    if (tradeTab === 'profile') {
      if (data.enabled) openProfileView(data.slug, { replace: true });
      else openProfileView(null, { replace: true });
    }
  } catch (err) {
    console.error('Holder profile toggle failed:', err);
    hpError = true;
  } finally {
    hpBusy = false;
    patchProfileCard();
  }
}

// Prove control of the currently-connected MetaMask wallet and add it to the profile:
// fetch a server nonce → personal_sign it → POST the signature. The server recovers the
// signer and links THAT address, so we never trust a claimed address.
async function linkConnectedWallet() {
  if (hpLinkBusy) return;
  if (!eth() || !account) { hpLinkError = 'trade.profile.linkNeedsWallet'; return patchProfileCard(); }
  hpLinkBusy = true; hpLinkError = null;
  patchProfileCard();
  try {
    const nres = await fetch('/api/profile/wallets/nonce', { method: 'POST', headers: { Accept: 'application/json' } });
    if (!nres.ok) throw new Error('nonce ' + nres.status);
    const { message } = await nres.json();
    const signature = await eth().request({ method: 'personal_sign', params: [message, account] });
    const lres = await fetch('/api/profile/wallets/link', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ signature }),
    });
    const data = await lres.json().catch(() => ({}));
    if (!lres.ok) {
      hpLinkError = data.error === 'wallet_taken' ? 'trade.profile.linkTaken'
        : data.error === 'too_many' ? 'trade.profile.linkTooMany'
        : 'trade.profile.linkFailed';
    } else if (meState?.holderProfile) {
      meState.holderProfile.wallets = data.wallets || meState.holderProfile.wallets;
      refreshProfilePreview();
    }
  } catch (err) {
    // 4001 = user rejected the signature in MetaMask — not an error to shout about.
    hpLinkError = err?.code === 4001 ? null : 'trade.profile.linkFailed';
    if (err?.code !== 4001) console.error('Wallet link failed:', err);
  } finally {
    hpLinkBusy = false;
    patchProfileCard();
  }
}

// The manage card and the live preview below it show the same wallet list — after a
// link/verify/unlink the showcase must reflect the change too, not a cached copy.
function refreshProfilePreview() {
  if (tradeTab === 'profile' && profileViewSlug) loadProfile(profileViewSlug, { force: true });
}

async function unlinkProfileWallet(wallet) {
  if (hpLinkBusy) return;
  hpLinkBusy = true; hpLinkError = null;
  patchProfileCard();
  try {
    const res = await fetch('/api/profile/wallets/unlink', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ wallet }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && meState?.holderProfile) {
      meState.holderProfile.wallets = data.wallets || [];
      refreshProfilePreview();
    } else if (!res.ok) hpLinkError = 'trade.profile.linkFailed';
  } catch (err) {
    console.error('Wallet unlink failed:', err);
    hpLinkError = 'trade.profile.linkFailed';
  } finally {
    hpLinkBusy = false;
    patchProfileCard();
  }
}

const PERSON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2"/><path d="M4 20c1.4-3.6 4.4-5.5 8-5.5s6.6 1.9 8 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

// The compact pill at the right end of the action-tab row — the persistent entry
// point to your own profile. One word of state (My profile) + the live dot; the full
// controls live in the in-view manage card. `is-live` tints it mint when public.
function profileNavPillHtml() {
  const enabled = !!meState?.holderProfile?.enabled;
  const own = tradeTab === 'profile' && isOwnProfileView();
  return `<button type="button" id="trade-hp-nav" class="trade-hp-pill ${enabled ? 'is-live' : ''} ${own ? 'is-active' : ''}"
    data-act="hp-open" aria-pressed="${own}" title="${esc(t('trade.profile.sub'))}">
    ${enabled ? '<span class="trade-hp-dot" aria-hidden="true"></span>' : PERSON_SVG}
    <span class="trade-hp-pill-txt">${esc(t('trade.profile.nav'))}</span>
  </button>`;
}

// Is the open profile view the signed-in member's own (their slug, or the pre-enable
// setup state)? Drives the manage card + the nav pill's pressed state.
function isOwnProfileView() {
  if (!profileViewSlug) return true;
  const mine = meState?.holderProfile?.slug;
  return !!mine && mine === profileViewSlug;
}

// The profile content area: the manage card (own profile only) above the public
// showcase (js/profile.js renders into #profile-app). Someone else's profile is the
// showcase alone — same layout a visitor of the shared link gets.
function profileViewHtml() {
  const own = isOwnProfileView();
  return `
    <div id="trade-hp-manage" class="trade-hp-card" ${own ? '' : 'hidden'}>${own ? profileManageInnerHtml() : ''}</div>
    <div id="profile-app" aria-live="polite" ${profileViewSlug ? '' : 'hidden'}></div>`;
}

// Manage-card contents. Pre-enable states pitch the feature (icon + why + one CTA on
// a single row); once live it collapses to a slim strip — LIVE chip, the public link,
// Copy, a wallet-drawer toggle, Turn off — so your own showcase starts right below.
function profileManageInnerHtml() {
  const head = `<div class="trade-hp-pop-head">
    <span class="trade-hp-pop-ico" aria-hidden="true">${PERSON_SVG}</span>
    <div>
      <h4 class="trade-hp-h">${esc(t('trade.profile.h'))}</h4>
      <p class="trade-hp-sub">${esc(t('trade.profile.sub'))}</p>
    </div>
  </div>`;
  const err = hpError ? `<p class="trade-hp-err">${esc(t('trade.profile.error'))}</p>` : '';
  // Discord disconnect (full logout, returns to /trade signed-out) — mirrors the plain-link
  // logout used on Apply/Polls. Shown wherever a Discord session exists.
  const disc = `<a class="trade-hp-disc" href="/api/auth/logout?return=%2Ftrade">${esc(t('trade.profile.disconnect'))}</a>`;
  const pitchRow = (cta, showDisc = false) =>
    `<div class="trade-hp-pitchrow">${head}<div class="trade-hp-pitch-cta">${cta}${showDisc ? disc : ''}</div></div>${err}`;

  if (meState === null) {
    return pitchRow(`<p class="trade-hp-hint">${esc(t('trade.profile.loading'))}</p>`);
  }
  if (!meState.authenticated) {
    return pitchRow(`
      <a class="apply-discord-btn is-sm trade-hp-signin" href="/api/auth/discord/login?return=/trade">
        <span class="apply-discord-logo">${DISCORD_SVG}</span>
        <span class="apply-discord-label">${esc(t('trade.profile.signin'))}</span>
      </a>`);
  }
  if (!meState.eligibility?.linked) {
    return pitchRow(`<p class="trade-hp-hint">${esc(t('trade.profile.noWallet'))}</p>`, true);
  }
  const hp = meState.holderProfile || { enabled: false };
  if (!hp.enabled) {
    return pitchRow(`
      <button type="button" class="trade-send trade-hp-btn" data-act="hp-enable" ${hpBusy ? 'disabled' : ''}>
        ${esc(t(hpBusy ? 'trade.profile.working' : 'trade.profile.enable'))}</button>`, true);
  }
  const url = `/profile/${hp.slug}`;
  const nWallets = (hp.wallets || []).length || 1;
  return `
    <div class="trade-hp-strip">
      <span class="trade-hp-live"><span class="trade-hp-dot" aria-hidden="true"></span>${esc(t('trade.profile.live'))}</span>
      <a class="trade-hp-link" href="${esc(url)}">${esc(url)}</a>
      <button type="button" class="trade-send is-sm trade-hp-btn" data-act="copy" data-copy="${esc(location.origin + url)}">${esc(t('trade.profile.copy'))}</button>
      <button type="button" class="trade-hp-wtoggle ${hpWalletsOpen ? 'is-open' : ''}" data-act="hp-wallets" aria-expanded="${hpWalletsOpen}">
        ${esc(t('trade.profile.walletsBtn').replace('{n}', String(nWallets)))}
        <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="trade-hp-strip-sep" aria-hidden="true"></span>
      <button type="button" class="apply-logout trade-hp-btn trade-hp-off" data-act="hp-disable" ${hpBusy ? 'disabled' : ''}>
        ${esc(t(hpBusy ? 'trade.profile.working' : 'trade.profile.disable'))}</button>
      ${disc}
    </div>
    ${err}
    ${hpWalletsOpen ? `<div class="trade-hp-wdrawer">${walletManagerHtml(hp)}</div>` : ''}`;
}

// The showcase-wallet list inside the popover. Each wallet shows its trust tier: the
// Highrise anchor is "Highrise-linked" until signed, "Verified" once signed (and can then
// carry a Verify prompt); standalone signed wallets are removable. Signing the anchor is
// now offered (it upgrades to Verified and persists the proof).
function walletManagerHtml(hp) {
  const wallets = hp.wallets || [];
  const connected = (account || '').toLowerCase();
  const rows = wallets.map(w => {
    const label = w.highriseLinked ? t('trade.profile.walletHighrise') : t('trade.profile.walletLinked');
    const badge = w.verified
      ? `<span class="trade-hp-wtag is-verified">${esc(t('trade.profile.tagVerified'))}</span>`
      : `<span class="trade-hp-wtag is-linked">${esc(t('trade.profile.tagLinked'))}</span>`;
    // A Verify button appears for an unverified wallet when it's the one currently connected.
    const canVerifyHere = !w.verified && connected && connected === w.wallet && eth();
    const action = w.verified && w.highriseLinked
      ? `<span class="trade-hp-wlock" title="${esc(t('trade.profile.walletLockedTip'))}" aria-label="${esc(t('trade.profile.walletLockedTip'))}">🔒</span>`
      : canVerifyHere
        ? `<button type="button" class="trade-hp-wverify" data-act="hp-link" ${hpLinkBusy ? 'disabled' : ''}>${esc(hpLinkBusy ? t('trade.profile.linkWorking') : t('trade.profile.verifyBtn'))}</button>`
        : w.highriseLinked
          ? `<span class="trade-hp-wlock" title="${esc(t('trade.profile.walletLockedTip'))}" aria-label="${esc(t('trade.profile.walletLockedTip'))}">🔒</span>`
          : `<button type="button" class="trade-hp-wx" data-act="hp-unlink" data-wallet="${esc(w.wallet)}" ${hpLinkBusy ? 'disabled' : ''} aria-label="${esc(t('trade.profile.walletRemove'))}">×</button>`;
    return `<li class="trade-hp-wrow">
      <span class="trade-hp-wsrc ${w.highriseLinked ? 'is-anchor' : ''}">${esc(label)}</span>
      ${badge}
      <code class="trade-hp-waddr">${esc(shortWallet(w.wallet))}</code>
      ${action}
    </li>`;
  }).join('');

  // Offer to verify/add the currently-connected MetaMask wallet when it isn't already listed
  // as verified. (If it's the unverified anchor, its own row shows the Verify button above.)
  const listed = connected && wallets.find(w => w.wallet === connected);
  let addRow = '';
  if (!eth() || !connected) {
    addRow = `<p class="trade-hp-whint">${esc(t('trade.profile.linkConnectHint'))}</p>`;
  } else if (listed && listed.verified) {
    addRow = `<p class="trade-hp-whint">${esc(t('trade.profile.linkAlready'))}</p>`;
  } else if (!listed) {
    addRow = `<button type="button" class="apply-btn-ghost is-sm trade-hp-btn trade-hp-linkbtn" data-act="hp-link" ${hpLinkBusy ? 'disabled' : ''}>
      ${esc(hpLinkBusy ? t('trade.profile.linkWorking') : t('trade.profile.linkBtn').replace('{addr}', shortWallet(connected)))}</button>`;
  } // else: the connected wallet is the unverified anchor — its row already offers Verify.

  return `<div class="trade-hp-wallets">
    <h5 class="trade-hp-wtitle">${esc(t('trade.profile.walletsTitle'))}</h5>
    <ul class="trade-hp-wlist">${rows}</ul>
    ${hpLinkError ? `<p class="trade-hp-err">${esc(t(hpLinkError))}</p>` : ''}
    ${addRow}
  </div>`;
}

// Repaint the nav pill + manage card in place (survives enable/disable, wallet
// link/unlink, and the /api/me fetch resolving) without re-rendering the whole panel.
function patchProfileCard() {
  const nav = root()?.querySelector('#trade-hp-nav');
  if (nav) nav.outerHTML = profileNavPillHtml();
  if (tradeTab !== 'profile') return;
  const card = root()?.querySelector('#trade-hp-manage');
  if (!card) return;
  const own = isOwnProfileView();
  card.hidden = !own;
  card.innerHTML = own ? profileManageInnerHtml() : '';
}

// Open the in-marketplace profile view. slug=null shows the signed-in member's own
// setup/manage state; a slug shows that member's public showcase (plus the manage card
// when it's your own). Keeps /profile/{slug} shareable: opening a profile pushes its
// canonical URL, so copy/share and refresh land on the same view.
export function openProfileView(slug, opts = {}) {
  tradeTab = 'profile';
  profileViewSlug = (slug || '').toLowerCase() || null;
  hpLinkError = null;
  hpWalletsOpen = false;
  setFltSheet(false);
  openFacet = null;
  if (opts.updateUrl !== false) {
    const url = profileViewSlug ? `/profile/${profileViewSlug}` : '/trade';
    if (location.pathname !== url) history[opts.replace ? 'replaceState' : 'pushState'](null, '', url);
  }
  // A shared /profile link (or an in-page profile jump) should land ON the profile —
  // the marketplace sits below the page hero, so ask the next render to scroll there.
  hpScrollPending = true;
  if (loadedOnce && root()) render();
}
// One-shot: render() consumes it (deep links render via loadMarketplace, not the
// openProfileView call above, so the flag has to survive until whichever comes first).
let hpScrollPending = false;

// Open a specific token's marketplace view (its buy/offer modal), switching the active
// collection if needed. Called from a profile tile's "view in market" — it leaves the
// profile view, lands on /trade?coll=…&token=… (shareable), and deep-links the modal.
export function openTokenInMarket(collKind, tokenId, opts = {}) {
  if (!loadedOnce) return;
  const tk = String(tokenId || '').trim();
  if (!/^\d{1,80}$/.test(tk)) return;
  const switching = COLLECTIONS[collKind] && collKind !== coll;
  if (switching) {
    coll = collKind;
    try { localStorage.setItem('hcc-trade-coll', coll); } catch { /* fine */ }
    tokenOffers = null;
    resetBrowseForView();
    resetSellerState();
    autoSwitchNetwork();
  }
  // From the profile view, the token detail opens as an OVERLAY — the profile stays put
  // behind it (URL included), so closing the modal lands you exactly where you were.
  // The modal is rendered on every tab, so no tab/view change is needed.
  if (tradeTab === 'profile') {
    if (switching) {
      loadListings(true);
      if (coll === 'creatures') loadCollOffers(); else if (coll === 'land') loadLandCollOffers();
    }
    openDeepLink(tk, { knownListed: opts.listed });
    return;
  }
  tradeTab = 'buy';
  profileViewSlug = null;
  hpWalletsOpen = false;
  setFltSheet(false);
  openFacet = null;
  // A token we already know is UNLISTED isn't on the On-sale grid — showing that grid
  // behind its modal reads as "it dumped me into all the listed ones". Flip the backdrop
  // to the whole-collection scope so the item sits in context.
  if (opts.listed === false) flt.scope = 'all';
  history.pushState(null, '', `/trade?coll=${coll}&token=${encodeURIComponent(tk)}`);
  if (root()) render();
  loadListings(true);
  if (coll === 'creatures') loadCollOffers(); else if (coll === 'land') loadLandCollOffers();
  openDeepLink(tk, { knownListed: opts.listed });
}

// Leave the profile view (route change back to /trade, or the main nav Trade tab).
// URL is the caller's business — this only restores the browse content.
export function closeProfileView() {
  if (!loadedOnce || tradeTab !== 'profile') return;
  tradeTab = 'buy';
  profileViewSlug = null;
  if (root()) render();
}

// profile.js is rendered inside this panel but can't import us (module cycle), so its
// in-view navigation — the "true owner" link on the rental warning, the browse CTA on
// a 404 — arrives as custom events. Wired once.
let hpEventsWired = false;
function wireProfileEvents() {
  if (hpEventsWired) return; hpEventsWired = true;
  window.addEventListener('hcc:open-profile', e => {
    if (loadedOnce && e.detail?.slug) openProfileView(e.detail.slug);
  });
  window.addEventListener('hcc:browse-trade', () => {
    if (!loadedOnce) return;
    if (location.pathname.startsWith('/profile')) history.pushState(null, '', '/trade');
    tradeTab = 'buy';
    profileViewSlug = null;
    render();
  });
  window.addEventListener('hcc:open-token', e => {
    if (e.detail?.tokenId) openTokenInMarket(e.detail.coll, e.detail.tokenId, { listed: e.detail.listed });
  });
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
      <div class="trade-wb-side" id="trade-sell-side">${sellSideHtml()}</div>
    </div>`;
  // Same left filter sidebar + toolbar as Buy, once there's an inventory worth filtering.
  return invHasFilters()
    ? `<section class="trade-browse has-side">${invFilterSideHtml()}<div class="trade-main">${myListingsHtml()}${invToolbarHtml()}${wb}</div></section>`
    : `${myListingsHtml()}${wb}`;
}

// The Sell action column adapts to the selection: 0-or-1 Creatures keeps the familiar
// single-listing form (price + List for sale + instant-sell into an offer); 2+ switches to
// the mass-list panel (per-item prices + apply-to-all + a batch List button). One shared
// container so a pick just re-renders this side, never the picker (its scroll survives).
function sellSideHtml() {
  if (sellSet.size >= 2) return sellMassHtml();
  // After a batch finishes and every item cleared, keep the "Listed X of N" summary visible
  // above the (now empty) single panel until the next pick — otherwise the result flashes away.
  const banner = (massState && massState.kind === 'sell' && massState.phase === 'done')
    ? `<div class="trade-mass-summary" id="trade-mass-status">${massStatusHtml()}</div>` : '';
  return banner + sellSingleHtml();
}

// Segmented "settle in ETH ⟷ USDC" picker. USDC is dollar-pegged, so sellers who want to dodge
// the swings price directly in dollars — on Creatures (Immutable orderbook, zkEVM USDC) and
// LAND (OpenSea Seaport, mainnet USDC) alike.
function sellCurrencyPickerHtml() {
  return `<div class="trade-field"><span>${esc(t('trade.sell.currency'))} ${tipHtml('trade.sell.currency.tip')}</span>
    <div class="seg trade-cur-seg" role="tablist" aria-label="${esc(t('trade.sell.currency'))}">
      ${LISTING_CURRENCIES.map(c => `<button type="button" role="tab" class="seg-btn ${sellCurrency === c ? 'is-active' : ''}"
        aria-selected="${sellCurrency === c}" data-act="sell-cur" data-cur="${c}">${esc(CUR_SYM[c])}</button>`).join('')}
    </div></div>`;
}

function sellSingleHtml() {
  const isLand = coll === 'land';
  const sellBusy = sellState && SELL_BUSY_PHASES.has(sellState.phase);
  const price = sellSel != null ? (sellPrices.get(String(sellSel)) || '') : '';
  const isUsdc = sellCurrency === 'usdc';
  // USDC is entered directly in dollars (no ETH/fiat unit conversion); ETH keeps the unit picker.
  return `
    <div id="trade-sell-selected">${sellSelectedHtml()}</div>
    <form class="trade-form" id="trade-sell-form" novalidate>
      ${sellCurrencyPickerHtml()}
      <label class="trade-field"><span>${esc(t('trade.sell.price'))}</span>
        <div class="trade-price-row">
          <input id="trade-sell-price" type="text" inputmode="decimal" value="${esc(price)}" placeholder="${esc(isUsdc ? '250' : (sellUnit === 'eth' ? t('trade.sell.price.ph') : t('trade.sell.price.phFiat')))}" autocomplete="off" />
          ${isUsdc
            ? `<span class="trade-price-unit trade-cur-fixed">USDC</span>`
            : `<select id="trade-sell-unit" class="seg-select trade-price-unit" aria-label="${esc(t('trade.sell.unitAria'))}" ${sellFiatReady() ? '' : 'disabled'}>${sellUnitOptions()}</select>`}
        </div>
        <span class="trade-price-conv" id="trade-price-conv">${esc(isUsdc ? '' : sellConvHtml(price))}</span></label>
      ${isLand ? landSellDurationHtml() : ''}
      ${isLand ? `<div class="trade-sell-net" id="trade-sell-net">${landSellNetHtml(price)}</div>` : ''}
      <button class="trade-send" id="trade-sell-submit" type="submit" ${sellBusy || !sellSel ? 'disabled' : ''}>
        ${esc(t('trade.sell.btn'))} <span aria-hidden="true">→</span></button>
      <div id="trade-sell-status" role="status" aria-live="polite">${sellStatusHtml()}</div>
    </form>
    <div id="trade-sell-instant">${isLand ? landInstantSellHtml() : instantSellHtml()}</div>`;
}

function patchSellSide() {
  const side = root()?.querySelector('#trade-sell-side');
  if (side) side.innerHTML = sellSideHtml();
  patchSellTiles();
}
// Toggle the picker tiles' selected state in place (never rebuilds the picker → scroll survives).
function patchSellTiles() {
  root()?.querySelectorAll('#trade-pick-wrap .trade-pick-tile').forEach(btn => {
    const on = sellSet.has(String(btn.dataset.token));
    btn.classList.toggle('is-sel', on);
    btn.setAttribute('aria-selected', String(on));
  });
  const bar = root()?.querySelector('#trade-pick-wrap .trade-pick-bar');
  if (bar) bar.outerHTML = pickBarHtml(sellSet);
}

// Sum of the picked items' typed prices, in the SELECTED currency's native units (ETH or
// dollars) — skips blanks/invalid. Drives the running "total" readout + the submit enable.
function massSellTotal() {
  let sum = 0;
  for (const it of pickedItems(sellSet)) {
    const pay = sellPricePayload(sellPrices.get(String(it.tokenId)) || '');
    if (pay.ok) sum += Number(pay.price); // pay.price is a STRING — coerce or it concatenates
  }
  return sum;
}
// The mass "total" line, currency-aware. LAND nets 6% less (1% OpenSea + 5% royalty); Creatures
// list fee-free. USDC shows dollars 1:1; ETH shows its fiat estimate.
function massTotalLineHtml(total) {
  if (!(total > 0)) return '';
  const isLand = coll === 'land';
  const net = isLand ? total * 0.94 : total;
  const key = isLand ? 'trade.mass.sell.netTotal' : 'trade.mass.sell.total';
  const shown = sellCurrency === 'usdc'
    ? `${net.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`
    : fmtEthFiat(net);
  return t(key).replace('{x}', `<b>${esc(shown)}</b>`);
}

// Mass-list panel (2+ Creatures/parcels picked): a per-item price row for each, an
// apply-to-all quick-fill, a running total, and one batch List button. Prices persist in
// `sellPrices` so re-renders never wipe them.
function sellMassHtml() {
  const isLand = coll === 'land';
  const items = pickedItems(sellSet);
  const busy = massState && massState.phase === 'run';
  const isUsdc = sellCurrency === 'usdc';
  // Per-row unit label: dollars when listing in USDC, else the ETH/fiat display unit.
  const unit = isUsdc ? 'USDC' : sellUnit.toUpperCase();
  const rowPh = isUsdc ? '250' : (sellUnit === 'eth' ? '0.15' : '250');
  const total = massSellTotal();
  const totalLine = massTotalLineHtml(total);
  const rows = items.map(it => {
    const k = String(it.tokenId);
    const num = esc(it.name.replace(/^Highrise (Creature|LAND) /, '')); // name already carries "#1234"
    const pet = coll === 'land' ? petUrl(it) : null;
    const src = pet || it.image;
    const fb = pet && it.image ? ` data-fallback="${esc(it.image)}"` : '';
    const art = src ? `<img class="${pet ? 'is-pet' : ''}" src="${esc(src)}"${fb} alt="" loading="lazy" />`
      : `<div class="trade-tile-noimg" aria-hidden="true">${isLand ? '🗺️' : '🐾'}</div>`;
    return `<div class="trade-mass-row">
      <div class="trade-mass-thumb">${art}</div>
      <span class="trade-mass-num" title="${esc(it.name)}">${num}</span>
      <div class="trade-mass-price">
        <input type="text" inputmode="decimal" class="trade-mass-price-in" data-token="${esc(k)}"
          value="${esc(sellPrices.get(k) || '')}" placeholder="${esc(rowPh)}" aria-label="${esc(t('trade.sell.price'))} ${num}" />
        <span class="trade-mass-unit ${isUsdc ? 'is-usdc' : ''}">${esc(unit)}</span>
      </div>
      <button type="button" class="trade-mass-rm" data-act="sell-pick" data-token="${esc(k)}" aria-label="${esc(t('trade.mass.remove'))}" title="${esc(t('trade.mass.remove'))}">×</button>
    </div>`;
  }).join('');
  return `
    <div class="trade-mass">
      <div class="trade-mass-head">
        <h4 class="trade-form-h">${esc(t(skey('trade.mass.sell.h')).replace('{n}', String(items.length)))}</h4>
        <button type="button" class="trade-flt-clearall" data-act="mass-clear">${esc(t('trade.mass.clear'))}</button>
      </div>
      ${sellCurrencyPickerHtml()}
      <div class="trade-mass-applyall">
        <input id="trade-mass-all-price" type="text" inputmode="decimal" placeholder="${esc(t('trade.mass.applyPh'))}" autocomplete="off" aria-label="${esc(t('trade.mass.applyAll'))}" />
        ${isUsdc
          ? `<span class="trade-price-unit trade-cur-fixed">USDC</span>`
          : `<select id="trade-sell-unit" class="seg-select trade-price-unit" aria-label="${esc(t('trade.sell.unitAria'))}" ${sellFiatReady() ? '' : 'disabled'}>${sellUnitOptions()}</select>`}
        <button type="button" class="apply-btn-ghost" data-act="mass-apply-all">${esc(t('trade.mass.apply'))}</button>
      </div>
      ${isLand ? `<div class="trade-mass-dur">${landSellDurationHtml()}</div>` : ''}
      <form class="trade-form" id="trade-mass-sell-form" novalidate>
        <div class="trade-mass-rows">${rows}</div>
        ${totalLine ? `<div class="trade-mass-total">${totalLine}</div>` : ''}
        <button class="trade-send" id="trade-mass-submit" type="submit" ${busy || total <= 0 ? 'disabled' : ''}>
          ${esc(t('trade.mass.sell.btn').replace('{n}', String(items.length)))} <span aria-hidden="true">→</span></button>
        <div id="trade-mass-status" role="status" aria-live="polite">${massStatusHtml()}</div>
      </form>
    </div>`;
}

// Batch-run progress/summary, shared by mass-list and mass-transfer. Fields:
// { kind:'sell'|'transfer', total, i (1-based item in flight), ok, failed:[], phase, msg }.
function massStatusHtml() {
  const m = massState;
  if (!m) return '';
  if (m.phase === 'run') {
    const step = t(`trade.mass.${m.kind}.progress`).replace('{i}', String(m.i)).replace('{n}', String(m.total));
    return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(step)}${m.failed.length ? ` · ${esc(t('trade.mass.failedSoFar').replace('{f}', String(m.failed.length)))}` : ''}</span></div>`;
  }
  if (m.phase === 'error') {
    return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(m.msg)}</span></div>`;
  }
  if (m.phase === 'done') {
    const okMsg = t(`trade.mass.${m.kind}.done`).replace('{ok}', String(m.ok)).replace('{n}', String(m.total));
    const failMsg = m.failed.length ? ` ${t('trade.mass.doneFailed').replace('{f}', String(m.failed.length))}` : '';
    return `<div class="trade-status ${m.failed.length ? 'is-warn' : 'is-ok'}"><span aria-hidden="true">${m.failed.length ? '⚠' : '✓'}</span><span>${esc(okMsg)}${esc(failMsg)}</span></div>`;
  }
  return '';
}
function patchMassStatus() {
  const el = root()?.querySelector('#trade-mass-status');
  if (el) el.innerHTML = massStatusHtml();
  const btn = root()?.querySelector('#trade-mass-submit');
  const total = massSellTotal();
  if (btn) btn.disabled = !!(massState && massState.phase === 'run') || total <= 0;
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
// Currency-aware: an ETH listing nets ETH, a USDC listing nets USDC (both minus 6%).
function landSellNetHtml(priceStr) {
  const p = parseFloat(String(priceStr).replace(',', '.'));
  if (!(p > 0)) return `<span class="trade-sell-net-hint">${esc(t('trade.sell.feeNote'))}</span>`;
  const net = sellCurrency === 'usdc'
    ? `${(p * 0.94).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`
    : `${fmtEth(p * 0.94)} ETH`;
  return `<span class="trade-sell-net-hint">${t('trade.sell.netNote').replace('{net}', `<b>${esc(net)}</b>`).replace('{fee}', '6')}</span>`;
}

// Picker of transferable Creatures (owned minus actively listed — transferring a
// listed Creature would leave a phantom listing behind).
function transferPickerHtml() {
  if (owned === null) return `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t(skey('trade.sell.loadingOwned')))}</div>`;
  const base = invBase();
  const hiddenNote = owned.length > base.length
    ? `<p class="trade-form-p">${esc(t(skey('trade.transfer.listedNote')))}</p>` : '';
  if (!base.length) return `<p class="trade-form-p">${esc(t(skey('trade.transfer.none')))}</p>${hiddenNote}`;
  const transferable = invFilteredItems();
  if (!transferable.length) return `<p class="trade-form-p">${esc(t('trade.filter.invNone'))} <button type="button" class="trade-flt-clearall" data-act="inv-clear">${esc(t('trade.filter.clear'))}</button></p>${hiddenNote}`;
  return `${pickBarHtml(transferSet)}
    <div class="trade-pick" role="listbox" aria-multiselectable="true" aria-label="${esc(t(skey('trade.transfer.pick')))}">
      ${transferable.map(o => pickTileHtml(o, 'transfer-pick', transferSet)).join('')}
    </div>${hiddenNote}`;
}

// Live recipient assessment rendering. Hard blocks (bad checksum / protocol contract)
// kill the Send button; a never-used address demands an explicit confirmation.
function transferCheckHtml() {
  const c = transferCheck;
  if (!c) return '';
  if (c === 'loading') return `<div class="trade-check-row is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(skey('trade.check.checking')))}</span></div>`;
  if (!c.valid) {
    const KEY = { checksum: 'trade.check.checksumBad', protocol: 'trade.check.protocol', format: 'trade.err.badAddr' };
    return `<div class="trade-check-row is-err"><span aria-hidden="true">⛔</span><span>${esc(t(skey(KEY[c.reason] || 'trade.err.badAddr')))}</span></div>`;
  }
  // Best case: it's another of the user's own connected accounts — proven by the
  // wallet itself, no warning needed at all.
  if (c.connectedOwn) {
    return `<div class="trade-check-row is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.check.ownAccount'))}</span></div>`;
  }
  const rows = [];
  if (c.checksum === 'ok') rows.push(`<div class="trade-check-row is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.check.checksumOk'))}</span></div>`);
  if (c.active) {
    rows.push(`<div class="trade-check-row is-ok"><span aria-hidden="true">✓</span><span>${esc(t(skey('trade.check.active')))}</span></div>`);
    if (c.creatures > 0) rows.push(`<div class="trade-check-row is-ok"><span aria-hidden="true">✓</span><span>${esc(t(skey('trade.check.holds')).replace('{n}', String(c.creatures)))}</span></div>`);
    if (c.contract) rows.push(`<div class="trade-check-row is-warn"><span aria-hidden="true">⚠</span><span>${esc(t('trade.check.contract'))}</span></div>`);
  } else {
    // Calm info tone, not an alarm — a fresh wallet is normal; the diligence is the
    // ten-second visual match. The hard "why" lives behind the ⓘ for the curious.
    rows.push(`<div class="trade-check-row is-info"><span aria-hidden="true">🔍</span><span>${esc(t(skey(c.activityKnown ? 'trade.check.fresh' : 'trade.check.unknown')))} ${tipHtml('trade.check.fresh.tip')}</span></div>`);
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
  const running = massState && massState.kind === 'transfer' && massState.phase === 'run';
  return transferSet.size >= 1 && !running && c && c !== 'loading' && c.valid && (c.active || transferAck);
}

function transferViewHtml() {
  if (!account || !onRightChain()) return walletGateHtml();
  invFacets = computeInvFacets();
  // Same workbench split as Sell. Recipient input, check rows, send button and status
  // must all stay inside the form — handleTransferSubmit queries them through it.
  const wb = `
    <div class="trade-workbench">
      <div class="trade-wb-main">
        <h4 class="trade-form-h">${esc(t(skey('trade.transfer.h')))} ${tipHtml(skey('trade.transfer.p'))}</h4>
        <span class="trade-field-label">${esc(t(skey('trade.transfer.pick')))}</span>
        <div id="trade-pick-wrap">${transferPickerHtml()}</div>
      </div>
      <div class="trade-wb-side" id="trade-transfer-side">${transferSideHtml()}</div>
    </div>`;
  // Same left filter sidebar + toolbar as Buy, once there's an inventory worth filtering.
  return invHasFilters()
    ? `<section class="trade-browse has-side">${invFilterSideHtml()}<div class="trade-main">${invToolbarHtml()}${wb}</div></section>`
    : wb;
}

// The Transfer action column: a strip of the picked Creatures (any number), one shared
// recipient + safety check, and a count-aware Send button. One item behaves exactly like
// the old single transfer; 2+ runs the batch (one confirmation each). Recipient stays put.
function transferSideHtml() {
  const to = ''; // the input value is preserved by patchTransferSide, not re-seeded here
  const n = transferSet.size;
  const label = n >= 2 ? t('trade.mass.transfer.btn').replace('{n}', String(n)) : t(skey('trade.transfer.btn'));
  return `
    <div id="trade-transfer-selected">${transferSelectedHtml()}</div>
    <form class="trade-form" id="trade-transfer-form" novalidate>
      <label class="trade-field"><span>${esc(t(skey('trade.field.recipient')))}</span>
        <input id="trade-to" type="text" value="${esc(to)}" placeholder="0x…" autocomplete="off" spellcheck="false" /></label>
      <div id="trade-to-check" aria-live="polite">${transferCheckHtml()}</div>
      <button class="trade-send" id="trade-send" type="submit" ${transferSendAllowed() ? '' : 'disabled'}>${esc(label)} <span aria-hidden="true">→</span></button>
      <div class="trade-status" id="trade-status" role="status" aria-live="polite">${massState && massState.kind === 'transfer' ? massStatusHtml() : ''}</div>
    </form>`;
}

// Strip of picked-to-transfer items (thumb + number + remove ×), or a prompt when empty —
// the mirror of the Sell selection card, so it's always clear WHAT is about to be sent.
function transferSelectedHtml() {
  const items = pickedItems(transferSet);
  if (!items.length) {
    return `<div class="trade-sell-selected is-empty">
      <span class="trade-sell-sel-ph" aria-hidden="true">📦</span>
      <p>${esc(t(skey('trade.transfer.selectPrompt')))}</p>
    </div>`;
  }
  const chips = items.map(it => {
    const pet = coll === 'land' ? petUrl(it) : null;
    const src = pet || it.image;
    const fb = pet && it.image ? ` data-fallback="${esc(it.image)}"` : '';
    const art = src ? `<img class="${pet ? 'is-pet' : ''}" src="${esc(src)}"${fb} alt="" loading="lazy" />`
      : `<div class="trade-tile-noimg" aria-hidden="true">${coll === 'land' ? '🗺️' : '🐾'}</div>`;
    const num = esc(it.name.replace(/^Highrise (Creature|LAND) /, ''));
    return `<div class="trade-xfer-chip" title="${esc(it.name)}">
      <div class="trade-xfer-thumb">${art}</div>
      <span class="trade-xfer-num">${num}</span>
      <button type="button" class="trade-xfer-rm" data-act="transfer-pick" data-token="${esc(it.tokenId)}" aria-label="${esc(t('trade.mass.remove'))}" title="${esc(t('trade.mass.remove'))}">×</button>
    </div>`;
  }).join('');
  return `<div class="trade-xfer-selected">
    <div class="trade-xfer-head"><span class="trade-sell-sel-label">${esc(t('trade.mass.transfer.sending').replace('{n}', String(items.length)))}</span>
      <button type="button" class="trade-flt-clearall" data-act="mass-clear">${esc(t('trade.mass.clear'))}</button></div>
    <div class="trade-xfer-chips">${chips}</div>
  </div>`;
}

// Re-render the transfer side (selection strip + recipient form) without rebuilding the
// picker — preserve the typed recipient + its live check across a pick.
function patchTransferSide() {
  const side = root()?.querySelector('#trade-transfer-side');
  if (!side) return;
  const to = side.querySelector('#trade-to')?.value || '';
  side.innerHTML = transferSideHtml();
  const input = side.querySelector('#trade-to');
  if (input && to) input.value = to;
  root()?.querySelectorAll('#trade-pick-wrap .trade-pick-tile').forEach(btn => {
    const on = transferSet.has(String(btn.dataset.token));
    btn.classList.toggle('is-sel', on);
    btn.setAttribute('aria-selected', String(on));
  });
  const bar = root()?.querySelector('#trade-pick-wrap .trade-pick-bar');
  if (bar) bar.outerHTML = pickBarHtml(transferSet);
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
  if (tradeTab === 'sales') return `<div id="trade-view">${salesHtml()}</div>`;
  if (tradeTab === 'profile') return `<section class="trade-profile-view" id="trade-view">${profileViewHtml()}</section>`;
  return `<div id="trade-view">${browseHtml()}</div>`;
}

// --- Multi-select selection (Sell + Transfer share one model) ---
// The picker toggles set membership (Token-Trove-style multi-select); the single derived
// selection powers the unchanged 1-item flows, the set powers the mass panels.
function selSet() { return tradeTab === 'transfer' ? transferSet : sellSet; }
function syncSellSel() { sellSel = sellSet.size === 1 ? [...sellSet][0] : null; }
function syncTransferSel() { transferSel = transferSet.size === 1 ? [...transferSet][0] : null; }
function toggleSellPick(token) {
  if (massState && massState.phase !== 'run') massState = null; // starting fresh clears an old summary
  const k = String(token);
  if (sellSet.has(k)) { sellSet.delete(k); sellPrices.delete(k); } else sellSet.add(k);
  syncSellSel();
}
function toggleTransferPick(token) {
  if (massState && massState.phase !== 'run') massState = null;
  const k = String(token);
  if (transferSet.has(k)) transferSet.delete(k); else transferSet.add(k);
  syncTransferSel();
}
// Select-all / clear over the CURRENTLY FILTERED pickable set (so a trait filter narrows
// what "all" means — pick every Cutesy-mouth Creature, then list them). Toggles: if the
// whole filtered set is already picked, clear it instead.
function massToggleAll() {
  const set = selSet();
  const ids = invFilteredItems().map(o => String(o.tokenId));
  const allOn = ids.length > 0 && ids.every(id => set.has(id));
  if (allOn) ids.forEach(id => set.delete(id));
  else ids.forEach(id => set.add(id));
  tradeTab === 'transfer' ? syncTransferSel() : syncSellSel();
}
function clearSelection() {
  const set = selSet();
  set.clear();
  if (tradeTab !== 'transfer') sellPrices.clear();
  tradeTab === 'transfer' ? syncTransferSel() : syncSellSel();
}
// Picked owned items (excludes anything already listed, same base as the picker), for the
// mass panels. A filter change never drops an already-picked item — membership is the truth.
function pickedItems(set) {
  return invBase().filter(o => set.has(String(o.tokenId)));
}

// The Creature (or parcel) currently picked to list, from the loaded owned set.
function sellSelectedItem() {
  if (sellSel == null || !Array.isArray(owned)) return null;
  return owned.find(o => String(o.tokenId) === String(sellSel)) || null;
}

// A confirmation card pinned at the TOP of the "List for sale" column: the picked
// Creature's thumbnail + number, so it's always unmistakable which one you're listing
// (picking a tile no longer scrolls the picker away — see patchSellSide). Empty
// state prompts the pick so the card is never a blank box.
function sellSelectedHtml() {
  const it = sellSelectedItem();
  if (!it) {
    return `<div class="trade-sell-selected is-empty">
      <span class="trade-sell-sel-ph" aria-hidden="true">🎯</span>
      <p>${esc(t(skey('trade.sell.selectPrompt')))}</p>
    </div>`;
  }
  const pet = coll === 'land' ? petUrl(it) : null;
  const src = pet || it.image;
  const fallback = pet && it.image ? ` data-fallback="${esc(it.image)}"` : '';
  const img = src
    ? `<img class="${pet ? 'is-pet' : ''}" src="${esc(src)}"${fallback} alt="" loading="lazy" />`
    : `<div class="trade-tile-noimg" aria-hidden="true">${coll === 'land' ? '🗺️' : '🐾'}</div>`;
  const rarity = it.rarity || (it.traits && (it.traits.Rarity || it.traits.rarity)) || null;
  return `<div class="trade-sell-selected">
    <div class="trade-sell-sel-media">${img}</div>
    <div class="trade-sell-sel-info">
      <span class="trade-sell-sel-label">${esc(t(skey('trade.sell.selected')))}</span>
      <span class="trade-sell-sel-name">${esc(it.name)}</span>
      <div class="trade-sell-sel-tags">${rarityChip(rarity)}${rankChip(it.rank)}</div>
    </div>
    <button type="button" class="trade-sell-sel-clear" data-act="sell-pick" data-token="${esc(it.tokenId)}"
      aria-label="${esc(t('trade.sell.deselect'))}" title="${esc(t('trade.sell.deselect'))}">×</button>
  </div>`;
}

// Patch only the instant-sell block (single mode) — used when a picked token's offers
// arrive async, so a price the user is mid-typing in the same column is never wiped.
function patchSellInstant() {
  if (tradeTab !== 'sell') return;
  const el = root()?.querySelector('#trade-sell-instant');
  if (el) el.innerHTML = coll === 'land' ? landInstantSellHtml() : instantSellHtml();
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

// Resolve the typed price into the {currency, price} the sell endpoints expect. USDC is
// entered directly in dollars; ETH runs through the ETH/fiat unit conversion.
function sellPricePayload(raw) {
  if (sellCurrency === 'usdc') {
    const s = String(raw || '').trim().replace(',', '.');
    if (!/^\d{1,9}(\.\d{1,6})?$/.test(s) || !(parseFloat(s) > 0)) return { ok: false, msg: t('trade.err.badPrice') };
    return { ok: true, currency: 'usdc', price: s };
  }
  const conv = sellPriceToEth(raw);
  return conv.ok ? { ok: true, currency: 'eth', price: conv.eth } : conv;
}

async function handleSell(form) {
  if (sellState && SELL_BUSY_PHASES.has(sellState.phase)) return;
  if (coll === 'land') return handleSellLand(form);
  if (!sellSel) return setSell('error', { msg: t('trade.err.noSel') });
  const pay = sellPricePayload(form.querySelector('#trade-sell-price').value);
  if (!pay.ok) return setSell('error', { msg: pay.msg });

  try {
    setSell('prepare');
    const res = await fetch('/api/market/creatures/sell/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, tokenId: sellSel, currency: pay.currency, price: pay.price }),
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
    if (sellSel != null) { sellSet.delete(String(sellSel)); sellPrices.delete(String(sellSel)); syncSellSel(); }
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
  const pay = sellPricePayload(form.querySelector('#trade-sell-price').value);
  if (!pay.ok) return setSell('error', { msg: pay.msg });

  try {
    setSell('prepare');
    await switchToChain('0x1'); // sign + approve happen on mainnet (no-op if already there)
    const res = await fetch('/api/market/land/sell/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, tokenId: sellSel, currency: pay.currency, price: pay.price, durationDays }),
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
    if (sellSel != null) { sellSet.delete(String(sellSel)); sellPrices.delete(String(sellSel)); syncSellSel(); }
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

// --- Mass listing / mass transfer (Token-Trove-style batch ops) -------------------------
// Both are inherently sequential: each ERC-721 listing is its own gasless signature and each
// transfer its own on-chain tx, so we run one after another with live progress. Partial
// success is first-class — a rejection or a single failure never loses the rest.
const isUserReject = err => err?.code === 4001 || /user (rejected|denied)/i.test(err?.message || '');

// List ONE token — the per-item core the mass loop drives. On Creatures the first item may
// carry the one-time collection approval (needs IMX gas); every later item is just a
// signature. Currency ('eth'|'usdc') + native price flow to the same endpoints the single
// sell uses. Throws on failure (with `.friendly`), `.gas` on IMX shortfall, or 4001 on reject.
async function listOne(tokenId, currency, price, durationDays) {
  const isLand = coll === 'land';
  if (isLand) await switchToChain('0x1');
  const res = await fetch(isLand ? '/api/market/land/sell/prepare' : '/api/market/creatures/sell/prepare', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(isLand
      ? { makerAddress: account, tokenId, currency, price, durationDays }
      : { makerAddress: account, tokenId, currency, price }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(sellServerError(data.error)), { friendly: sellServerError(data.error) });
  let signature = null;
  for (const action of (data.actions || [])) {
    if (action.type === 'TRANSACTION') { // one-time collection approval
      if (!isLand) { const imxBal = await readNative(account); if (imxBal != null && imxBal < GAS_MIN_WEI) throw Object.assign(new Error('gas'), { gas: true }); }
      const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to: action.to, data: action.data, value: action.value && action.value !== '0x0' ? action.value : undefined }] });
      const receipt = await waitForReceipt(hash);
      if (!receipt || receipt.status !== '0x1') throw new Error(t('trade.err.txFailed'));
    } else if (action.type === 'SIGNABLE') {
      signature = await signTypedData(action.typedData);
    }
  }
  if (!signature) throw new Error(t('trade.err.unavailable'));
  const createRes = await fetch(isLand ? '/api/market/land/sell/create' : '/api/market/creatures/sell/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(isLand ? { orderParameters: data.orderParameters, signature } : { orderComponents: data.orderComponents, orderHash: data.orderHash, signature }),
  });
  const created = await createRes.json().catch(() => ({}));
  if (!createRes.ok) throw Object.assign(new Error(sellServerError(created.error)), { friendly: sellServerError(created.error) });
}

async function handleMassSell() {
  if (massState && massState.phase === 'run') return;
  const items = pickedItems(sellSet);
  // Every picked item needs a valid price (in the chosen currency) before we open the wallet.
  const jobs = [];
  for (const it of items) {
    const pay = sellPricePayload(sellPrices.get(String(it.tokenId)) || '');
    if (!pay.ok) { massState = { kind: 'sell', total: items.length, i: 0, ok: 0, failed: [], phase: 'error', msg: t('trade.mass.sell.needPrices') }; patchMassStatus(); return; }
    jobs.push({ tokenId: String(it.tokenId), currency: pay.currency, price: pay.price });
  }
  const durationDays = Number(root()?.querySelector('#trade-sell-duration')?.value) || 7;
  massState = { kind: 'sell', total: jobs.length, i: 0, ok: 0, failed: [], phase: 'run' };
  patchMassStatus();
  for (const job of jobs) {
    massState.i++; patchMassStatus();
    try {
      await listOne(job.tokenId, job.currency, job.price, durationDays);
      sellSet.delete(job.tokenId); sellPrices.delete(job.tokenId);
      massState.ok++; patchMassStatus();
    } catch (err) {
      if (isUserReject(err)) break; // stop the run; keep the rest picked so they can resume
      if (err?.gas) { massState = null; showGasHelp('sell'); patchSellSide(); return; }
      console.error('Mass list failed for', job.tokenId, err);
      massState.failed.push(job.tokenId); patchMassStatus();
    }
  }
  massState.phase = 'done'; patchMassStatus();
  syncSellSel();
  refreshAfterTx();
  patchSellSide(); // reflect the shrunken selection; the summary survives (massState persists)
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

// Write batch-transfer progress into the transfer form's status slot (without touching the
// recipient input), and keep the Send button disabled while a run is in flight.
function patchTransferStatus() {
  const el = root()?.querySelector('#trade-transfer-form #trade-status');
  if (el) el.innerHTML = massStatusHtml();
  const btn = root()?.querySelector('#trade-send');
  if (btn) btn.disabled = !transferSendAllowed();
}

// Transfer the picked Creatures/parcels to ONE recipient. Unifies single + mass: one item
// behaves exactly like the old single transfer (one confirmation), 2+ runs sequentially with
// progress. Each is its own on-chain tx; a rejection or failure keeps the rest picked.
async function handleMassTransfer(form) {
  if (massState && massState.kind === 'transfer' && massState.phase === 'run') return;
  const to = (form.querySelector('#trade-to').value || '').trim().toLowerCase();
  const setError = msg => { massState = { kind: 'transfer', total: 0, i: 0, ok: 0, failed: [], phase: 'error', msg }; patchTransferStatus(); };
  // Belt and braces — the button is disabled unless these hold, but state can race.
  if (!transferSet.size)  return setError(t(skey('trade.err.noTransferSel')));
  if (!IS_ADDR.test(to))  return setError(t('trade.err.badAddr'));
  if (to === account)     return setError(t('trade.err.self'));
  if (to === ZERO)        return setError(t('trade.err.zero'));
  if (!transferSendAllowed() || transferCheck?.addr?.toLowerCase() !== to) return setError(t('trade.err.badAddr'));

  const items = pickedItems(transferSet).map(o => String(o.tokenId));
  massState = { kind: 'transfer', total: items.length, i: 0, ok: 0, failed: [], phase: 'run' };
  patchTransferStatus();
  try {
    await switchToChain(C().chainHex); // ownerOf + transfer both read/write via the wallet
  } catch (err) { setError(friendlyError(err)); return; }
  // On zkEVM a transfer burns native IMX for gas — one guided top-up up front beats N cryptic
  // MetaMask "not enough IMX" popups mid-batch. (LAND settles on mainnet ETH — separate path.)
  if (coll === 'creatures') {
    const imxBal = await readNative(account);
    if (imxBal != null && imxBal < GAS_MIN_WEI) { massState = null; showGasHelp('transfer'); return; }
  }
  for (const tokenId of items) {
    massState.i++; patchTransferStatus();
    try {
      const owner = await ownerOf(C().contract, tokenId);
      if (owner !== account) { massState.failed.push(tokenId); patchTransferStatus(); continue; }
      const hash = await sendTransfer(C().contract, tokenId, to);
      await waitForReceipt(hash);
      transferSet.delete(tokenId);
      dropPendingOwned(tokenId);
      massState.ok++; patchTransferStatus();
    } catch (err) {
      if (isUserReject(err)) break; // stop; keep the rest picked so they can resume
      console.error('Mass transfer failed for', tokenId, err);
      massState.failed.push(tokenId); patchTransferStatus();
    }
  }
  massState.phase = 'done';
  syncTransferSel();
  refreshAfterTx();
  patchTransferSide(); // strip shrinks to what's left; the summary survives (massStatusHtml)
}

// Last-known wallet-bar balances per account+collection — re-renders seed from this
// instead of flashing '—' while the fresh async reads run.
const balCache = new Map(); // `${account}|${coll}` -> { count, eth, imx }

async function refreshBalance() {
  const el = root()?.querySelector('#trade-bal');
  if (!el) return;
  const key = `${account}|${coll}`; // drop stale writes if the user moved on mid-read
  if (coll === 'land') {
    const count = Array.isArray(owned) ? String(owned.length) : '—';
    el.textContent = count;
    let ethTxt = null;
    // On mainnet, read straight from the wallet (authoritative — matches MetaMask exactly).
    // Off mainnet, fall back to the server (it can read mainnet whatever chain the wallet
    // sits on). A third-party RPC can lag a recent top-up, so prefer the wallet when we can.
    if (onRightChain()) {
      ethTxt = fmtWeiEth(await readNative(account));
    } else {
      try {
        const ee = await fetch(`/api/market/creatures/eth-elsewhere/${account}`).then(r => r.ok ? r.json() : null);
        ethTxt = ee?.mainnetEthWei != null ? fmtWeiEth(BigInt(ee.mainnetEthWei)) : '—';
      } catch { /* leave em-dash */ }
    }
    if (key !== `${account}|${coll}`) return;
    const ethEl = root()?.querySelector('#trade-bal-eth');
    if (ethEl && ethTxt != null) ethEl.textContent = ethTxt;
    balCache.set(key, { count, eth: ethTxt ?? balCache.get(key)?.eth });
    return;
  }
  const [bal, zkEth, imx] = await Promise.all([readBalance(), readErc20(IMX_ETH_TOKEN, account), readNative(account)]);
  if (key !== `${account}|${coll}`) return;
  const count = bal == null ? '—' : String(bal);
  const ethTxt = fmtWeiEth(zkEth);
  const imxTxt = fmtWeiEth(imx);
  el.textContent = count;
  const ethEl = root()?.querySelector('#trade-bal-eth');
  if (ethEl) ethEl.textContent = ethTxt;
  const imxEl = root()?.querySelector('#trade-bal-imx');
  if (imxEl) imxEl.textContent = imxTxt;
  balCache.set(key, { count, eth: ethTxt, imx: imxTxt });
}

// --- Render + events ---
function render() {
  const el = root();
  if (!el) return;
  el.setAttribute('aria-busy', 'false');
  // Command bar, two deliberate tiers so it never wraps awkwardly: the top row pairs the
  // collection switcher (left) with the wallet bar (right) — context + identity on opposite
  // ends — and the action tabs (+ safety pill) sit on their own row below, with the
  // holder-profile pill anchored at that row's far right (it opens the in-view profile).
  el.innerHTML = `${flashBanner()}
    <div class="trade-command">
      <div class="trade-command-top">${collSwitcherHtml()}${walletBarHtml()}</div>
      <div class="trade-command-nav">${tradeTabsHtml()}${profileNavPillHtml()}</div>
    </div>
    <div id="trade-mmwarn-slot">${walletNoticeHtml()}</div>
    <div id="trade-bridgebar-slot">${bridgeBannerHtml()}</div>
    ${viewHtml()}${modalHtml()}${safetyHtml()}<div id="trade-confirm-slot">${confirmAcceptHtml()}</div><div id="trade-cashout-slot">${cashoutHtml()}</div><div id="trade-topup-slot">${topupHtml()}</div>`;
  ensureDelegation();
  if (account && (coll === 'land' || onZk())) {
    refreshBalance();
    maybeLoadSeller();
    if (coll === 'creatures' && myOffers === null) loadMyOffers();
    else if (coll === 'land' && landMyOffers === null) loadLandMyOffers();
  }
  // History is read-only by address — load it even when the wallet isn't on the right chain.
  if (account && tradeTab === 'history') maybeLoadHistory();
  // Sales History is public — no wallet needed. Load it the first time the tab is shown.
  if (tradeTab === 'sales') maybeLoadSales();
  // The holder-profile pill shows on every tab, so fetch the Discord session state once.
  wireProfileEvents();
  fetchMeForProfile();
  // The profile view's showcase renders itself into #profile-app (js/profile.js);
  // repeat renders with the same slug reuse its cached state. The command bar's
  // collection switcher is the ONLY switcher — the profile grid mirrors it via `coll`.
  if (tradeTab === 'profile' && profileViewSlug) loadProfile(profileViewSlug, { coll });
  if (hpScrollPending && tradeTab === 'profile') {
    hpScrollPending = false;
    el.querySelector('.trade-command')?.scrollIntoView({ block: 'start' });
  }
}

// Copy a full value (owner wallet, token id) to the clipboard and flash "Copied!" on
// the button. Prefers the async Clipboard API; falls back to a throwaway textarea +
// execCommand for older/insecure contexts. No re-render — that would drop the flash.
let copyFlashTimer = null;
async function copyValue(btn) {
  const value = btn?.dataset?.copy;
  if (!value) return;
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
  if (!ok) return;
  document.querySelectorAll('.trade-copy.is-copied').forEach(b => b.classList.remove('is-copied'));
  btn.classList.add('is-copied');
  clearTimeout(copyFlashTimer);
  copyFlashTimer = setTimeout(() => btn.classList.remove('is-copied'), 1400);
}

function onClick(e) {
  const target = e.target.closest('[data-act]');
  if (!target) return;
  switch (target.dataset.act) {
    case 'open':       return openModal(target.dataset.token);
    case 'close':      return closeModal();
    case 'copy':       return copyValue(target);
    case 'buy':        return handleBuy(target.dataset.listing);
    case 'trade-tab':
      if (tradeTab === target.dataset.tab) return;
      // Leaving the profile view: its URL is /profile/{slug} — step back to /trade so
      // the address bar matches the browse content again.
      if (tradeTab === 'profile') {
        profileViewSlug = null;
        if (location.pathname.startsWith('/profile')) history.pushState(null, '', '/trade');
      }
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
      toggleSellPick(target.dataset.token); // multi-select: toggle membership
      sellState = null;
      sellPickOffers = null;
      // Instant-sell-into-offers is a single-item action, Creatures-only.
      if (sellSel != null && coll === 'creatures') fetchSellPickOffers(sellSel);
      // Targeted patch (NOT a full re-render) so the picker's scroll position survives —
      // the side panel shows the selection card (1) or the mass-list panel (2+).
      return patchSellSide();
    case 'transfer-pick':
      toggleTransferPick(target.dataset.token);
      return patchTransferSide();
    case 'mass-all':
      massToggleAll();
      return tradeTab === 'transfer' ? patchTransferSide() : patchSellSide();
    case 'mass-clear':
      clearSelection();
      return tradeTab === 'transfer' ? patchTransferSide() : patchSellSide();
    case 'sell-cur':
      if (sellCurrency === target.dataset.cur) return;
      sellCurrency = target.dataset.cur === 'usdc' ? 'usdc' : 'eth';
      return patchSellSide(); // re-render the price row (unit picker vs fixed USDC)
    case 'offer-cur': {
      const next = target.dataset.cur === 'usdc' ? 'usdc' : 'eth';
      if (offerCurrency === next) return;
      offerCurrency = next;
      // Re-render whichever offer surface is showing (modal token-offer, Creature strip, LAND strip).
      if (modalToken) patchModal();
      if (coll === 'land') patchLandOfferStrip(); else patchCollStrip();
      return;
    }
    case 'mass-apply-all': {
      const v = (root()?.querySelector('#trade-mass-all-price')?.value || '').trim();
      if (!v) return;
      pickedItems(sellSet).forEach(it => sellPrices.set(String(it.tokenId), v));
      return patchSellSide(); // rows re-read their value from sellPrices
    }
    case 'hp-open':        return openProfileView(meState?.holderProfile?.enabled ? meState.holderProfile.slug : null);
    case 'open-profile':   return openProfileView(target.dataset.slug);
    case 'hp-wallets':     hpWalletsOpen = !hpWalletsOpen; hpLinkError = null; return patchProfileCard();
    case 'hp-enable':      return setHolderProfile(true);
    case 'hp-disable':     return setHolderProfile(false);
    case 'hp-link':        return linkConnectedWallet();
    case 'hp-unlink':      return unlinkProfileWallet(target.dataset.wallet);
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
    case 'cashout-open':
      cashoutOpen = true; cashoutStep = 'intent';
      topupOpen = false; patchTopup(); // one wallet modal at a time
      return patchCashout();
    case 'cashout-guide':  cashoutStep = 'guide'; return patchCashout();
    case 'cashout-move':   return openCashoutMove();
    case 'cashout-max':    return cashoutMaxClick();
    case 'cashout-now':    return runCashout();
    case 'add-eth-mainnet': return showEthOnMainnet();
    case 'cashout-back':
      cashoutStep = 'intent'; cashoutState = null; clearTimeout(cashoutQuoteTimer);
      return patchCashout();
    case 'cashout-close':
      cashoutOpen = false; cashoutState = null; clearTimeout(cashoutQuoteTimer);
      return patchCashout();
    case 'topup-open':     return openTopup();
    case 'topup-eth':
      if (topupState) { topupState.err = null; topupState.quote = null; }
      topupStep = 'eth';
      return patchTopup();
    case 'topup-gas':      return openTopupGas();
    case 'topup-max':      return topupMaxClick();
    case 'topup-now':      return runTopupEth();
    case 'topup-gas-now':  return runTopupGas();
    case 'topup-back':
      topupStep = 'intent'; clearTimeout(topupQuoteTimer);
      if (topupState) { topupState.err = null; topupState.quote = null; topupState.gasQuote = null; }
      return patchTopup();
    case 'topup-close':
      topupOpen = false; topupState = null; clearTimeout(topupQuoteTimer);
      return patchTopup();
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
    case 'sales-loadmore': return loadSales(false);
    case 'sales-retry':    salesItems = null; salesError = false; return loadSales(true);
    case 'sales-refresh':  salesItems = null; salesError = false; return loadSales(true);
    case 'sale-open':      return openDeepLink(target.dataset.token, { knownListed: target.dataset.listed === '1' });
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
  if (e.target?.id === 'trade-transfer-form') { e.preventDefault(); handleMassTransfer(e.target); }
  if (e.target?.id === 'trade-sell-form')      { e.preventDefault(); handleSell(e.target); }
  if (e.target?.id === 'trade-mass-sell-form') { e.preventDefault(); handleMassSell(); }
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
  if (e.target?.id === 'sales-sort') {
    salesSort = e.target.value;
    return loadSales(true);
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
    // Mass panel has no single #trade-sell-price — re-render so every row's unit label +
    // placeholder + the running total pick up the new unit (typed amounts stay as entered).
    if (sellSet.size >= 2) { patchSellSide(); return; }
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
  patchSalesGrid(); // re-render sale prices in the newly picked currency (no-op off the Sales tab)
  if (modalToken) patchModal();
}
function onInput(e) {
  if (e.target?.id === 'trade-to') return queueTransferCheck(e.target.value);
  if (e.target?.id === 'trade-cashout-amt') {
    if (cashoutState) { cashoutState.amount = e.target.value; queueCashoutQuote(); }
    return;
  }
  if (e.target?.id === 'trade-topup-amt') {
    if (topupState) { topupState.amount = e.target.value; queueTopupQuote(); }
    return;
  }
  if (e.target?.id === 'inv-q') {
    invFlt.q = e.target.value.trim();
    return patchInvFilter(); // patches facets/chips/picker, not the input — focus survives
  }
  if (e.target?.id === 'trade-sell-price') {
    if (sellSel != null) sellPrices.set(String(sellSel), e.target.value); // survive re-renders
    const convEl = root()?.querySelector('#trade-price-conv');
    if (convEl) convEl.textContent = sellCurrency === 'usdc' ? '' : sellConvHtml(e.target.value); // USDC = dollars, no conversion
    const net = root()?.querySelector('#trade-sell-net'); // LAND only — element absent for Creatures
    if (net) net.innerHTML = landSellNetHtml(sellEthFromInput(e.target.value));
    return;
  }
  // Per-item price on a mass-list row: store it and refresh only the running total + button
  // (never the inputs — focus/caret survive typing).
  if (e.target?.classList?.contains('trade-mass-price-in')) {
    sellPrices.set(String(e.target.dataset.token), e.target.value);
    const totalEl = root()?.querySelector('#trade-sell-side .trade-mass-total');
    const total = massSellTotal();
    if (totalEl) totalEl.innerHTML = massTotalLineHtml(total);
    const btn = root()?.querySelector('#trade-mass-submit');
    if (btn) btn.disabled = !!(massState && massState.phase === 'run') || total <= 0;
    return;
  }
  if (e.target?.id === 'trade-offer-price' || e.target?.id === 'trade-coll-offer-price') {
    const convId = e.target.id === 'trade-coll-offer-price' ? '#trade-coll-offer-conv' : '#trade-offer-conv';
    const convEl = root()?.querySelector(convId);
    if (convEl) convEl.textContent = offerCurrency === 'usdc' ? '' : offerConvHtml(e.target.value); // USDC = dollars, no conversion
    return;
  }
  if (e.target?.id === 'flt-q') {
    const v = e.target.value.trim();
    const nowWallet = isWalletQuery(v);
    // Entering a wallet address shows its FULL holdings (listed + unlisted), so switch to
    // the "All" scope. Apply at once when it's a complete address (the view flip should feel
    // instant); debounce ordinary name/number typing so every keystroke isn't a request.
    if (nowWallet && !isWalletQuery(flt.q) && flt.scope !== 'all') flt.scope = 'all';
    flt.q = v;
    return applyFilters(nowWallet ? 0 : 300);
  }
  if (e.target?.id === 'flt-min' || e.target?.id === 'flt-max') {
    const v = e.target.value.trim().replace(',', '.');
    if (v === '' || /^\d*\.?\d*$/.test(v)) flt[e.target.id === 'flt-min' ? 'min' : 'max'] = v;
    return applyFilters(400);
  }
}
function resetSellerState() {
  owned = null; mine = null; sellSel = null; sellState = null; cancelBusy = null;
  sellSet.clear(); transferSet.clear(); sellPrices.clear(); massState = null; // drop any selection/batch
  sellCurrency = 'eth'; // LAND has no USDC path yet; also a clean default per collection
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
    if (topupOpen) { topupOpen = false; patchTopup(); return; }
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
  p.on?.('chainChanged', cid => {
    const c = String(cid || '').toLowerCase();
    chainId = c;
    // The echo of a switch WE initiated: the initiating flow patches the affected bits
    // itself — skip the full re-render (and don't wipe the seller loads it just started).
    if (expectedChainHex === c) { expectedChainHex = null; patchWalletBar(); return; }
    resetSellerState();
    render();
  });
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
