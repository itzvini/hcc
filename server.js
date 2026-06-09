const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Load .env into process.env if present, so the OpenSea key works no matter how the
// server is launched (node server.js, npm start, IDE). No-op in production, where
// Railway injects real env vars and there is no .env file.
try { process.loadEnvFile(); } catch { /* no .env — fine */ }

const db = require('./lib/db');
const auth = require('./lib/auth');
const { computeEligibility, BRACKETS } = require('./lib/eligibility');
const { PROPOSITIONS, PROPOSITION_IDS } = require('./lib/propositions');
const derive = require('./lib/derive-positions');

// Treat common truthy spellings (1/true/yes/on, case- and whitespace-insensitive) as
// "on", so a minor env value doesn't silently leave a flag off. Used for APPLICATIONS_OPEN.
const envFlag = v => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

db.init()
  .then(() => db.recordEvent({ event: 'system.startup', detail: { applicationsOpen: envFlag(process.env.APPLICATIONS_OPEN), usingPostgres: db.usingPostgres } }))
  .catch(err => console.error('DB init failed:', err.message));

// Optional local dev-login helper for testing eligibility screens without a real
// wallet. The active file (lib/dev-login.js) is gitignored, so it is ABSENT from
// the deployed build — the auth bypass cannot exist in production regardless of env
// vars. See lib/dev-login.example.js for how to enable it locally.
let devLogin = null;
try { devLogin = require('./lib/dev-login.js'); } catch { /* not present — normal in production */ }
if (devLogin) console.warn('[dev] lib/dev-login.js loaded — /api/auth/dev-login active locally. Never commit or deploy this file.');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';

// --- Holder stats ---
const CREATURE_HOLDERS_URL    = 'https://explorer.immutable.com/api/v2/tokens/0xCf44b1cBC959295bbBb49935B1b339cC0AA77cdA/holders';
const LAND_HOLDERS_URL        = 'https://eth.blockscout.com/api/v2/tokens/0x8bf3a40ea2337e6e4f6e540680ea6390cb3b4e11/holders';
const HOLDER_CACHE_TTL_MS     = 30 * 60 * 1000;
const DIST_THRESHOLDS         = [1, 2, 5, 10]; // bucket breakpoints

// Highrise ESTATE: minting an estate locks N LAND parcels INTO this contract and issues
// one ERC-721 back, so those parcels leave the owner's wallet — on-chain the estate
// contract is the LAND holder, not the user. Without crediting estates, every estate
// owner reads as holding 0 LAND. We credit each estate's parcel count back to its
// current owner below (see fetchEstateLandCredits). Estates are immutable once minted
// (the contract only mints a whole estate from parcels or burns it — no add/remove), so
// an estate's LAND count is exactly its EstateMinted parcels[] length.
//
// Ownership is read straight from the contract (totalSupply/tokenByIndex/ownerOf) rather
// than Blockscout's /holders or /instances: those are balance-derived and over-report
// for this contract (they keep burned/transferred-out estates), which would credit LAND
// to wallets that no longer hold an estate. Event logs (EstateMinted) ARE reliable.
const ESTATE_CONTRACT         = '0x8dcbcafacfdc935d084dc19983194509813da6bd';
const ESTATE_LOGS_URL         = `https://eth.blockscout.com/api/v2/addresses/${ESTATE_CONTRACT}/logs`;
// topic0 of EstateMinted(uint256,address,uint32[]) — filters the contract's log feed to
// just mints (≈2 pages) instead of its full Transfer/Approval/role history.
const ESTATE_MINTED_TOPIC     = '0x61e22a5856592b5587565bc3f94edb44458e1a8cf97705c0450802385188a753';
// ERC-721 read selectors used to enumerate live estates + their owners on-chain.
const SEL_TOTAL_SUPPLY        = '0x18160ddd'; // totalSupply()
const SEL_TOKEN_BY_INDEX      = '0x4f6ccce7'; // tokenByIndex(uint256)
const SEL_OWNER_OF            = '0x6352211e'; // ownerOf(uint256)
const ETH_RPC_URL             = process.env.ETH_RPC_URL || 'https://eth.blockscout.com/api/eth-rpc';
const ZK_RPC_URL              = process.env.ZK_RPC_URL || 'https://rpc.immutable.com'; // Immutable zkEVM (Creatures)
// Read selectors for the authoritative per-wallet eligibility lookup (see getWalletHoldings).
const SEL_BALANCE_OF          = '0x70a08231'; // balanceOf(address)
const SEL_OWNER_TOKENS        = '0xbba7723e'; // ownerTokens(address) -> uint256[]
const SEL_ESTATES_TO_PARCELS  = '0x3890889f'; // estatesToParcels(uint256,uint256) -> uint256
const ZERO_ADDRESS            = '0x0000000000000000000000000000000000000000';

const holderCache    = { data: null, fetchedAt: 0, inFlight: null };
const fetchProgress  = { phase: 'idle', creaturePages: 0, landPages: 0 };
// Raw per-address counts from the latest successful fetch, kept so the Council
// eligibility check can look up a single wallet without re-querying the chain.
const holderCounts   = { creature: new Map(), land: new Map(), fetchedAt: 0 };

// Fetch all pages from any Blockscout-style /holders endpoint.
// Returns Map<lowercaseAddress, nftCount>.
// onPage() is called after each page is received.
async function fetchHolderCounts(baseUrl, onPage) {
  const counts = new Map();
  let pageParams = null;

  do {
    const url = new URL(baseUrl);
    if (pageParams) {
      for (const [k, v] of Object.entries(pageParams)) url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Blockscout API ${res.status} for ${baseUrl}`);
    const body = await res.json();
    for (const item of (body.items ?? [])) {
      const addr = item.address?.hash;
      if (typeof addr === 'string') counts.set(addr.toLowerCase(), Number(item.value) || 1);
    }
    if (onPage) onPage();
    pageParams = body.next_page_params ?? null;
  } while (pageParams);

  return counts;
}

// Page through a Blockscout v2 list endpoint, invoking onBody(body) per page and
// following next_page_params until exhausted. `extraParams` are reapplied each page.
async function fetchBlockscoutPages(baseUrl, onBody, extraParams = {}) {
  let pageParams = null;
  do {
    const url = new URL(baseUrl);
    for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
    if (pageParams) for (const [k, v] of Object.entries(pageParams)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Blockscout API ${res.status} for ${baseUrl}`);
    const body = await res.json();
    onBody(body);
    pageParams = body.next_page_params ?? null;
  } while (pageParams);
}

// Minimal eth_call against the given chain RPC. `data` is the ABI-encoded calldata;
// returns the raw hex result (throws on transport/RPC/revert so callers can degrade).
async function ethCall(rpcUrl, to, data) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`eth_call HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`eth_call: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

const padUint = n => BigInt(n).toString(16).padStart(64, '0'); // uint256 arg → 32-byte word

// Mask a wallet for logs — never write a full holder address to the server log.
const maskWallet = a => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : '(addr)');

// Authoritative [{ estateId, owner }] for every live (non-burned) estate, read from the
// contract: totalSupply() → tokenByIndex(i) → ownerOf(id). See the ESTATE_CONTRACT note.
async function fetchLiveEstateOwners() {
  const total = parseInt(await ethCall(ETH_RPC_URL, ESTATE_CONTRACT, SEL_TOTAL_SUPPLY), 16);
  if (!Number.isFinite(total) || total <= 0) return [];
  const idxs = Array.from({ length: total }, (_, i) => i);
  const estateIds = await Promise.all(idxs.map(async i =>
    BigInt(await ethCall(ETH_RPC_URL, ESTATE_CONTRACT, SEL_TOKEN_BY_INDEX + padUint(i))).toString()));
  const owners = await Promise.all(estateIds.map(async id =>
    ('0x' + (await ethCall(ETH_RPC_URL, ESTATE_CONTRACT, SEL_OWNER_OF + padUint(id))).slice(-40)).toLowerCase()));
  return estateIds.map((estateId, i) => ({ estateId, owner: owners[i] }));
}

// Map<ownerAddress(lowercase), lockedParcelCount>: for every live estate, the number of
// LAND parcels it locks, attributed to its current owner. See the ESTATE_CONTRACT note.
// Parcel counts come from decoded EstateMinted logs; ownership comes from the contract.
async function fetchEstateLandCredits() {
  // Parcel count per estate id. The log feed is newest-first, so the first entry seen
  // for an id is its current mint (an id is only ever re-minted after a burn).
  const parcelsByEstate = new Map();
  await fetchBlockscoutPages(ESTATE_LOGS_URL, body => {
    for (const log of (body.items ?? [])) {
      const dec = log.decoded;
      if (!dec || !String(dec.method_call || '').startsWith('EstateMinted')) continue;
      const params = dec.parameters ?? [];
      const id = params.find(p => p.type === 'uint256')?.value;
      const parcels = params.find(p => String(p.type || '').endsWith('[]'))?.value;
      const estateId = id != null ? String(id) : null;
      if (estateId == null || parcelsByEstate.has(estateId)) continue;
      parcelsByEstate.set(estateId, Array.isArray(parcels) ? parcels.length : 0);
    }
  }, { topic: ESTATE_MINTED_TOPIC });

  const credits = new Map();
  for (const { estateId, owner } of await fetchLiveEstateOwners()) {
    if (owner === ZERO_ADDRESS) continue;
    const count = parcelsByEstate.get(estateId);
    if (count == null) { console.warn(`Estate ${estateId} live but has no EstateMinted parcel count`); continue; }
    if (count > 0) credits.set(owner, (credits.get(owner) || 0) + count);
  }
  return credits;
}

function computeDistribution(countMap) {
  const sorted = [...DIST_THRESHOLDS].sort((a, b) => a - b);
  const buckets = sorted.map((t, i) => ({
    min: t,
    max: i < sorted.length - 1 ? sorted[i + 1] - 1 : Infinity,
    count: 0,
  }));
  for (const n of countMap.values()) {
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (n >= buckets[i].min) { buckets[i].count++; break; }
    }
  }
  return buckets.map(b => ({
    label: b.max === Infinity ? `${b.min}+` : b.min === b.max ? `${b.min}` : `${b.min}–${b.max}`,
    count: b.count,
  }));
}

async function computeHolderStats() {
  fetchProgress.phase = 'fetching';
  fetchProgress.creaturePages = 0;
  fetchProgress.landPages = 0;

  const [creatureCounts, landCounts, estateCredits] = await Promise.all([
    fetchHolderCounts(CREATURE_HOLDERS_URL, () => fetchProgress.creaturePages++),
    fetchHolderCounts(LAND_HOLDERS_URL,     () => fetchProgress.landPages++),
    // Non-fatal: a failed estate lookup just leaves estate-locked LAND uncredited
    // (and the phantom contract holding removed below), rather than failing the snapshot.
    fetchEstateLandCredits().catch(err => { console.error('Estate land credits failed:', err.message); return new Map(); }),
  ]);

  fetchProgress.phase = 'computing';

  // LANDs locked inside an estate are held on-chain by the estate contract, not their
  // owner. Drop that phantom contract holding, then credit each estate's parcels back to
  // its real owner — so estate holders count as LAND holders for eligibility and stats.
  landCounts.delete(ESTATE_CONTRACT);
  for (const [owner, parcels] of estateCredits) {
    landCounts.set(owner, (landCounts.get(owner) || 0) + parcels);
  }

  // Combined: total HCC assets per wallet (creature + land)
  const combinedCounts = new Map(creatureCounts);
  for (const [addr, count] of landCounts) {
    combinedCounts.set(addr, (combinedCounts.get(addr) || 0) + count);
  }

  let both = 0;
  for (const addr of creatureCounts.keys()) {
    if (landCounts.has(addr)) both++;
  }

  // Retain the raw maps for single-wallet eligibility lookups.
  holderCounts.creature = creatureCounts;
  holderCounts.land = landCounts;
  holderCounts.fetchedAt = Date.now();

  return {
    creaturesOnly: creatureCounts.size - both,
    landOnly: landCounts.size - both,
    both,
    totalUniqueHolders: combinedCounts.size,
    totalCreatureHolders: creatureCounts.size,
    totalLandHolders: landCounts.size,
    creatureDistribution: computeDistribution(creatureCounts),
    landDistribution: computeDistribution(landCounts),
    combinedDistribution: computeDistribution(combinedCounts),
    stale: false,
    lastFetched: new Date().toISOString(),
  };
}

function getHolderStats() {
  const now = Date.now();
  const isFresh = holderCache.data && (now - holderCache.fetchedAt) < HOLDER_CACHE_TTL_MS;
  if (isFresh) return Promise.resolve(holderCache.data);

  // Kick off background refresh if not already running
  if (!holderCache.inFlight) {
    holderCache.inFlight = computeHolderStats()
      .then(data => {
        holderCache.data = data;
        holderCache.fetchedAt = Date.now();
        holderCache.inFlight = null;
        return data;
      })
      .catch(err => {
        holderCache.inFlight = null;
        console.error('Holder stats fetch failed:', err.message);
        throw err;
      });
  }

  // Stale data exists — return it immediately; refresh runs in background
  if (holderCache.data) return Promise.resolve({ ...holderCache.data, stale: true });

  // Cold start — must wait for first fetch
  return holderCache.inFlight;
}

// Per-wallet holdings cache — bounds RPC load when /api/me is hit repeatedly. Short TTL
// so a fresh buy/sell shows up quickly.
const walletHoldingsCache = new Map(); // lowercaseAddr -> { holdings, at }
const WALLET_HOLDINGS_TTL_MS = 60 * 1000;

// ERC-721 balanceOf for one address on the given chain RPC.
async function erc721BalanceOf(rpcUrl, contract, address) {
  const n = parseInt(await ethCall(rpcUrl, contract, SEL_BALANCE_OF + padUint(BigInt(address))), 16);
  return Number.isFinite(n) ? n : 0;
}

// LAND parcels locked in estates owned by `address`. Estate parcels live in the estate
// contract, not the wallet, so they'd otherwise be invisible. ownerTokens(address) gives
// the owned estate ids; each estate's parcel count is read by probing estatesToParcels
// (id, i) until the array index reverts (out of bounds). Usually 0 — most wallets own no
// estate, so this is a single empty call.
async function estateLandOwnedBy(address) {
  const raw = await ethCall(ETH_RPC_URL, ESTATE_CONTRACT, SEL_OWNER_TOKENS + padUint(BigInt(address)));
  if (!raw || raw.length <= 2) return 0;
  const hex = raw.slice(2);
  const word = i => hex.slice(i * 64, i * 64 + 64);   // [0]=offset, [1]=length, [2..]=ids
  const len = parseInt(word(1), 16) || 0;
  let parcels = 0;
  for (let k = 0; k < len; k++) {
    const estateId = BigInt('0x' + word(2 + k)).toString();
    for (let i = 0; i < 1000; i++) {
      let pr;
      try { pr = await ethCall(ETH_RPC_URL, ESTATE_CONTRACT, SEL_ESTATES_TO_PARCELS + padUint(BigInt(estateId)) + padUint(i)); }
      catch { break; } // out-of-bounds index reverts → end of this estate's parcels
      if (!pr || pr === '0x') break;
      parcels++;
    }
  }
  return parcels;
}

// A single wallet's HCC holdings (Creature + LAND, including estate-locked LAND), read
// AUTHORITATIVELY from the contracts via balanceOf / ownerTokens — NOT the bulk /holders
// snapshot, which can omit a legitimate holder (Blockscout indexing gaps) and wrongly
// report 0. Short-cached per wallet to bound RPC; on a chain-read failure it falls back to
// the snapshot, so a transient RPC outage degrades gracefully instead of erroring out.
async function getWalletHoldings(address) {
  const addr = (address || '').toLowerCase();
  if (!addr) return { creatureCount: 0, landCount: 0, holdersAvailable: false, holdersFetchedAt: null };

  const cached = walletHoldingsCache.get(addr);
  if (cached && (Date.now() - cached.at) < WALLET_HOLDINGS_TTL_MS) return cached.holdings;

  try {
    const [creatureCount, standaloneLand, estateParcels] = await Promise.all([
      erc721BalanceOf(ZK_RPC_URL, CREATURE_CONTRACT, addr),
      erc721BalanceOf(ETH_RPC_URL, LAND_CONTRACT, addr),
      estateLandOwnedBy(addr),
    ]);
    const holdings = {
      creatureCount,
      landCount: standaloneLand + estateParcels,
      holdersAvailable: true,
      holdersFetchedAt: new Date().toISOString(),
    };
    walletHoldingsCache.set(addr, { holdings, at: Date.now() });
    return holdings;
  } catch (err) {
    console.error(`Per-wallet holdings lookup failed for ${maskWallet(addr)}, using holder snapshot:`, err.message);
    if (!holderCounts.fetchedAt) { try { await getHolderStats(); } catch { /* snapshot also unavailable */ } }
    return {
      creatureCount: holderCounts.creature.get(addr) || 0,
      landCount: holderCounts.land.get(addr) || 0,
      holdersAvailable: holderCounts.fetchedAt > 0,
      holdersFetchedAt: holderCounts.fetchedAt ? new Date(holderCounts.fetchedAt).toISOString() : null,
    };
  }
}

// Warm up cache in the background on startup
getHolderStats().catch(err => console.error('Holder stats prefetch failed:', err.message));

// --- Market / floor price stats ---
// Creatures: floor + real daily sale-price history from Immutable zkEVM (free, no key).
// LAND: floor + daily sale-price history from OpenSea when OPENSEA_API_KEY is set;
//       falls back to CoinGecko for the current floor only (keyless) if the key is absent.
// Both collections trade in ETH, so their daily floors plot on one shared timeline.
const IMX_ZKEVM_CHAIN   = 'imtbl-zkevm-mainnet';
const CREATURE_CONTRACT = '0xCf44b1cBC959295bbBb49935B1b339cC0AA77cdA';
const IMX_ETH_TOKEN     = '0x52a6c53869ce09a731cd772f245b97a4401d3348'; // ETH on Immutable zkEVM (18 decimals)
const LAND_CONTRACT     = '0x8bf3a40ea2337e6e4f6e540680ea6390cb3b4e11'; // Highrise LAND on Ethereum
const LAND_OS_SLUG      = 'highrise-land';
const OPENSEA_API_KEY   = process.env.OPENSEA_API_KEY || '';
const LAND_ETH_SYMBOLS  = new Set(['ETH', 'WETH']); // 1:1 ETH-equivalent payment tokens
const MARKET_CACHE_TTL_MS = 30 * 60 * 1000;
const DAY_MS              = 24 * 60 * 60 * 1000;
const HISTORY_DAYS        = 730; // how far back the price chart reaches (~2y; LAND has the depth, Creatures ~9.5mo)
const HISTORY_MS          = HISTORY_DAYS * DAY_MS;
const MAX_MARKET_PAGES    = 30; // safety cap; current data is well within this

const marketCache = { data: null, fetchedAt: 0, inFlight: null };

const round4 = n => Math.round(n * 1e4) / 1e4;

// Fetch an Immutable endpoint with retries on transient 5xx / network errors —
// the orderbook occasionally returns 500s that succeed on a quick retry. 4xx
// (a malformed request on our side) fails fast.
async function imxFetch(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return res.json();
      const err = new Error(`Immutable API ${res.status} for ${url}`);
      if (res.status < 500) throw err; // our fault — retrying won't help
      lastErr = err;
    } catch (err) {
      if (err.message?.startsWith('Immutable API 4')) throw err;
      lastErr = err;
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr;
}

// Page through Immutable orderbook/activities until the cursor runs out.
async function imxPaged(baseUrl, params, onItems) {
  let cursor = null, pages = 0;
  do {
    const url = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (cursor) url.searchParams.set('page_cursor', cursor);
    const body = await imxFetch(url.toString());
    onItems(body.result ?? []);
    cursor = body.page?.next_cursor ?? null;
    pages++;
  } while (cursor && pages < MAX_MARKET_PAGES);
}

// All ETH-denominated Creature sales: [{ ts, price }] (price in ETH).
async function fetchCreatureSales() {
  const base = `https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/activities`;
  const sales = [];
  await imxPaged(base, { contract_address: CREATURE_CONTRACT, activity_type: 'sale', page_size: '100' }, items => {
    for (const a of items) {
      const p = a.details?.payment;
      if ((p?.token?.contract_address || '').toLowerCase() !== IMX_ETH_TOKEN) continue;
      const price = Number(p.price_including_fees) / 1e18;
      const ts = Date.parse(a.updated_at);
      if (Number.isFinite(price) && price > 0 && Number.isFinite(ts)) sales.push({ ts, price });
    }
  });
  return sales;
}

// Lowest active ETH listing = current Creature floor (in ETH). A single sorted
// request (cheapest ETH listing first) instead of paging every active listing —
// far lighter on the orderbook API, which keeps it well clear of the transient
// 500s that deep queries can trigger.
async function fetchCreatureFloorEth() {
  const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/orders/listings`);
  url.searchParams.set('sell_item_contract_address', CREATURE_CONTRACT);
  url.searchParams.set('buy_item_contract_address', IMX_ETH_TOKEN);
  url.searchParams.set('status', 'ACTIVE');
  url.searchParams.set('sort_by', 'buy_item_amount');
  url.searchParams.set('sort_direction', 'asc');
  url.searchParams.set('page_size', '1');
  const body = await imxFetch(url.toString());
  const buy = (body.result ?? [])[0]?.buy?.[0];
  const v = buy ? Number(buy.amount) / 1e18 : null;
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Daily ETH→USD lookup from CoinGecko (free). Returns { at(ts), current }.
// at(ts) finds the closest prior day's price (within a week) so each historical
// sale is valued in USD at the rate that actually applied then, not today's.
async function fetchEthUsd() {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=365&interval=daily',
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) },
  );
  if (!res.ok) throw new Error(`CoinGecko ETH/USD ${res.status}`);
  const body = await res.json();
  const prices = body.prices ?? [];
  const byDay = new Map();
  for (const [ms, usd] of prices) byDay.set(Math.floor(ms / DAY_MS), usd);
  const current = prices.length ? prices[prices.length - 1][1] : null;
  const dayKeys = [...byDay.keys()];
  const minDay = dayKeys.length ? Math.min(...dayKeys) : null;
  const maxDay = dayKeys.length ? Math.max(...dayKeys) : null;
  // Free CoinGecko only covers ~365 days; for dates outside that, clamp to the
  // nearest known rate (the 2-year LAND tail predates the rate history).
  const at = ts => {
    if (minDay == null) return current;
    const day = Math.floor(ts / DAY_MS);
    if (day <= minDay) return byDay.get(minDay);
    if (day >= maxDay) return byDay.get(maxDay);
    for (let i = 0; i <= 10; i++) {
      if (byDay.has(day - i)) return byDay.get(day - i);
      if (byDay.has(day + i)) return byDay.get(day + i);
    }
    return current;
  };
  return { at, current };
}

// Extra display currencies (USD stays the canonical fiat; these are derived from
// it). Stored ETH/USD values are exact + historical; fiats are scaled by the
// latest USD→X rate, which preserves the chart shape and is exact for current values.
const FX_CURRENCIES = ['usd', 'eur', 'gbp', 'brl', 'rub', 'try', 'jpy', 'cad', 'aud'];

// Current USD-relative FX rates (rate.usd === 1), derived from one CoinGecko call
// that prices ETH in every target currency. Degrades to USD-only on failure.
async function fetchFxRates() {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=${FX_CURRENCIES.join(',')}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) },
  );
  if (!res.ok) throw new Error(`CoinGecko FX ${res.status}`);
  const eth = (await res.json()).ethereum || {};
  const usd = eth.usd;
  const rates = { usd: 1 };
  if (usd) for (const c of FX_CURRENCIES) if (c !== 'usd' && eth[c] != null) rates[c] = eth[c] / usd;
  return rates;
}

// Bucket sales into daily aggregates, tracking the day's lowest and highest sale
// in both ETH and USD. Each sale: { ts, eth, usd } (usd may be null if no rate
// was available). The client picks low/high, then averages over its interval.
function aggregateByDay(sales) {
  const byDay = new Map();
  for (const s of sales) {
    const day = Math.floor(s.ts / DAY_MS);
    let a = byDay.get(day);
    if (!a) { a = { ethLow: s.eth, ethHigh: s.eth, usdLow: s.usd ?? null, usdHigh: s.usd ?? null }; byDay.set(day, a); continue; }
    a.ethLow = Math.min(a.ethLow, s.eth);
    a.ethHigh = Math.max(a.ethHigh, s.eth);
    if (s.usd != null) {
      a.usdLow = a.usdLow == null ? s.usd : Math.min(a.usdLow, s.usd);
      a.usdHigh = a.usdHigh == null ? s.usd : Math.max(a.usdHigh, s.usd);
    }
  }
  return byDay;
}

// Persist today's lowest-listing floor for a collection. Never throws — a DB
// hiccup must not take down the market endpoint; the chart just won't gain a point.
async function recordFloorSnapshot(collection, day, ethFloor, usdFloor) {
  if (ethFloor == null && usdFloor == null) return; // nothing worth storing
  try {
    await db.recordFloorSnapshot({
      day, collection,
      ethFloor: ethFloor != null ? round4(ethFloor) : null,
      usdFloor: usdFloor != null ? Math.round(usdFloor) : null,
    });
  } catch (err) {
    console.error(`Floor snapshot (${collection}) failed:`, err.message);
  }
}

// Read stored listing-floor snapshots into per-collection day-index maps of { eth, usd }.
async function getListingSnapshots() {
  const out = { creature: new Map(), land: new Map() };
  let rows;
  try { rows = await db.getFloorHistory(HISTORY_DAYS); }
  catch (err) { console.error('Floor history read failed:', err.message); return out; }
  for (const r of rows) {
    const m = out[r.collection];
    if (!m) continue;
    const eth = r.eth_floor != null ? Number(r.eth_floor) : null;
    const usd = r.usd_floor != null ? Math.round(Number(r.usd_floor)) : null;
    if (eth == null && usd == null) continue;
    const day = Math.floor(new Date(`${r.date}T00:00:00Z`).getTime() / DAY_MS);
    m.set(day, { eth, usd });
  }
  return out;
}

// One daily series per collection: every day with a sale and/or a floor snapshot
// becomes a point carrying that day's high sale, low sale, and listing floor (any
// may be null). Sale history runs ~2y back; the floor only exists from launch day
// on. The client chooses a metric, buckets by interval, and averages.
function buildCollectionSeries(saleDays, floorDays) {
  const days = [...new Set([...saleDays.keys(), ...floorDays.keys()])].sort((a, b) => a - b);
  return days.map(day => {
    const s = saleDays.get(day);
    const f = floorDays.get(day);
    return {
      date: new Date(day * DAY_MS).toISOString().slice(0, 10),
      highEth: s ? round4(s.ethHigh) : null,
      highUsd: s && s.usdHigh != null ? Math.round(s.usdHigh) : null,
      lowEth:  s ? round4(s.ethLow) : null,
      lowUsd:  s && s.usdLow != null ? Math.round(s.usdLow) : null,
      floorEth: f ? f.eth : null,
      floorUsd: f ? f.usd : null,
    };
  });
}

// LAND via OpenSea: current floor + 30d volume + ETH-denominated sale history.
async function fetchLandFromOpenSea(cutoff) {
  const headers = { Accept: 'application/json', 'X-API-KEY': OPENSEA_API_KEY };

  const statsRes = await fetch(`https://api.opensea.io/api/v2/collections/${LAND_OS_SLUG}/stats`, {
    headers, signal: AbortSignal.timeout(20000),
  });
  if (!statsRes.ok) throw new Error(`OpenSea stats ${statsRes.status}`);
  const statsBody = await statsRes.json();
  const total = statsBody.total ?? {};
  const intervals = {};
  for (const it of (statsBody.intervals ?? [])) intervals[it.interval] = it;

  const sales = [];
  let cursor = null, pages = 0, reachedCutoff = false;
  do {
    const url = new URL(`https://api.opensea.io/api/v2/events/collection/${LAND_OS_SLUG}`);
    url.searchParams.set('event_type', 'sale');
    url.searchParams.set('limit', '50');
    if (cursor) url.searchParams.set('next', cursor);
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`OpenSea events ${res.status}`);
    const body = await res.json();
    for (const e of (body.asset_events ?? [])) {
      const p = e.payment;
      if (!p || !LAND_ETH_SYMBOLS.has(p.symbol)) continue;
      const price = Number(p.quantity) / Math.pow(10, p.decimals ?? 18);
      const ts = Number(e.event_timestamp) * 1000; // OpenSea timestamps are epoch seconds
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(ts)) continue;
      if (ts < cutoff) { reachedCutoff = true; continue; }
      sales.push({ ts, price });
    }
    cursor = body.next ?? null;
    pages++;
  } while (cursor && !reachedCutoff && pages < MAX_MARKET_PAGES);

  return {
    currency: 'ETH',
    source: 'opensea',
    floor: total.floor_price ?? null,
    owners: total.num_owners ?? null,
    sales30d: intervals.thirty_day?.sales ?? null,
    volume30d: intervals.thirty_day?.volume != null ? round4(intervals.thirty_day.volume) : null,
    sales,
  };
}

// LAND fallback via CoinGecko (keyless): current floor + owners only, no history.
async function fetchLandFromCoinGecko() {
  const res = await fetch(`https://api.coingecko.com/api/v3/nfts/ethereum/contract/${LAND_CONTRACT}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`CoinGecko NFT ${res.status}`);
  const b = await res.json();
  return {
    currency: (b.native_currency_symbol || 'eth').toUpperCase(),
    source: 'coingecko',
    floor: b.floor_price?.native_currency ?? null,
    owners: b.number_of_unique_addresses ?? null,
    floorUsd: b.floor_price?.usd ?? null,
    sales30d: null,
    volume30d: null,
    floorChange24h: b.floor_price_24h_percentage_change?.native_currency ?? null,
    sales: [], // CoinGecko free tier has no floor history
  };
}

async function fetchLandData(cutoff) {
  if (OPENSEA_API_KEY) {
    try { return await fetchLandFromOpenSea(cutoff); }
    catch (err) { console.error('OpenSea LAND failed, falling back to CoinGecko:', err.message); }
  }
  return fetchLandFromCoinGecko();
}

async function computeMarketStats() {
  const cutoff = Date.now() - HISTORY_MS;
  const cutoff30d = Date.now() - 30 * DAY_MS;

  // Each source degrades independently — a transient failure in one (e.g. the
  // orderbook 500ing) blanks just that figure instead of taking down the whole tab.
  const [creatureSales, creatureFloor, land, ethUsd, fxRates] = await Promise.all([
    fetchCreatureSales().catch(err => { console.error('Creature sales failed:', err.message); return []; }),
    fetchCreatureFloorEth().catch(err => { console.error('Creature floor failed:', err.message); return null; }),
    fetchLandData(cutoff).catch(err => { console.error('LAND market data failed:', err.message); return null; }),
    fetchEthUsd().catch(err => { console.error('ETH/USD rate failed:', err.message); return { at: () => null, current: null }; }),
    fetchFxRates().catch(err => { console.error('FX rates failed:', err.message); return { usd: 1 }; }),
  ]);

  const rate = ethUsd.current;
  const toUsd = eth => (eth != null && rate != null ? Math.round(eth * rate) : null);
  // Tag each sale with the USD value at its own time, then aggregate.
  const withUsd = s => ({ ts: s.ts, eth: s.price, usd: ethUsd.at(s.ts) != null ? s.price * ethUsd.at(s.ts) : null });

  // 30-day Creature activity
  let creatureSales30 = 0, creatureVol30 = 0;
  for (const s of creatureSales) if (s.ts >= cutoff30d) { creatureSales30++; creatureVol30 += s.price; }

  // Daily lowest-sale aggregates seed the pre-launch history (the only price
  // signal that exists for past days).
  const creatureDays = aggregateByDay(creatureSales.filter(s => s.ts >= cutoff).map(withUsd));
  const landDays = aggregateByDay((land?.sales ?? []).filter(s => s.ts >= cutoff).map(withUsd));

  // Sample today's *listing* floor and store it, so the chart becomes a true
  // daily floor from here on (listings override the sale proxy day by day).
  const today = new Date().toISOString().slice(0, 10);
  await recordFloorSnapshot('creature', today, creatureFloor, toUsd(creatureFloor));
  if (land) {
    const landEth = land.currency === 'ETH' ? land.floor : null;
    const landUsd = land.floorUsd ?? toUsd(land.floor);
    await recordFloorSnapshot('land', today, landEth, landUsd);
  }

  const listing = await getListingSnapshots();
  const creatureHistory = buildCollectionSeries(creatureDays, listing.creature);
  const landHistory = buildCollectionSeries(landDays, listing.land);

  return {
    ethUsd: rate,
    fxRates, // USD-relative display rates: { usd:1, eur, gbp, brl, rub, try, jpy, cad, aud }
    creatures: {
      currency: 'ETH',
      floor: creatureFloor != null ? round4(creatureFloor) : null,
      floorUsd: toUsd(creatureFloor),
      sales30d: creatureSales30,
      volume30d: round4(creatureVol30),
      history: creatureHistory,
    },
    land: land ? {
      currency: land.currency,
      source: land.source,
      floor: land.floor != null ? round4(land.floor) : null,
      floorUsd: land.floorUsd != null ? Math.round(land.floorUsd) : toUsd(land.floor),
      owners: land.owners ?? null,
      sales30d: land.sales30d ?? null,
      volume30d: land.volume30d ?? null,
      floorChange24h: land.floorChange24h ?? null,
      history: landHistory,
    } : null,
    lastFetched: new Date().toISOString(),
    stale: false,
  };
}

function getMarketStats() {
  const now = Date.now();
  const isFresh = marketCache.data && (now - marketCache.fetchedAt) < MARKET_CACHE_TTL_MS;
  if (isFresh) return Promise.resolve(marketCache.data);

  if (!marketCache.inFlight) {
    marketCache.inFlight = computeMarketStats()
      .then(data => {
        marketCache.data = data;
        marketCache.fetchedAt = Date.now();
        marketCache.inFlight = null;
        return data;
      })
      .catch(err => {
        marketCache.inFlight = null;
        console.error('Market stats fetch failed:', err.message);
        throw err;
      });
  }

  if (marketCache.data) return Promise.resolve({ ...marketCache.data, stale: true });
  return marketCache.inFlight;
}

// Warm up market cache in the background on startup
getMarketStats().catch(err => console.error('Market stats prefetch failed:', err.message));

// Re-run periodically so today's floor snapshot is captured even on quiet days
// with no visitors (computeMarketStats records the floor as a side effect).
setInterval(() => { getMarketStats().catch(() => {}); }, 6 * 60 * 60 * 1000).unref();

// --- Council auth + eligibility API ---
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds, mirrors db.js SESSION_TTL_MS

function sendJson(response, status, obj, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(JSON.stringify(obj));
}

// Crude in-memory fixed-window rate limiter (resets on restart). Returns the
// Retry-After seconds if the key is over `max` within `windowMs`, else 0.
const rateBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; rateBuckets.set(key, b); }
  b.count++;
  return b.count > max ? Math.max(1, Math.ceil((b.reset - now) / 1000)) : 0;
}

// Send the user back to the Apply panel; `error` (if set) is read by the front-end.
function redirectToApp(request, response, error) {
  const location = error ? `/?auth=${encodeURIComponent(error)}#apply` : '/#apply';
  response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  response.end();
}

// True when the holdings-derived parts of two eligibility snapshots differ.
function eligibilityChanged(a, b) {
  return a.creatureCount !== b.creatureCount
    || a.landCount !== b.landCount
    || a.totalCount !== b.totalCount
    || a.bracket !== b.bracket
    || a.canRun !== b.canRun
    || a.isMember !== b.isMember
    || a.holdsNow !== b.holdsNow;
}

// Recompute a session's eligibility against the CURRENT holder snapshot, so holdings
// changes (buys/sells, estate moves, or a cold-cache login) reflect without re-login.
// Cheap: getWalletHoldings reads the in-memory holder cache (warming it once if needed)
// — no chain or Highrise calls. Returns the stored snapshot UNCHANGED when there's no
// linked wallet, the holder data isn't available, or the lookup fails, so a transient
// outage can never wrongly downgrade a real holder to "0 assets". When holdings did
// change, it converges the session, the public applicant row, and the audit trail
// (out of band, so the response is never blocked on those writes).
async function refreshEligibility(session, sid) {
  const stored = session.eligibility || {};
  if (!stored.ethWallet) return stored; // no linked wallet — nothing to recompute

  let holdings;
  try { holdings = await getWalletHoldings(stored.ethWallet); }
  catch (err) { console.error('Eligibility refresh failed:', err.message); return stored; }
  if (!holdings.holdersAvailable) return stored; // can't determine right now — keep last known

  const fresh = {
    linked: stored.linked,
    ethWallet: stored.ethWallet,
    holdersAvailable: true,
    ...computeEligibility(holdings),
  };
  if (!eligibilityChanged(stored, fresh)) return fresh;

  session.eligibility = fresh; // keep the in-request copy consistent
  (async () => {
    try {
      if (sid) await db.updateSessionEligibility(sid, fresh);
      await db.upsertApplicant({
        discordId: session.discord_id,
        discordUsername: session.profile?.username,
        ethWallet: fresh.ethWallet,
        creatureCount: fresh.creatureCount,
        landCount: fresh.landCount,
        totalCount: fresh.totalCount,
        bracket: fresh.bracket,
        canRun: fresh.canRun,
      });
      db.recordEvent({
        event: 'eligibility.changed',
        discordId: session.discord_id,
        detail: {
          from: { totalCount: stored.totalCount ?? null, bracket: stored.bracket ?? null, canRun: !!stored.canRun },
          to:   { totalCount: fresh.totalCount, bracket: fresh.bracket, canRun: fresh.canRun },
        },
      });
    } catch (err) { console.error('Eligibility persist failed:', err.message); }
  })();
  return fresh;
}

// Shape a session profile for the client. ONLY the fields the UI renders are sent —
// the Discord id, Highrise user id, guild flag and raw server/Highrise names stay
// server-side. They're identifiers the front-end never needs, and the Highrise user
// id in particular must never reach a browser (it keys the Highrise wallet/profile API).
function publicProfile(p) {
  if (!p) return {};
  return {
    username: p.username || null,
    avatar: p.avatar || null,
    highriseIcon: p.highriseIcon || null,
  };
}

async function handleAuthApi(request, response, url) {
  const { pathname } = url;

  // Step 1 — begin OAuth: redirect to Discord with a CSRF state cookie.
  if (pathname === '/api/auth/discord/login') {
    if (!auth.isConfigured()) { sendJson(response, 503, { error: 'Discord login is not configured.' }); return; }
    const { location, stateCookie } = auth.buildLoginRedirect(request);
    response.writeHead(302, { Location: location, 'Set-Cookie': stateCookie, 'Cache-Control': 'no-store' });
    response.end();
    return;
  }

  // Step 2 — OAuth callback: verify state, exchange code, look up wallet + eligibility.
  if (pathname === '/api/auth/discord/callback') {
    const cookies = auth.parseCookies(request);
    if (url.searchParams.get('error')) {
      db.recordEvent({ event: 'auth.denied', ok: false, detail: { error: url.searchParams.get('error') } });
      return redirectToApp(request, response, 'denied');
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || state !== cookies[auth.STATE_COOKIE]) {
      db.recordEvent({ event: 'auth.state_mismatch', ok: false });
      return redirectToApp(request, response, 'state');
    }

    // Track which step fails so the logs pinpoint config/connectivity issues
    // (token exchange, Discord, Highrise, holder lookup, or DB).
    let stage = 'exchangeCode';
    try {
      const token = await auth.exchangeCode(code, request);
      stage = 'fetchDiscordUser';
      const profile = await auth.fetchDiscordUser(token.access_token);
      stage = 'fetchGuildMember';
      const guild = await auth.fetchGuildDisplayName(token.access_token);
      stage = 'fetchHighriseWallet';
      const wallet = await auth.fetchHighriseWallet(profile.id);

      let holdings = { creatureCount: 0, landCount: 0, holdersAvailable: false };
      if (wallet.ethWallet) { stage = 'getWalletHoldings'; holdings = await getWalletHoldings(wallet.ethWallet); }

      // Highrise profile (avatar pic + in-game name) by user_id from the wallet lookup.
      stage = 'fetchHighriseProfile';
      const highrise = await auth.fetchHighriseProfile(wallet.userId);

      const eligibility = {
        linked: wallet.linked,
        ethWallet: wallet.ethWallet,
        holdersAvailable: holdings.holdersAvailable,
        ...computeEligibility(holdings),
      };

      // Ballot name = Highrise username (falls back to Highrise Discord display/global name).
      const sessionProfile = {
        id: profile.id,
        username: profile.username,
        avatar: profile.avatar,
        serverName: guild.serverName,
        inGuild: guild.inGuild,
        highriseName: highrise?.name || null,
        highriseIcon: highrise?.iconUrl || null,
        highriseUserId: wallet.userId || null,
      };
      stage = 'createSession';
      const sid = await db.createSession(profile.id, sessionProfile, eligibility);
      stage = 'upsertApplicant';
      await db.upsertApplicant({
        discordId: profile.id,
        discordUsername: profile.username,
        ethWallet: wallet.ethWallet,
        creatureCount: eligibility.creatureCount,
        landCount: eligibility.landCount,
        totalCount: eligibility.totalCount,
        bracket: eligibility.bracket,
        canRun: eligibility.canRun,
      });

      db.recordEvent({
        event: 'auth.login',
        discordId: profile.id,
        detail: {
          username: profile.username,
          highriseName: highrise?.name || null,
          inGuild: guild.inGuild,
          linked: wallet.linked,
          ethWallet: wallet.ethWallet,
          creatureCount: eligibility.creatureCount,
          landCount: eligibility.landCount,
          totalCount: eligibility.totalCount,
          bracket: eligibility.bracket,
          canRun: eligibility.canRun,
          holdersAvailable: eligibility.holdersAvailable,
        },
      });

      const secure = auth.isSecure(request);
      response.writeHead(302, {
        Location: '/#apply',
        'Set-Cookie': [
          auth.serializeCookie(auth.SESSION_COOKIE, sid, { maxAge: SESSION_MAX_AGE, secure }),
          auth.serializeCookie(auth.STATE_COOKIE, '', { maxAge: 0, secure }),
        ],
        'Cache-Control': 'no-store',
      });
      response.end();
    } catch (err) {
      console.error(`OAuth callback failed at stage "${stage}":`, err.message);
      db.recordEvent({ event: 'auth.callback_error', ok: false, detail: { stage, message: err.message } });
      redirectToApp(request, response, 'failed');
    }
    return;
  }

  // Current session + eligibility for the logged-in user.
  if (pathname === '/api/me') {
    const cookies = auth.parseCookies(request);
    const sid = cookies[auth.SESSION_COOKIE];
    const session = await db.getSession(sid);
    if (!session) { sendJson(response, 200, { authenticated: false }); return; }
    sendJson(response, 200, {
      authenticated: true,
      profile: publicProfile(session.profile),
      // Recompute against current holdings so the panel reflects buys/sells without re-login.
      eligibility: await refreshEligibility(session, sid),
    });
    return;
  }

  // Dev-only login (optional local module; absent from the deployed build).
  if (pathname === '/api/auth/dev-login') {
    if (devLogin) return devLogin(request, response, url);
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  // Logout.
  if (pathname === '/api/auth/logout') {
    const cookies = auth.parseCookies(request);
    const sid = cookies[auth.SESSION_COOKIE];
    const endingSession = await db.getSession(sid);
    await db.deleteSession(sid);
    db.recordEvent({ event: 'auth.logout', discordId: endingSession?.discord_id || null });
    response.writeHead(302, {
      Location: '/#council',
      'Set-Cookie': auth.serializeCookie(auth.SESSION_COOKIE, '', { maxAge: 0, secure: auth.isSecure(request) }),
      'Cache-Control': 'no-store',
    });
    response.end();
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

// --- Candidate application API ---
// Candidacy window. Closed by default — no draft, submit, or AI-draft is accepted
// until APPLICATIONS_OPEN=1 is set (the eligibility check stays live regardless).
const APPLICATIONS_OPEN = envFlag(process.env.APPLICATIONS_OPEN);

// --- Election status (public) ---
// A cached snapshot of the race: submitted candidates per holding bracket, the seats
// each bracket elects, and whether the candidacy window is open. Public — it's the
// same picture voters see, so no auth or wallet is needed. The count is cheap (one
// grouped query) but short-cached so repeated polling can't hammer the DB; a fresh
// submission clears the cache (see handleApplicationApi) so the board updates at once.
const APPOINTED_SEATS = 3;                       // appointed for continuity (see Roadmap → First Election)
const RACE_ORDER = ['single', 'mid', 'whale'];   // smallest-holder bracket first, mirroring the eligibility card
const electionCache = { data: null, at: 0 };
const ELECTION_CACHE_TTL_MS = 30 * 1000;

async function getElectionStatus() {
  if (electionCache.data && Date.now() - electionCache.at < ELECTION_CACHE_TTL_MS) {
    return electionCache.data;
  }
  const counts = await db.getCandidateCounts();
  const seatsFor = id => BRACKETS.find(b => b.id === id)?.seats ?? 0;
  const races = RACE_ORDER.map(id => ({ bracket: id, seats: seatsFor(id), candidates: counts[id] || 0 }));
  const data = {
    applicationsOpen: APPLICATIONS_OPEN,
    races,
    totalCandidates: races.reduce((n, r) => n + r.candidates, 0),
    electedSeats: races.reduce((n, r) => n + r.seats, 0),
    appointedSeats: APPOINTED_SEATS,
    lastUpdated: new Date().toISOString(),
  };
  electionCache.data = data;
  electionCache.at = Date.now();
  return data;
}

// Draft open questions for the self-nomination form (owner will refine the copy;
// these ids must match the front-end in js/application.js).
const APPLICATION_QUESTIONS = ['track', 'theme', 'gen2', 'value', 'roadmap', 'communication', 'represent', 'seat'];
const APP_LIMITS = { displayName: 40, pitch: 240, answer: 1200 };

function readJsonBody(request, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, aborted = false; const chunks = [];
    request.on('data', chunk => {
      if (aborted) return; // over the cap — discard further chunks (bounded memory), don't reset the socket
      size += chunk.length;
      if (size > limitBytes) {
        aborted = true; chunks.length = 0;
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (aborted) return;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON.'), { statusCode: 400 })); }
    });
    request.on('error', err => { if (!aborted) reject(err); });
  });
}

// Shape an application row for the client (never leaks DB-internal fields).
function publicApplication(a) {
  if (!a) return null;
  return {
    displayName: a.display_name || '',
    pitch: a.pitch || '',
    answers: a.answers || {},
    positions: a.positions || {},
    bracket: a.bracket || null,
    status: a.status || 'draft',
    submittedAt: a.submitted_at || null,
    updatedAt: a.updated_at || null,
  };
}

// Validate a client-sent positions map into { id: { stance 1-5, rationale } }.
function cleanPositions(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const id of PROPOSITION_IDS) {
      const p = raw[id];
      if (p && typeof p === 'object') {
        const stance = parseInt(p.stance, 10);
        if (stance >= 1 && stance <= 5) {
          out[id] = { stance, rationale: String(p.rationale || '').trim().slice(0, 200) };
        }
      }
    }
  }
  return out;
}

async function handleApplicationApi(request, response) {
  const cookies = auth.parseCookies(request);
  const session = await db.getSession(cookies[auth.SESSION_COOKIE]);
  if (!session) { sendJson(response, 401, { error: 'Sign in to apply.' }); return; }
  // Live eligibility — recompute against current holdings so the form's gate matches the
  // panel and reflects any change since login (estates, buys/sells) without re-login.
  const elig = await refreshEligibility(session, cookies[auth.SESSION_COOKIE]);

  // Ballot name is server-authoritative: the candidate's Highrise username (the identity
  // voters recognise), falling back to their Highrise Discord display name then global
  // Discord name only if the Highrise profile is unavailable. Never taken from the client.
  const ballotName = (session.profile?.highriseName || session.profile?.serverName || session.profile?.username || '').slice(0, APP_LIMITS.displayName);

  const pathname = request.url.split('?')[0];

  // AI-draft positions from the candidate's current answers (review-before-save).
  if (pathname === '/api/application/derive') {
    if (request.method !== 'POST') { sendJson(response, 405, { error: 'Method not allowed.' }); return; }
    if (!APPLICATIONS_OPEN) { sendJson(response, 403, { error: 'Applications are not open yet.' }); return; }
    if (!elig.canRun) { sendJson(response, 403, { error: 'You are not eligible to run for a seat.' }); return; }
    if (!derive.isConfigured()) { sendJson(response, 503, { error: 'AI drafting is not configured.' }); return; }
    // Rate limit the paid AI endpoint per user (cost / abuse protection).
    const wait = rateLimited(`derive:${session.discord_id}`, 20, 60 * 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many AI drafts. Try again later.' }, { 'Retry-After': String(wait) }); return; }

    let body;
    try { body = await readJsonBody(request); }
    catch (err) { sendJson(response, err.statusCode || 400, { error: err.message }); return; }

    const answers = {};
    for (const id of APPLICATION_QUESTIONS) {
      const v = body.answers && typeof body.answers[id] === 'string' ? body.answers[id] : '';
      answers[id] = v.trim().slice(0, APP_LIMITS.answer);
    }
    const positions = await derive.derivePositions(answers);
    db.recordEvent({ event: 'application.derive', discordId: session.discord_id, detail: { answered: Object.values(answers).filter(Boolean).length } });
    sendJson(response, 200, { positions });
    return;
  }

  if (request.method === 'GET') {
    const application = await db.getApplication(session.discord_id);
    sendJson(response, 200, {
      eligibleToRun: !!elig.canRun,
      applicationsOpen: APPLICATIONS_OPEN,
      bracket: elig.bracket || null,
      ballotName,
      avatar: session.profile?.highriseIcon || null,
      inGuild: !!session.profile?.inGuild,
      propositions: PROPOSITIONS,
      application: publicApplication(application),
    });
    return;
  }

  if (request.method === 'POST') {
    // Server-side gate — never trust the client about eligibility.
    if (!elig.canRun) {
      db.recordEvent({ event: 'application.forbidden', discordId: session.discord_id, ok: false, detail: { bracket: elig.bracket || null, totalCount: elig.totalCount ?? null } });
      sendJson(response, 403, { error: 'You are not eligible to run for a seat.' });
      return;
    }
    // Light rate limit on writes (per user) — prevents draft-spam / DB abuse.
    const wait = rateLimited(`save:${session.discord_id}`, 120, 60 * 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': String(wait) }); return; }

    let body;
    try { body = await readJsonBody(request); }
    catch (err) { sendJson(response, err.statusCode || 400, { error: err.message }); return; }

    const status = body.status === 'submitted' ? 'submitted' : 'draft';
    // Candidacy window closed — drafts are allowed (so candidates can prepare),
    // but final submission is blocked until APPLICATIONS_OPEN=1.
    if (status === 'submitted' && !APPLICATIONS_OPEN) {
      db.recordEvent({ event: 'application.submit_blocked', discordId: session.discord_id, ok: false, detail: { reason: 'applications_closed' } });
      sendJson(response, 403, { error: 'Applications are not open for submission yet.' });
      return;
    }
    const displayName = ballotName; // not editable by the candidate
    const pitch = String(body.pitch || '').trim().slice(0, APP_LIMITS.pitch);
    const answers = {};
    for (const id of APPLICATION_QUESTIONS) {
      const v = body.answers && typeof body.answers[id] === 'string' ? body.answers[id] : '';
      answers[id] = v.trim().slice(0, APP_LIMITS.answer);
    }
    const positions = cleanPositions(body.positions);

    if (status === 'submitted') {
      const missing = [];
      if (!displayName) missing.push('displayName');
      if (!pitch) missing.push('pitch');
      for (const id of APPLICATION_QUESTIONS) if (!answers[id]) missing.push(id);
      for (const id of PROPOSITION_IDS) if (!positions[id]) missing.push(`pos:${id}`);
      if (body.consent !== true) missing.push('consent');
      if (missing.length) {
        db.recordEvent({ event: 'application.submit_rejected', discordId: session.discord_id, ok: false, detail: { missing } });
        sendJson(response, 422, { error: 'Complete every field and the acknowledgements before submitting.', missing });
        return;
      }
    }

    const saved = await db.saveApplication({
      discordId: session.discord_id,
      discordUsername: session.profile?.username,
      ethWallet: elig.ethWallet || null,
      bracket: elig.bracket || null,
      displayName, pitch, answers, positions, status,
    });

    // A new (or re-)submission changes the public race counts — drop the cached
    // election snapshot so the status board reflects it on the next load.
    if (status === 'submitted') electionCache.at = 0;

    // Drafts autosave often, so log a light summary. Submissions log the full
    // point-in-time snapshot — preserving exactly what each candidate submitted even
    // if they edit later, and making every submission individually traceable.
    if (status === 'submitted') {
      db.recordEvent({
        event: 'application.submit',
        discordId: session.discord_id,
        detail: {
          bracket: elig.bracket || null,
          ethWallet: elig.ethWallet || null,
          submittedAt: saved.submitted_at || null,
          snapshot: { displayName, pitch, answers, positions },
        },
      });
    } else {
      db.recordEvent({
        event: 'application.save_draft',
        discordId: session.discord_id,
        detail: {
          bracket: elig.bracket || null,
          hasPitch: !!pitch,
          answered: Object.values(answers).filter(Boolean).length,
          positions: Object.keys(positions).length,
        },
      });
    }

    sendJson(response, 200, { ok: true, application: publicApplication(saved) });
    return;
  }

  sendJson(response, 405, { error: 'Method not allowed.' });
}

// --- Static file serving ---
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

// Strict allowlist for static serving. ONLY these top-level directories and root
// files are reachable — everything else (.env, .git, server-side code in lib/,
// server.js, package.json, node_modules, etc.) returns 404. This is the primary
// guard against leaking secrets or source on an open-source, self-hostable repo.
const PUBLIC_DIRS  = new Set(['css', 'js', 'img', 'assets', 'fonts', 'locales']);
const PUBLIC_FILES = new Set(['index.html', 'changelog.json', 'favicon.ico', 'robots.txt']);
const SERVABLE_EXT = new Set([
  '.html', '.css', '.js', '.json',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.otf', '.ttf', '.woff', '.woff2', '.txt',
]);

// Content-Security-Policy for HTML pages: scripts only from self + the Chart.js CDN
// (no inline/eval scripts); images from self + the Discord & Highrise avatar CDNs;
// inline styles allowed (the markup uses style="" attributes); everything else self.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cdn.highrisegame.com https://cdn.discordapp.com",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

// Security headers. CSP + framing protection only matter for the HTML document;
// nosniff/referrer apply to everything.
function securityHeaders(extension) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  if (extension === '.html') {
    h['Content-Security-Policy'] = CSP;
    h['X-Frame-Options'] = 'DENY';
  }
  return h;
}

function resolveFile(requestUrl) {
  let pathname;
  try {
    const url = new URL(requestUrl, `http://${host}:${port}`);
    pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  } catch {
    return null; // malformed URL / bad percent-encoding
  }

  // Normalize, strip leading slashes, split into segments.
  const normalized = path.normalize(pathname).replace(/^([/\\])+/, '');
  const segments = normalized.split(/[/\\]+/).filter(Boolean);
  if (!segments.length) return null;

  // Reject traversal and any dotfile/dot-directory segment (.env, .git, .github…).
  if (segments.some(s => s === '..' || s.startsWith('.'))) return null;

  // Allowlist: a single public root file, or a file inside a public directory.
  const top = segments[0];
  const isPublicFile = segments.length === 1 && PUBLIC_FILES.has(top);
  const isPublicDir  = segments.length > 1 && PUBLIC_DIRS.has(top);
  if (!isPublicFile && !isPublicDir) return null;

  // Extension allowlist — never serve files without a known-safe content type.
  if (!SERVABLE_EXT.has(path.extname(normalized).toLowerCase())) return null;

  const filePath = path.join(root, normalized);
  // Final containment backstop.
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;

  return filePath;
}

const server = http.createServer((request, response) => {
  // Auth + eligibility API (async). Catches errors so a failed lookup sends the
  // user back to the Apply panel with an error flag instead of hanging.
  if (request.url.startsWith('/api/auth') || request.url === '/api/me') {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    handleAuthApi(request, response, url).catch(err => {
      console.error('Auth API error:', err.message);
      if (!response.headersSent) {
        if (url.pathname === '/api/me') sendJson(response, 200, { authenticated: false });
        else redirectToApp(request, response, 'failed');
      }
    });
    return;
  }

  if (request.url.startsWith('/api/application')) {
    handleApplicationApi(request, response).catch(err => {
      console.error('Application API error:', err.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
    });
    return;
  }

  if (request.url === '/api/holders/progress') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(fetchProgress));
    return;
  }

  if (request.url.startsWith('/api/holders')) {
    getHolderStats()
      .then(data => {
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        });
        response.end(JSON.stringify(data));
      })
      .catch(err => {
        console.error('Holder stats request failed:', err.message);
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Holder data temporarily unavailable.' }));
      });
    return;
  }

  if (request.url.startsWith('/api/election')) {
    getElectionStatus()
      .then(data => {
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify(data));
      })
      .catch(err => {
        console.error('Election status request failed:', err.message);
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Election status temporarily unavailable.' }));
      });
    return;
  }

  if (request.url.startsWith('/api/market')) {
    getMarketStats()
      .then(data => {
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        });
        response.end(JSON.stringify(data));
      })
      .catch(err => {
        console.error('Market stats request failed:', err.message);
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Market data temporarily unavailable.' }));
      });
    return;
  }

  const filePath = resolveFile(request.url);

  if (!filePath) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    const extension = path.extname(filePath).toLowerCase();

    // Content-hash ETag. This is the validator that was missing: with it, `no-cache`
    // revalidation is deterministic (304 when unchanged, full body when changed) instead
    // of undefined-across-browsers, which is what left users on days-old copies.
    const etag = 'W/"' + crypto.createHash('sha1').update(data).digest('base64').slice(0, 27) + '"';

    // Files have no content-hashed names, so nothing may be frozen with `immutable`
    // (that previously pinned media for a year). Binary media gets a short cache then
    // revalidates; everything that defines a "page" (html/css/js/json/svg) revalidates
    // every load so a new deploy is picked up immediately.
    const media = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.otf', '.ttf', '.woff', '.woff2']);
    const cacheControl = media.has(extension)
      ? 'public, max-age=3600, must-revalidate'
      : 'no-cache';

    const secHeaders = securityHeaders(extension);

    // Honour conditional requests — cheap 304 when the browser already has this content.
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl, ...secHeaders });
      response.end();
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      ETag: etag,
      ...secHeaders,
    });
    response.end(data);
  });
});

server.listen(port, host, () => {
  console.log(`HCC Player Council site running on http://${host}:${port}`);
});
