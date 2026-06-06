const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Load .env into process.env if present, so the OpenSea key works no matter how the
// server is launched (node server.js, npm start, IDE). No-op in production, where
// Railway injects real env vars and there is no .env file.
try { process.loadEnvFile(); } catch { /* no .env — fine */ }

const db = require('./lib/db');
const auth = require('./lib/auth');
const { computeEligibility } = require('./lib/eligibility');

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
// Creatures: floor + real weekly sale-price history from Immutable zkEVM (free, no key).
// LAND: floor + weekly sale-price history from OpenSea when OPENSEA_API_KEY is set;
//       falls back to CoinGecko for the current floor only (keyless) if the key is absent.
// Both collections trade in ETH, so their weekly floors plot on one shared timeline.
const IMX_ZKEVM_CHAIN   = 'imtbl-zkevm-mainnet';
const CREATURE_CONTRACT = '0xCf44b1cBC959295bbBb49935B1b339cC0AA77cdA';
const IMX_ETH_TOKEN     = '0x52a6c53869ce09a731cd772f245b97a4401d3348'; // ETH on Immutable zkEVM (18 decimals)
const LAND_CONTRACT     = '0x8bf3a40ea2337e6e4f6e540680ea6390cb3b4e11'; // Highrise LAND on Ethereum
const LAND_OS_SLUG      = 'highrise-land';
const OPENSEA_API_KEY   = process.env.OPENSEA_API_KEY || '';
const LAND_ETH_SYMBOLS  = new Set(['ETH', 'WETH']); // 1:1 ETH-equivalent payment tokens
const MARKET_CACHE_TTL_MS = 30 * 60 * 1000;
const WEEK_MS             = 7 * 24 * 60 * 60 * 1000;
const DAY_MS              = 24 * 60 * 60 * 1000;
const HISTORY_MS          = 730 * DAY_MS; // how far back the price chart reaches (~2y; LAND has the depth, Creatures ~9.5mo)
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

// Bucket sales into ISO-week aggregates, tracking both ETH and USD low/avg.
// Each sale: { ts, eth, usd } (usd may be null if no rate was available).
function aggregateByWeek(sales) {
  const byWeek = new Map();
  for (const s of sales) {
    const wk = Math.floor(s.ts / WEEK_MS);
    let a = byWeek.get(wk);
    if (!a) { a = { ethLow: s.eth, ethSum: 0, count: 0, usdLow: null, usdSum: 0, usdCount: 0 }; byWeek.set(wk, a); }
    a.ethLow = Math.min(a.ethLow, s.eth);
    a.ethSum += s.eth;
    a.count++;
    if (s.usd != null) {
      a.usdLow = a.usdLow == null ? s.usd : Math.min(a.usdLow, s.usd);
      a.usdSum += s.usd;
      a.usdCount++;
    }
  }
  return byWeek;
}

// Continuous weekly series over [first, last] (inclusive), gaps as nulls.
function seriesFromWeeks(byWeek, first, last) {
  const series = [];
  for (let wk = first; wk <= last; wk++) {
    const a = byWeek.get(wk);
    const date = new Date(wk * WEEK_MS).toISOString().slice(0, 10);
    series.push(a
      ? {
          date,
          ethLow: round4(a.ethLow),
          ethAvg: round4(a.ethSum / a.count),
          usdLow: a.usdCount ? Math.round(a.usdLow) : null,
          usdAvg: a.usdCount ? Math.round(a.usdSum / a.usdCount) : null,
          count: a.count,
        }
      : { date, ethLow: null, ethAvg: null, usdLow: null, usdAvg: null, count: 0 });
  }
  return series;
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

  // Build both weekly series over a single shared week range so they align on one chart.
  const creatureWeeks = aggregateByWeek(creatureSales.filter(s => s.ts >= cutoff).map(withUsd));
  const landWeeks = aggregateByWeek((land?.sales ?? []).filter(s => s.ts >= cutoff).map(withUsd));

  const allWeekKeys = [...creatureWeeks.keys(), ...landWeeks.keys()];
  let creatureHistory = [], landHistory = [];
  if (allWeekKeys.length) {
    const first = Math.min(...allWeekKeys);
    const last = Math.max(...allWeekKeys);
    creatureHistory = creatureWeeks.size ? seriesFromWeeks(creatureWeeks, first, last) : [];
    landHistory = landWeeks.size ? seriesFromWeeks(landWeeks, first, last) : [];
  }

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

// --- Council auth + eligibility API ---
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds, mirrors db.js SESSION_TTL_MS

function sendJson(response, status, obj) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(obj));
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

    const token = await auth.exchangeCode(code, request);
    const profile = await auth.fetchDiscordUser(token.access_token);
    const wallet = await auth.fetchHighriseWallet(profile.id);

    let holdings = { creatureCount: 0, landCount: 0, holdersAvailable: false };
    if (wallet.ethWallet) holdings = await getWalletHoldings(wallet.ethWallet);

    const eligibility = {
      linked: wallet.linked,
      ethWallet: wallet.ethWallet,
      holdersAvailable: holdings.holdersAvailable,
      ...computeEligibility(holdings),
    };

    const sessionProfile = { id: profile.id, username: profile.username, avatar: profile.avatar };
    const sid = await db.createSession(profile.id, sessionProfile, eligibility);
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
    // Code & content (html/js/css/json/locales) have no content-hashed names, so they
    // must revalidate or stale copies linger after every deploy. Only fingerprint-stable
    // media (fonts/images) is safe to cache long-term.
    const longCache = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.otf', '.ttf', '.woff', '.woff2']);
    response.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Cache-Control': longCache.has(extension)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    response.end(data);
  });
});

server.listen(port, host, () => {
  console.log(`HCC Player Council site running on http://${host}:${port}`);
});
