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
const { computeEligibility } = require('./lib/eligibility');
const { PROPOSITIONS, PROPOSITION_IDS } = require('./lib/propositions');
const derive = require('./lib/derive-positions');

db.init().catch(err => console.error('DB init failed:', err.message));

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

  const [creatureCounts, landCounts] = await Promise.all([
    fetchHolderCounts(CREATURE_HOLDERS_URL, () => fetchProgress.creaturePages++),
    fetchHolderCounts(LAND_HOLDERS_URL,     () => fetchProgress.landPages++),
  ]);

  fetchProgress.phase = 'computing';

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

// Look up a single wallet's HCC holdings (Creature + LAND counts) from the cached
// holder maps. Ensures the holder data has been fetched at least once first.
async function getWalletHoldings(address) {
  if (!holderCounts.fetchedAt) await getHolderStats();
  const addr = (address || '').toLowerCase();
  return {
    creatureCount: holderCounts.creature.get(addr) || 0,
    landCount: holderCounts.land.get(addr) || 0,
    holdersAvailable: holderCounts.fetchedAt > 0,
    holdersFetchedAt: holderCounts.fetchedAt ? new Date(holderCounts.fetchedAt).toISOString() : null,
  };
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
  const [creatureSales, creatureFloor, land, ethUsd] = await Promise.all([
    fetchCreatureSales().catch(err => { console.error('Creature sales failed:', err.message); return []; }),
    fetchCreatureFloorEth().catch(err => { console.error('Creature floor failed:', err.message); return null; }),
    fetchLandData(cutoff).catch(err => { console.error('LAND market data failed:', err.message); return null; }),
    fetchEthUsd().catch(err => { console.error('ETH/USD rate failed:', err.message); return { at: () => null, current: null }; }),
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
    if (url.searchParams.get('error')) return redirectToApp(request, response, 'denied');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || state !== cookies[auth.STATE_COOKIE]) {
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

      // Ballot name = display name in the Highrise Discord (falls back to global name).
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
      redirectToApp(request, response, 'failed');
    }
    return;
  }

  // Current session + eligibility for the logged-in user.
  if (pathname === '/api/me') {
    const cookies = auth.parseCookies(request);
    const session = await db.getSession(cookies[auth.SESSION_COOKIE]);
    if (!session) { sendJson(response, 200, { authenticated: false }); return; }
    sendJson(response, 200, {
      authenticated: true,
      profile: session.profile,
      eligibility: session.eligibility,
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
    await db.deleteSession(cookies[auth.SESSION_COOKIE]);
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
const APPLICATIONS_OPEN = process.env.APPLICATIONS_OPEN === '1';

// Draft open questions for the self-nomination form (owner will refine the copy;
// these ids must match the front-end in js/application.js).
const APPLICATION_QUESTIONS = ['drops', 'gen2', 'community', 'pushback', 'change'];
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
  const elig = session.eligibility || {};

  // Ballot name is server-authoritative: the user's Highrise Discord display name
  // (falls back to their global Discord name). Never taken from the client.
  const ballotName = (session.profile?.serverName || session.profile?.username || '').slice(0, APP_LIMITS.displayName);

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
    if (!elig.canRun) { sendJson(response, 403, { error: 'You are not eligible to run for a seat.' }); return; }
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
