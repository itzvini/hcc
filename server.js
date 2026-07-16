const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// Load .env into process.env if present, so the OpenSea key works no matter how the
// server is launched (node server.js, npm start, IDE). No-op in production, where
// Railway injects real env vars and there is no .env file.
try { process.loadEnvFile(); } catch { /* no .env — fine */ }

const db = require('./lib/db');
const auth = require('./lib/auth');
const mktOrderbook = require('./lib/marketplace-orderbook');
const squidBridge = require('./lib/squid-bridge');
const landMarket = require('./lib/land-market');
const landPets = require('./lib/land-pets');
const slimeIndex = require('./lib/slime-index');
const { computeEligibility, BRACKETS } = require('./lib/eligibility');
const { PROPOSITIONS, PROPOSITION_IDS } = require('./lib/propositions');
const { POLLS, pollStatus } = require('./lib/polls');
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

// --- Announcements feed (public Discord mirror) ---
// The Discord bot POSTs the announcements channel's messages to
// /api/announcements/ingest, authenticated with an HMAC-SHA256 of the raw request
// body under ANNOUNCEMENTS_INGEST_SECRET. No secret set → ingest is disabled (503),
// so a misconfigured deploy can never accept unauthenticated writes. The website
// holds NO credential to the bot's database; the bot is the only thing that reads
// Discord, and it only ever pushes this one channel — so the worst a leaked secret
// buys an attacker is the ability to append a fake announcement, never to read
// anything. Idempotency + the channel/thread guards below mean edits never double a
// card, deletes hide instantly, and thread replies are refused outright.
const ANNOUNCEMENTS_CHANNEL_ID  = String(process.env.ANNOUNCEMENTS_CHANNEL_ID || '1083852782722887691').trim();
const DISCORD_GUILD_ID          = String(process.env.DISCORD_GUILD_ID || '890228388311228456').trim();
const ANNOUNCEMENTS_INGEST_SECRET = process.env.ANNOUNCEMENTS_INGEST_SECRET || '';
// Long announcements are often split across several messages posted back-to-back. We
// merge consecutive messages from the SAME author whose gaps are within this window into
// one card (read-time only — the rows stay individual). The window is generous vs. how
// far apart distinct announcements land (hours/days) but tight enough not to merge them.
const ANNOUNCEMENTS_GROUP_WINDOW_MS = Math.max(0, Number(process.env.ANNOUNCEMENTS_GROUP_WINDOW_MIN || 5)) * 60 * 1000;

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
// Balance reads MUST reflect a fresh top-up. Blockscout's eth-rpc has been observed to lag
// recent balance changes (reporting a stale, lower balance), which wrongly blocks funded
// buyers — so wallet-balance lookups use a full node. Heavy estate/LAND eth_calls (cached,
// slow-changing) stay on ETH_RPC_URL to avoid hammering a public node.
const ETH_BALANCE_RPC         = process.env.ETH_BALANCE_RPC || 'https://ethereum-rpc.publicnode.com';
const ZK_RPC_URL              = process.env.ZK_RPC_URL || 'https://rpc.immutable.com'; // Immutable zkEVM (Creatures)
// Transak card on-ramp credentials. As of Transak's June 2026 migration, query-param widget
// URLs are dead — the widget loads ONLY with a sessionId minted server-side from the API key
// + SECRET (see the on-ramp helpers near handleMarketplaceApi). The secret must never reach a
// browser, so both live in env. Absent → the card CTA falls back to Immutable's keyless hosted
// page (zkEVM) / is hidden (LAND). TRANSAK_ENV picks the host set: a staging key only works on
// the -stg hosts, a production key only on the prod hosts. TRANSAK_REFERRER_DOMAIN overrides the
// referrer Transak validates against your whitelisted domains (defaults to the request host).
const TRANSAK_API_KEY         = (process.env.TRANSAK_API_KEY || '').trim();
const TRANSAK_API_SECRET      = (process.env.TRANSAK_API_SECRET || '').trim();
const TRANSAK_ENV             = (process.env.TRANSAK_ENV || 'production').trim().toLowerCase();
const TRANSAK_REFERRER_DOMAIN = (process.env.TRANSAK_REFERRER_DOMAIN || '').trim();
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

// Transaction receipt on the given chain RPC (null while pending). Powers the bridge
// tracker's "confirmed on Ethereum" stage before Squid has indexed the transfer.
async function ethGetTxReceipt(rpcUrl, hash) {
  const res = await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`eth_getTransactionReceipt HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'eth_getTransactionReceipt error');
  return body.result; // null until mined
}

// Native-coin balance (wei hex) for an address on the given chain RPC. Powers the
// marketplace's "your ETH is just on the wrong network" helper (mainnet ETH lookup).
async function ethGetBalance(rpcUrl, address) {
  const res = await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`eth_getBalance HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'eth_getBalance error');
  return body.result;
}

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
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/; // a real on-chain address (rejects dev-login placeholders)

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

// Every LAND parcel tokenId a wallet holds, straight from the contract — ownerTokens(address)
// returns the full uint256[] in ONE eth_call (the LAND contract shares the estate contract's
// custom enumerator, and is ERC721Enumerable besides; both verified on-chain). This is what
// feeds the Sell/Transfer pickers: authoritative and current the block after a buy, unlike
// OpenSea's owner index, which lags a mined buy by minutes. Estate-locked parcels are owned
// by the estate contract on-chain, so they're naturally absent — right for trading surfaces.
async function landOwnedOnChain(address) {
  const raw = await ethCall(ETH_RPC_URL, LAND_CONTRACT, SEL_OWNER_TOKENS + padUint(BigInt(address)));
  if (!raw || raw.length < 2 + 128) return [];
  const hex = raw.slice(2);
  const word = i => hex.slice(i * 64, i * 64 + 64);   // [0]=offset, [1]=length, [2..]=ids
  const len = parseInt(word(1), 16) || 0;
  return Array.from({ length: len }, (_, k) => {
    const tokenId = BigInt('0x' + word(2 + k)).toString();
    // Placeholder name/image — the slime-index join downstream adds coords (→ the "(x, y)"
    // name and the pet render the pickers actually use).
    return { tokenId, name: `Highrise LAND #${tokenId}`, image: null, coords: null };
  });
}

// A single wallet's HCC holdings (Creature + LAND, including estate-locked LAND), read
// AUTHORITATIVELY from the contracts via balanceOf / ownerTokens — NOT the bulk /holders
// snapshot, which can omit a legitimate holder (Blockscout indexing gaps) and wrongly
// report 0. Short-cached per wallet to bound RPC; on a chain-read failure it falls back to
// the snapshot, so a transient RPC outage degrades gracefully instead of erroring out.
async function getWalletHoldings(address) {
  const addr = (address || '').toLowerCase();
  if (!addr) return { creatureCount: 0, landCount: 0, holdersAvailable: false, holdersFetchedAt: null };
  // Not a real on-chain address (e.g. a dev-login placeholder like 0xDEV…). Reading the
  // chain would throw on BigInt(addr); report "unavailable" so callers keep the last-known
  // eligibility instead of erroring — and so a malformed upstream wallet degrades cleanly.
  if (!HEX_ADDRESS.test(addr)) return { creatureCount: 0, landCount: 0, holdersAvailable: false, holdersFetchedAt: null };

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
const IMX_L1_TOKEN      = '0xf57e7e7c23978c3caec3c3548e3d615c346e79ff'; // IMX (ERC-20) on Ethereum mainnet (18 decimals)
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

// Fetch an Immutable endpoint with retries on transient 5xx / 429 / network errors —
// the orderbook occasionally returns 500s that succeed on a quick retry, and bursts
// (boot builds several indexes at once) can trip the rate limit. Other 4xx (a
// malformed request on our side) fails fast.
async function imxFetch(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, (lastErr?.rateLimited ? 1200 : 500) * attempt));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return res.json();
      const err = new Error(`Immutable API ${res.status} for ${url}`);
      err.rateLimited = res.status === 429;
      if (res.status < 500 && !err.rateLimited) throw err; // our fault — retrying won't help
      lastErr = err;
    } catch (err) {
      if (err.message?.startsWith('Immutable API 4') && !err.rateLimited) throw err;
      lastErr = err;
    }
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

// Bucket sales into daily aggregates: low/high sale, total volume, and trade
// count, in both ETH and USD. Each sale: { ts, eth, usd } (usd may be null if no
// rate was available). The client picks a metric, then sums or averages per interval.
function aggregateByDay(sales) {
  const byDay = new Map();
  for (const s of sales) {
    const day = Math.floor(s.ts / DAY_MS);
    let a = byDay.get(day);
    if (!a) { a = { ethLow: s.eth, ethHigh: s.eth, ethSum: 0, count: 0, usdLow: null, usdHigh: null, usdSum: 0, usdCount: 0 }; byDay.set(day, a); }
    a.ethLow = Math.min(a.ethLow, s.eth);
    a.ethHigh = Math.max(a.ethHigh, s.eth);
    a.ethSum += s.eth;
    a.count++;
    if (s.usd != null) {
      a.usdLow = a.usdLow == null ? s.usd : Math.min(a.usdLow, s.usd);
      a.usdHigh = a.usdHigh == null ? s.usd : Math.max(a.usdHigh, s.usd);
      a.usdSum += s.usd;
      a.usdCount++;
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
      count:   s ? s.count : null,
      volEth:  s ? round4(s.ethSum) : null,
      volUsd:  s && s.usdCount ? Math.round(s.usdSum) : null,
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

// --- Marketplace: browse active Creature listings (non-custodial) ---
// Public browse surface for the Trade tab. Joins the Immutable orderbook's active ETH
// listings (cheapest first) with each token's metadata + image, so the client renders
// a grid without ever touching keys or funds. Buy/sell/cancel (which need signed
// orders) arrive in later phases. Short-cached per cursor — listings move, so freshness
// matters more here than for the slow holder/market snapshots.
const MKT_PAGE_SIZE       = 24;
const MKT_LISTINGS_TTL_MS = 60 * 1000;
const CREATURE_IMG_HOST   = 'https://cdn-production.joinhighrise.com'; // Creature art host (see CSP img-src)
const listingsCache = new Map(); // cursor ('' = first page) -> { data, at }

// A chunk of the collection still carries an older metadata format: camelCase trait
// keys ('backgroundColor') and a junk 'attributes' entry (verified live 2026-06-10 —
// 24 of 103 listed tokens). Normalize to the display form the rest of the collection
// uses, so trait filters and facets see ONE vocabulary, not two. Snake_case keys
// ('animation_url_mime_type') are technical metadata, never real traits — dropped.
function normalizeTraitType(tt) {
  const s = String(tt ?? '').trim();
  if (!s || s === 'attributes' || s.includes('_')) return null;
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\b[a-z]/g, c => c.toUpperCase());
}

// Shape a raw metadata record into just the public fields the client needs.
function shapeCreatureMeta(r, tokenId) {
  return {
    name: r.name || `Highrise Creature #${tokenId}`,
    image: r.image || null,
    description: r.description || null,
    attributes: Array.isArray(r.attributes)
      ? r.attributes
          .map(a => ({ trait: normalizeTraitType(a.trait_type), value: a.value }))
          .filter(a => a.trait && (typeof a.value === 'string' || typeof a.value === 'number'))
      : [],
  };
}

// Metadata for many tokens → Map<tokenId, meta>. The per-token metadata endpoint
// rate-limits distinct parallel calls (429s), so we never fan out: the list endpoint
// accepts repeated token_id params. But only up to ~32 of them — more is a hard 400
// (verified live 2026-06-10) — so larger requests run as sequential ≤25-id chunks.
const META_BATCH_MAX = 25;
async function fetchCreatureMetaBatch(tokenIds) {
  const out = new Map();
  for (let i = 0; i < tokenIds.length; i += META_BATCH_MAX) {
    const chunk = tokenIds.slice(i, i + META_BATCH_MAX);
    const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/collections/${CREATURE_CONTRACT}/nfts`);
    for (const id of chunk) url.searchParams.append('token_id', id);
    url.searchParams.set('page_size', String(chunk.length));
    try {
      const body = await imxFetch(url.toString());
      for (const r of (body.result ?? [])) out.set(String(r.token_id), shapeCreatureMeta(r, r.token_id));
    } catch (err) {
      console.error('Creature metadata batch failed:', err.message); // grid still renders, sans art
    }
  }
  return out;
}

// One Creature's metadata (single-token path for the detail endpoint).
async function fetchCreatureMeta(tokenId) {
  const url = `https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/collections/${CREATURE_CONTRACT}/nfts/${tokenId}`;
  try { return shapeCreatureMeta((await imxFetch(url)).result || {}, tokenId); }
  catch { return null; }
}

// A page of cheapest active ETH listings, each joined with its token metadata.
async function fetchCreatureListingsPage(cursor) {
  const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/orders/listings`);
  url.searchParams.set('sell_item_contract_address', CREATURE_CONTRACT);
  url.searchParams.set('buy_item_contract_address', IMX_ETH_TOKEN);
  url.searchParams.set('status', 'ACTIVE');
  url.searchParams.set('sort_by', 'buy_item_amount');
  url.searchParams.set('sort_direction', 'asc');
  url.searchParams.set('page_size', String(MKT_PAGE_SIZE));
  if (cursor) url.searchParams.set('page_cursor', cursor);

  const body = await imxFetch(url.toString());
  const orders = body.result ?? [];
  const metaById = await fetchCreatureMetaBatch(orders.map(o => o.sell?.[0]?.token_id).filter(Boolean));

  // The price the seller set is buy.amount; the buyer also pays the fee items on top.
  const items = orders.map(o => {
    const sell = (o.sell ?? [])[0] || {};
    const buy  = (o.buy ?? [])[0] || {};
    const tokenId = sell.token_id;
    if (!tokenId || !buy.amount) return null;
    const priceWei = BigInt(buy.amount);
    const feesWei  = (o.fees ?? []).reduce((s, f) => s + (f.amount ? BigInt(f.amount) : 0n), 0n);
    const meta = metaById.get(String(tokenId)) || {};
    return {
      listingId: o.id,
      tokenId,
      seller: o.account_address || null,
      priceEth: round4(Number(priceWei) / 1e18),
      totalEth: round4(Number(priceWei + feesWei) / 1e18),
      name: meta.name || `Highrise Creature #${tokenId}`,
      image: meta.image || null,
      rarity: meta.attributes?.find(a => /rarity/i.test(a.trait))?.value || null,
    };
  }).filter(Boolean);
  return { items, nextCursor: body.page?.next_cursor ?? null };
}

// Offers are gasless signatures — the bidder's ETH stays in THEIR wallet until fill,
// so an "ACTIVE" bid can be unfillable: balance spent or Seaport allowance revoked
// after signing. The orderbook doesn't re-validate funding, which leaves phantom
// offers (often above floor — impossible to fill, guaranteed revert + confusion).
// We verify funding on-chain before showing any offer as acceptable.
const SEAPORT_ZK    = '0x6c12ad6f0bd274191075eb2e78d7da5ba6453424'; // Immutable Seaport (the bid's ERC-20 spender)
const SEL_ALLOWANCE = '0xdd62ed3e'; // allowance(address,address)

async function offerIsFunded(o) {
  try {
    const owner = padUint(BigInt(o.from));
    const [balRaw, alwRaw] = await Promise.all([
      ethCall(ZK_RPC_URL, IMX_ETH_TOKEN, SEL_BALANCE_OF + owner),
      ethCall(ZK_RPC_URL, IMX_ETH_TOKEN, SEL_ALLOWANCE + owner + padUint(BigInt(SEAPORT_ZK))),
    ]);
    const need = BigInt(o.grossWei || '0');
    return BigInt(balRaw || '0x0') >= need && BigInt(alwRaw || '0x0') >= need;
  } catch (err) {
    console.error('Offer funding check failed:', err.message);
    return true; // fail-open: an RPC hiccup must not blank the offers UI
  }
}
async function annotateOffersFunded(offers) {
  const flags = await Promise.all((offers || []).map(offerIsFunded));
  return (offers || []).map((o, i) => ({ ...o, funded: flags[i] }));
}
// Browse/accept surfaces: hide unfunded entirely (they cannot be filled right now).
async function fundedOffersOnly(offers) {
  return (await annotateOffersFunded(offers))
    .filter(o => o.funded)
    .map(({ grossWei, funded, ...rest }) => rest);
}

// --- Transfer recipient safety checks ---
// Transfers are irreversible; these checks catch the classic loss patterns BEFORE the
// user can sign: bad EIP-55 checksum (= typo), sending to a protocol contract (asset
// gone forever), and never-used addresses (typo'd or wrong-chain destinations).
let ethersLib = null;
try { ethersLib = require('ethers'); } catch { /* transitive dep of @imtbl/orderbook — present in practice */ }

async function ethGetTxCount(rpcUrl, address) {
  const res = await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [address, 'latest'] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`eth_getTransactionCount HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'eth_getTransactionCount error');
  return parseInt(body.result, 16) || 0;
}
async function ethGetCode(rpcUrl, address) {
  const res = await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`eth_getCode HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'eth_getCode error');
  return body.result || '0x';
}

// Addresses where an NFT is irretrievably lost or obviously wrong — hard-blocked.
const KNOWN_PROTOCOL_ADDRESSES = new Set([
  CREATURE_CONTRACT.toLowerCase(),
  IMX_ETH_TOKEN, // already lowercase
  '0x6c12ad6f0bd274191075eb2e78d7da5ba6453424', // Immutable Seaport
]);

// Per-chain transfer-check context: which RPC to probe, which NFT signals "familiar
// destination", and which protocol addresses are guaranteed asset graves.
const TRANSFER_CHAINS = {
  zkevm: { rpc: () => ZK_RPC_URL, nft: CREATURE_CONTRACT, blocked: KNOWN_PROTOCOL_ADDRESSES },
  ethereum: {
    rpc: () => ETH_RPC_URL,
    nft: LAND_CONTRACT,
    blocked: new Set([
      LAND_CONTRACT,                                  // the LAND contract itself
      ESTATE_CONTRACT,                                // estates lock parcels — not a wallet
      '0x0000000000000068f116a894984e2db1123eb395',   // OpenSea Seaport 1.6
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',   // WETH
    ]),
  },
};

// Full recipient assessment on the given chain. Never throws — individual probes
// degrade to 'unknown' so a transient RPC blip can't block a legitimate transfer.
async function checkTransferRecipient(rawAddress, chain = 'zkevm') {
  const raw = String(rawAddress || '').trim();
  const lower = raw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lower)) return { valid: false, reason: 'format' };

  // EIP-55: a mixed-case address carries a checksum — if it doesn't verify, the
  // address was mistyped or corrupted. All-lowercase carries no checksum (common
  // from explorers and wallets), so there's nothing to verify.
  const hex = raw.slice(2);
  const isMixedCase = /[a-f]/.test(hex) && /[A-F]/.test(hex);
  let checksum = 'none';
  if (isMixedCase) {
    checksum = 'bad';
    if (ethersLib) { try { ethersLib.getAddress(raw); checksum = 'ok'; } catch { /* stays bad */ } }
    else checksum = 'none'; // can't verify without ethers — treat as unverifiable, not bad
  }
  if (checksum === 'bad') return { valid: false, reason: 'checksum' };

  const ctx = TRANSFER_CHAINS[chain] || TRANSFER_CHAINS.zkevm;
  if (ctx.blocked.has(lower)) return { valid: false, reason: 'protocol' };

  const rpc = ctx.rpc();
  const [code, txCount, native, creatures] = await Promise.all([
    ethGetCode(rpc, lower).catch(() => null),
    ethGetTxCount(rpc, lower).catch(() => null),
    ethGetBalance(rpc, lower).catch(() => null),
    erc721BalanceOf(rpc, ctx.nft, lower).catch(() => null),
  ]);
  const isContract = code != null && code !== '0x';
  // "Active" = any sign of life on Immutable zkEVM: sent txs, holds IMX, or holds
  // Creatures. A deployed contract also counts (it exists on this chain).
  const active = (txCount ?? 0) > 0
    || (native != null && BigInt(native) > 0n)
    || (creatures ?? 0) > 0
    || isContract;
  return {
    valid: true,
    checksum,                      // 'ok' (verified) | 'none' (lowercase, unverifiable)
    contract: isContract,          // safeTransferFrom still guards receivers on-chain
    active,
    activityKnown: txCount != null || native != null || creatures != null || code != null,
    creatures: creatures ?? null,  // nice signal: recipient already holds Creatures
  };
}

// Parse a user-supplied decimal ETH string into wei, exactly (no floats).
// Returns a BigInt or null when the input isn't a sane positive amount.
function parseEthToWei(s) {
  const m = /^(\d{1,6})(?:\.(\d{1,18}))?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const wei = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0'));
  return wei > 0n ? wei : null;
}

// All Creatures owned by one wallet (for the sell picker): [{tokenId, name, image}].
// Public on-chain data; the client only ever asks for its own connected address.
async function getOwnedCreatures(address) {
  const items = [];
  let cursor = null, pages = 0;
  do {
    const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/accounts/${address}/nfts`);
    url.searchParams.set('contract_address', CREATURE_CONTRACT);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('page_cursor', cursor);
    const body = await imxFetch(url.toString());
    for (const n of (body.result ?? [])) {
      const tokenId = String(n.token_id);
      // Capture any inline attributes immediately so traits exist even if the catalogue
      // (statistical rank) isn't warm yet; the catalogue overlay below refines them.
      const traits = {};
      for (const a of (n.attributes ?? [])) {
        const type = a.trait_type || a.trait || a.name;
        if (type && a.value != null && a.value !== '') traits[String(type)] = String(a.value);
      }
      items.push({ tokenId, name: n.name || `Highrise Creature #${tokenId}`, image: n.image || null, traits });
    }
    cursor = body.page?.next_cursor ?? null;
    pages++;
  } while (cursor && pages < 5); // 500 Creatures is plenty for a picker
  // Traits come from each NFT's inline attributes above — enough for the Sell/Transfer
  // inventory filters (incl. the Rarity tier). We deliberately DON'T join the browse
  // catalogue for a statistical rank: the account endpoint's packed token_id doesn't
  // match the collection endpoint's, and awaiting a cold catalogue build would stall the
  // picker. The client sorts "Rarest first" by the Rarity tier instead.
  return { items, truncated: !!cursor };
}

// One wallet's ACTIVE listings for the Creature collection (for "My listings").
async function getMyListings(address) {
  const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/orders/listings`);
  url.searchParams.set('sell_item_contract_address', CREATURE_CONTRACT);
  url.searchParams.set('account_address', address);
  url.searchParams.set('status', 'ACTIVE');
  url.searchParams.set('page_size', '50');
  const body = await imxFetch(url.toString());
  const orders = body.result ?? [];
  const metaById = await fetchCreatureMetaBatch(orders.map(o => o.sell?.[0]?.token_id).filter(Boolean));
  return {
    items: orders.map(o => {
      const tokenId = o.sell?.[0]?.token_id;
      const amount = o.buy?.[0]?.amount;
      if (!tokenId || !amount) return null;
      const meta = metaById.get(String(tokenId)) || {};
      return {
        listingId: o.id,
        tokenId,
        priceEth: round4(Number(BigInt(amount)) / 1e18),
        name: meta.name || `Highrise Creature #${tokenId}`,
        image: meta.image || null,
      };
    }).filter(Boolean),
  };
}

// A wallet's Creature HISTORY for the collection: trades (bought / sold), transfers
// (received / sent / minted), and listing-lifecycle events that never transacted
// (cancelled / expired). Read-only by address — the wallet signs nothing. Two sources,
// merged newest-first:
//   • the activities feed (account-filtered) → on-chain buys, sales and transfers;
//   • the orders API → the wallet's CANCELLED / EXPIRED listings (a FILLED listing is the
//     same event as its 'sold' sale, so it's excluded here to avoid a duplicate row).
// LAND has no equivalent maker-scoped feed (OpenSea returns only live orders), so the
// History tab — and this function — are Creatures-only.
const ACTIVITY_PAGES_MAX = 2; // newest ~200 activities — far more than the rendered cap
const HISTORY_ITEMS_MAX = 80;

async function getMyListingHistory(address) {
  const addr = address.toLowerCase();

  // 1) On-chain activity — one chronological (newest-first) feed, account-filtered.
  // A marketplace sale emits BOTH a 'sale' and a paired 'transfer' (same tx hash); we keep
  // the 'sale' (it carries price + direction) and drop that transfer leg, so the NFT-moving
  // side of a trade isn't shown twice. Collect every sale's tx first, then categorize.
  const acts = [];
  const saleTxs = new Set();
  let activityFailed = false;
  try {
    let cursor = null, pages = 0;
    do {
      const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/activities`);
      url.searchParams.set('contract_address', CREATURE_CONTRACT);
      url.searchParams.set('account_address', addr);
      url.searchParams.set('page_size', '100');
      if (cursor) url.searchParams.set('page_cursor', cursor);
      const body = await imxFetch(url.toString());
      for (const a of (body.result ?? [])) {
        if (a.type === 'sale') { const tx = a.blockchain_metadata?.transaction_hash; if (tx) saleTxs.add(tx); }
        acts.push(a);
      }
      cursor = body.page?.next_cursor ?? null;
    } while (cursor && ++pages < ACTIVITY_PAGES_MAX);
  } catch (err) { activityFailed = true; console.error('Creature activity feed failed:', err.message); }

  const entries = [];
  for (const a of acts) {
    const d = a.details || {};
    const at = a.updated_at || a.indexed_at || null;
    const tx = a.blockchain_metadata?.transaction_hash || null;
    if (a.type === 'sale') {
      const asset = Array.isArray(d.asset) ? d.asset[0] : d.asset; // sale.asset is an array
      const tokenId = asset?.token_id;
      if (!tokenId) continue;
      const isBuyer = (d.to || '').toLowerCase() === addr;
      const payToken = (d.payment?.token?.contract_address || '').toLowerCase();
      const priceWei = d.payment?.price_including_fees; // headline all-in trade price
      const priceEth = payToken === IMX_ETH_TOKEN && priceWei ? round4(Number(BigInt(priceWei)) / 1e18) : null;
      entries.push({ kind: isBuyer ? 'bought' : 'sold', tokenId, priceEth, at, tx,
        with: ((isBuyer ? d.from : d.to) || '').toLowerCase() || null });
    } else if (a.type === 'transfer') {
      if (tx && saleTxs.has(tx)) continue; // NFT leg of a sale — already shown as bought/sold
      const tokenId = d.asset?.token_id;
      if (!tokenId) continue;
      const from = (d.from || '').toLowerCase();
      const isReceiver = (d.to || '').toLowerCase() === addr;
      const kind = from === ZERO_ADDRESS ? 'minted' : isReceiver ? 'received' : 'sent';
      entries.push({ kind, tokenId, priceEth: null, at, tx,
        with: kind === 'minted' ? null : ((isReceiver ? d.from : d.to) || '').toLowerCase() || null });
    }
  }

  // 2) Listing-lifecycle events that never transacted (cancelled / expired). One status per
  // request (the API's status filter takes a single value), in parallel; one failing still
  // yields the other.
  const LISTING_KIND = { CANCELLED: 'cancelled', EXPIRED: 'expired' };
  const fetchStatus = async status => {
    const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/orders/listings`);
    url.searchParams.set('sell_item_contract_address', CREATURE_CONTRACT);
    url.searchParams.set('account_address', addr);
    url.searchParams.set('status', status);
    url.searchParams.set('page_size', '30');
    const body = await imxFetch(url.toString());
    return (body.result ?? []).map(o => ({ o, status }));
  };
  const settled = await Promise.allSettled(Object.keys(LISTING_KIND).map(fetchStatus));
  settled.forEach((s, i) => { if (s.status === 'rejected') console.error(`Listing history [${Object.keys(LISTING_KIND)[i]}] failed:`, s.reason?.message); });
  // Every upstream source failed — surface it as an error so the client shows "couldn't
  // load" rather than a misleading "no activity yet".
  if (activityFailed && settled.every(s => s.status === 'rejected')) {
    throw Object.assign(new Error('unavailable'), { code: 'unavailable', statusCode: 503 });
  }
  for (const { o, status } of settled.flatMap(s => s.status === 'fulfilled' ? s.value : [])) {
    const tokenId = o.sell?.[0]?.token_id;
    const amount = o.buy?.[0]?.amount;
    if (!tokenId || !amount) continue;
    entries.push({
      kind: LISTING_KIND[status], tokenId,
      priceEth: round4(Number(BigInt(amount)) / 1e18),
      at: o.updated_at || o.created_at || null, tx: null, with: null,
    });
  }

  // Merge, newest-first, cap, then join token metadata in one batch.
  const items = entries
    .filter(e => e.at)
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
    .slice(0, HISTORY_ITEMS_MAX);
  const metaById = await fetchCreatureMetaBatch([...new Set(items.map(i => String(i.tokenId)))]);
  for (const it of items) {
    const meta = metaById.get(String(it.tokenId)) || {};
    it.name = meta.name || `Highrise Creature #${it.tokenId}`;
    it.image = meta.image || null;
  }
  return { items };
}

// ETH→USD plus USD-relative rates for every display currency, in ONE CoinGecko call.
// Independent of the heavy market-stats cache (which can be cold on a fresh boot, so
// listings used to render with no fiat). Own short cache — FX barely moves minute to
// minute. Degrades to the last good value, or USD-only, on failure.
const mktFxCache = { data: null, at: 0 };
const MKT_FX_TTL_MS = 10 * 60 * 1000;
async function getMarketplaceFx() {
  if (mktFxCache.data && Date.now() - mktFxCache.at < MKT_FX_TTL_MS) return mktFxCache.data;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=${FX_CURRENCIES.join(',')}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) },
    );
    if (!res.ok) throw new Error(`CoinGecko FX ${res.status}`);
    const eth = (await res.json()).ethereum || {};
    const ethUsd = eth.usd ?? null;
    const fxRates = { usd: 1 }; // USD-relative display rates (rate.usd === 1)
    if (ethUsd) for (const c of FX_CURRENCIES) if (c !== 'usd' && eth[c] != null) fxRates[c] = eth[c] / ethUsd;
    const data = { ethUsd, fxRates };
    mktFxCache.data = data; mktFxCache.at = Date.now();
    return data;
  } catch (err) {
    console.error('Marketplace FX failed:', err.message);
    return mktFxCache.data || { ethUsd: null, fxRates: { usd: 1 } };
  }
}

async function getCreatureListings(cursor = '') {
  const key = cursor || '';
  const hit = listingsCache.get(key);
  if (hit && Date.now() - hit.at < MKT_LISTINGS_TTL_MS) return hit.data;
  const [page, fx] = await Promise.all([fetchCreatureListingsPage(cursor), getMarketplaceFx()]);
  const data = {
    items: page.items,
    nextCursor: page.nextCursor,
    ethUsd: fx.ethUsd,
    fxRates: fx.fxRates, // { usd:1, eur, gbp, brl, rub, try, jpy, cad, aud } for the currency picker
    fetchedAt: new Date().toISOString(),
  };
  if (listingsCache.size > 64) listingsCache.clear(); // bound memory from many distinct cursors
  listingsCache.set(key, { data, at: Date.now() });
  return data;
}

// Full detail for one token: metadata + current on-chain owner (read straight from the
// contract). The active listing, if any, is supplied client-side from the grid card.
async function getCreatureToken(tokenId) {
  const [meta, ownerRaw] = await Promise.all([
    fetchCreatureMeta(tokenId),
    ethCall(ZK_RPC_URL, CREATURE_CONTRACT, SEL_OWNER_OF + padUint(BigInt(tokenId))).catch(() => null),
  ]);
  const owner = ownerRaw && ownerRaw.length >= 42 ? ('0x' + ownerRaw.slice(-40)).toLowerCase() : null;
  const coll = getCollectionIndex(); // statistical rank, when the index is built
  return {
    tokenId,
    name: meta?.name || `Highrise Creature #${tokenId}`,
    image: meta?.image || null,
    description: meta?.description || null,
    attributes: meta?.attributes || [],
    owner,
    rank: coll?.byId.get(String(tokenId))?.rank ?? null,
    rankOf: coll?.total ?? null,
  };
}

// --- Marketplace: filterable browse (IMX-Rarity-style explorer) ---
// One in-memory snapshot of EVERY active ETH listing joined with its full metadata,
// rebuilt at most once a minute. Stale-while-revalidate: once the first snapshot
// exists, no request ever waits on a rebuild. Filtering, faceting, and sorting then
// happen in-process per request — zero upstream calls per filter change, so clicking
// through traits stays instant and can't exhaust the Immutable rate limits.
const BROWSE_TTL_MS    = 60 * 1000;
const BROWSE_MAX_PAGES = 5;   // 5 × 200 = 1000 listings indexed — far above today's ~100
const BROWSE_PAGE_SIZE = 24;
const RARITY_ORDER = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common']; // best first
const rarityRank = r => { const i = RARITY_ORDER.indexOf(r); return i === -1 ? RARITY_ORDER.length : i; };
const browseIndex = { data: null, at: 0, inFlight: null };

async function buildBrowseIndex() {
  // 1) Every active ETH listing, cheapest first, across however many pages exist.
  const orders = [];
  let cursor = null, pages = 0;
  do {
    const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/orders/listings`);
    url.searchParams.set('sell_item_contract_address', CREATURE_CONTRACT);
    url.searchParams.set('buy_item_contract_address', IMX_ETH_TOKEN);
    url.searchParams.set('status', 'ACTIVE');
    url.searchParams.set('sort_by', 'buy_item_amount');
    url.searchParams.set('sort_direction', 'asc');
    url.searchParams.set('page_size', '200');
    if (cursor) url.searchParams.set('page_cursor', cursor);
    const body = await imxFetch(url.toString());
    orders.push(...(body.result ?? []));
    cursor = body.page?.next_cursor ?? null;
  } while (cursor && ++pages < BROWSE_MAX_PAGES);

  // 2) Metadata. Traits are immutable, so the full-collection index (once built) is
  //    the authoritative source — zero metadata API calls per rebuild, and a transient
  //    upstream 429 can't blank a snapshot's traits. Only tokens the index doesn't
  //    know (not built yet, or a gap) hit the batch endpoint.
  const collIdx = collectionIndex.data;
  const ids = [...new Set(orders.map(o => o.sell?.[0]?.token_id).filter(Boolean).map(String))];
  const metaById = await fetchCreatureMetaBatch(collIdx ? ids.filter(id => !collIdx.byId.has(id)) : ids);

  // 3) Join into flat filterable rows. `traits`/`listedAt` stay server-side; the wire
  //    item matches the /listings shape the grid and buy flow already render.
  const items = orders.map(o => {
    const sell = (o.sell ?? [])[0] || {};
    const buy  = (o.buy ?? [])[0] || {};
    const tokenId = sell.token_id;
    if (!tokenId || !buy.amount) return null;
    const priceWei = BigInt(buy.amount);
    const feesWei  = (o.fees ?? []).reduce((s, f) => s + (f.amount ? BigInt(f.amount) : 0n), 0n);
    const known = collIdx?.byId.get(String(tokenId));
    const meta = metaById.get(String(tokenId));
    const traits = {};
    if (known) Object.assign(traits, known.traits);
    else if (meta) for (const a of (meta.attributes || [])) traits[a.trait] = String(a.value);
    return {
      listingId: o.id,
      tokenId,
      seller: o.account_address || null,
      priceEth: round4(Number(priceWei) / 1e18),
      totalEth: round4(Number(priceWei + feesWei) / 1e18),
      name: known?.name || meta?.name || `Highrise Creature #${tokenId}`,
      image: known?.image || meta?.image || null,
      rarity: Object.entries(traits).find(([k]) => /rarity/i.test(k))?.[1] || null,
      listedAt: Date.parse(o.created_at) || 0,
      traits,
    };
  }).filter(Boolean);
  return { items, truncated: !!cursor };
}

async function getBrowseIndex() {
  const fresh = browseIndex.data && Date.now() - browseIndex.at < BROWSE_TTL_MS;
  if (!fresh && !browseIndex.inFlight) {
    browseIndex.inFlight = buildBrowseIndex()
      .then(d => { browseIndex.data = d; browseIndex.at = Date.now(); return d; })
      .catch(err => {
        console.error('Browse index build failed:', err.message);
        if (!browseIndex.data) throw err; // cold boot with nothing to serve → surface it
        return browseIndex.data;          // refresh hiccup → keep serving the stale copy
      })
      .finally(() => { browseIndex.inFlight = null; });
  }
  return browseIndex.data || browseIndex.inFlight;
}

// Wire format: q (name substring), min/max (ETH, vs the all-in price), sort,
// page (offset into the filtered set), and repeated t=Type:Value params —
// multi-select is OR within a type, AND across types (standard faceted search).
function parseBrowseQuery(searchParams) {
  const q = (searchParams.get('q') || '').trim().toLowerCase().slice(0, 80);
  const num = v => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? n : null; };
  const traits = new Map(); // type -> Set(values)
  for (const pair of searchParams.getAll('t').slice(0, 40)) {
    const i = pair.indexOf(':');
    if (i < 1) continue;
    const type = pair.slice(0, i).slice(0, 60);
    const value = pair.slice(i + 1).slice(0, 120);
    if (!value) continue;
    if (!traits.has(type)) traits.set(type, new Set());
    traits.get(type).add(value);
  }
  const sort = ['price-asc', 'price-desc', 'newest', 'rarity'].includes(searchParams.get('sort'))
    ? searchParams.get('sort') : 'price-asc';
  const page = Math.min(500, Math.max(0, parseInt(searchParams.get('page'), 10) || 0));
  const scope = searchParams.get('scope') === 'all' ? 'all' : 'listed';
  return { q, min: num(searchParams.get('min')), max: num(searchParams.get('max')), traits, sort, page, scope };
}

// skipType: evaluate every filter EXCEPT that trait type — how facet counts answer
// "what would I get if I picked this value", given everything else stays selected.
function browseMatch(it, f, skipType) {
  // `search` lets a row be findable by more than its name (slimes: nickname + coords).
  if (f.q && !(it.search || it.name || '').toLowerCase().includes(f.q)) return false;
  // Unlisted rows have no price — a price filter implies "for sale", so they drop out.
  const price = it.totalEth ?? it.priceEth ?? null;
  if (f.min != null && (price == null || price < f.min)) return false;
  if (f.max != null && (price == null || price > f.max)) return false;
  for (const [type, values] of f.traits) {
    if (type !== skipType && !values.has(it.traits[type])) return false;
  }
  return true;
}

// Unlisted rows (no price) sink to the end of price sorts; statistical rank breaks
// every tie so ordering is stable across snapshot rebuilds.
const browsePriceOf = it => it.totalEth ?? it.priceEth ?? null;
const browseRankOf  = it => it.rank ?? Number.MAX_SAFE_INTEGER;
function cmpBrowsePrice(a, b, dir) {
  const pa = browsePriceOf(a), pb = browsePriceOf(b);
  if (pa != null && pb != null) return dir * (pa - pb) || browseRankOf(a) - browseRankOf(b);
  if (pa != null) return -1;
  if (pb != null) return 1;
  return browseRankOf(a) - browseRankOf(b);
}
const BROWSE_SORTS = {
  'price-asc':  (a, b) => cmpBrowsePrice(a, b, 1),
  'price-desc': (a, b) => cmpBrowsePrice(a, b, -1),
  'newest':     (a, b) => (b.listedAt ?? 0) - (a.listedAt ?? 0) || browseRankOf(a) - browseRankOf(b),
  // True statistical rank when the collection index is built; tier order until then.
  'rarity':     (a, b) => (a.rank != null && b.rank != null)
    ? a.rank - b.rank
    : (rarityRank(a.rarity) - rarityRank(b.rarity) || cmpBrowsePrice(a, b, 1)),
};

// Facets over the whole snapshot: every trait value that exists in ANY active listing
// renders in the filter UI, with its count under the current other filters (0 = picking
// it would empty the grid — shown disabled, never hidden, so the vocabulary is stable).
function computeBrowseFacets(items, f) {
  const types = new Map(); // type -> Map(value -> count)
  for (const it of items) {
    for (const [type, v] of Object.entries(it.traits)) {
      if (!types.has(type)) types.set(type, new Map());
      const vals = types.get(type);
      if (!vals.has(v)) vals.set(v, 0);
    }
  }
  for (const [type, vals] of types) {
    for (const it of items) {
      const v = it.traits[type];
      if (v !== undefined && browseMatch(it, f, type)) vals.set(v, vals.get(v) + 1);
    }
  }
  const out = [];
  for (const [type, vals] of types) {
    const values = [...vals.entries()].map(([v, n]) => ({ v, n }));
    if (/rarity/i.test(type)) values.sort((a, b) => rarityRank(a.v) - rarityRank(b.v));
    else values.sort((a, b) => a.v.localeCompare(b.v));
    out.push({ type, values });
  }
  out.sort((a, b) => a.type.localeCompare(b.type));
  return out;
}

// --- Full-collection index: every Creature's traits + a statistical rarity rank ---
// Traits are immutable, so this builds once (~56 paged calls, well under a minute) in
// the background at boot and refreshes daily. It powers scope=all browsing and the
// rank chips. Until the first build lands, browse quietly serves listed-only and
// flags `indexing` so the client can say "hold on, cataloguing".
const COLLECTION_TTL_MS    = 24 * 60 * 60 * 1000;
const COLLECTION_MAX_PAGES = 120;      // 120 × 200 = 24k — far above the 11,111 supply
const COLLECTION_RETRY_MS  = 60 * 1000; // failed build → cool off before trying again
const collectionIndex = { data: null, at: 0, inFlight: null, failedAt: 0 };

async function buildCollectionIndex() {
  const byId = new Map();
  let cursor = null, pages = 0;
  do {
    const url = new URL(`https://api.immutable.com/v1/chains/${IMX_ZKEVM_CHAIN}/collections/${CREATURE_CONTRACT}/nfts`);
    url.searchParams.set('page_size', '200');
    if (cursor) url.searchParams.set('page_cursor', cursor);
    const body = await imxFetch(url.toString());
    for (const r of (body.result ?? [])) {
      const meta = shapeCreatureMeta(r, r.token_id);
      const traits = {};
      for (const a of meta.attributes) traits[a.trait] = String(a.value);
      byId.set(String(r.token_id), {
        tokenId: String(r.token_id),
        name: meta.name,
        image: meta.image,
        rarity: meta.attributes.find(a => /rarity/i.test(a.trait))?.value || null,
        traits,
      });
    }
    cursor = body.page?.next_cursor ?? null;
    if (cursor) await new Promise(r => setTimeout(r, 120)); // pace the sweep
  } while (cursor && ++pages < COLLECTION_MAX_PAGES);

  // Statistical rarity, the formula IMX Rarity used: a token's score is the sum of
  // 1/frequency across its trait values, so rare values dominate. Rank 1 = rarest.
  const freq = new Map();
  for (const it of byId.values()) {
    for (const [type, v] of Object.entries(it.traits)) {
      const k = `${type}:${v}`;
      freq.set(k, (freq.get(k) || 0) + 1);
    }
  }
  const total = byId.size;
  for (const it of byId.values()) {
    let score = 0;
    for (const [type, v] of Object.entries(it.traits)) score += total / freq.get(`${type}:${v}`);
    it.score = score;
  }
  const items = [...byId.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  items.forEach((it, i) => { it.rank = i + 1; });
  console.log(`Creature collection index built: ${total} tokens across ${pages + 1} pages.`);
  return { byId, items, total, builtAt: Date.now() };
}

// Non-blocking accessor: returns the index when built (kicking a refresh once stale),
// null while the first build is running — callers degrade to listed-only meanwhile.
function getCollectionIndex() {
  const fresh = collectionIndex.data && Date.now() - collectionIndex.at < COLLECTION_TTL_MS;
  const cooling = Date.now() - collectionIndex.failedAt < COLLECTION_RETRY_MS;
  if (!fresh && !collectionIndex.inFlight && !cooling) {
    collectionIndex.inFlight = buildCollectionIndex()
      .then(d => { collectionIndex.data = d; collectionIndex.at = Date.now(); return d; })
      .catch(err => { collectionIndex.failedAt = Date.now(); console.error('Collection index build failed:', err.message); })
      .finally(() => { collectionIndex.inFlight = null; });
  }
  return collectionIndex.data;
}
getCollectionIndex(); // warm it at boot, in the background
setInterval(() => { getCollectionIndex(); }, 60 * 60 * 1000).unref(); // hourly check; TTL gates the rebuild

// Browse pools, memoized per (listings snapshot, collection build) pair so the merge
// cost is paid once per 60s snapshot rebuild, not once per request.
function listedPoolOf(listIdx, coll) {
  if (listIdx._listedPool && listIdx._poolColl === coll) return listIdx._listedPool;
  listIdx._listedPool = listIdx.items.map(it =>
    ({ ...it, listed: true, rank: coll?.byId.get(String(it.tokenId))?.rank ?? null }));
  listIdx._poolColl = coll;
  listIdx._allPool = null;
  return listIdx._listedPool;
}
function allPoolOf(listIdx, coll) {
  const listed = listedPoolOf(listIdx, coll); // also keys the memo to this coll build
  if (listIdx._allPool) return listIdx._allPool;
  const listedById = new Map(listed.map(it => [String(it.tokenId), it]));
  listIdx._allPool = coll.items.map(c => listedById.get(c.tokenId)
    || { tokenId: c.tokenId, name: c.name, image: c.image, rarity: c.rarity, rank: c.rank, traits: c.traits, listed: false });
  return listIdx._allPool;
}

async function getCreatureBrowse(searchParams) {
  const f = parseBrowseQuery(searchParams);
  const [listIdx, fx] = await Promise.all([getBrowseIndex(), getMarketplaceFx()]);
  const coll = getCollectionIndex(); // null until the first build lands
  const wantAll = f.scope === 'all';
  const pool = wantAll && coll ? allPoolOf(listIdx, coll) : listedPoolOf(listIdx, coll);

  const matched = pool.filter(it => browseMatch(it, f)).sort(BROWSE_SORTS[f.sort]);
  const start = f.page * BROWSE_PAGE_SIZE;
  let lo = null, hi = null;
  for (const it of listIdx.items) {
    const p = it.totalEth ?? it.priceEth;
    if (lo === null || p < lo) lo = p;
    if (hi === null || p > hi) hi = p;
  }
  return {
    items: matched.slice(start, start + BROWSE_PAGE_SIZE).map(({ traits, listedAt, ...pub }) => pub),
    total: matched.length,
    page: f.page,
    hasMore: start + BROWSE_PAGE_SIZE < matched.length,
    scope: wantAll && coll ? 'all' : 'listed',
    indexing: wantAll && !coll,                  // asked for everything; still cataloguing
    facets: computeBrowseFacets(pool, f),
    priceRange: lo === null ? null : { min: lo, max: hi },
    listedTotal: listIdx.items.length,
    collectionTotal: coll?.total ?? null,
    truncated: listIdx.truncated,
    ethUsd: fx.ethUsd,
    fxRates: fx.fxRates,
    fetchedAt: new Date().toISOString(),
  };
}

// --- Unified LAND browse: every parcel, shown via its attached Slime ---
// A LAND parcel and its Slime are ONE NFT — you buy the parcel, the slime comes with
// it — so there's a single faceted browse: filter parcels by their slime's traits +
// rarity rank, price/buyability from the parcel's OpenSea listing. The catalogue
// (traits, rank) comes from the background slime sweep (lib/slime-index); listings come
// from OpenSea. Reuses the Creature browse machinery (parseBrowseQuery / browseMatch /
// computeBrowseFacets / BROWSE_SORTS) by shaping each parcel into the same row contract.
slimeIndex.getSlimeIndex(); // warm the sweep at boot, in the background

// All active LAND listings as Map<tokenId, listing>, briefly cached — merged into the
// parcel rows so a listed parcel shows its price and is buyable.
const slimeListingsCache = { data: null, at: 0 };
const LAND_LISTINGS_TTL_MS = 30 * 1000; // shorter than Creatures: OpenSea indexes new listings within seconds
// `force` bypasses the cache READ (still refreshes it) — used right after a listing is
// created so the freshly-indexed order overwrites any cached "not listed yet" snapshot.
async function landListingsByToken(force = false) {
  if (!force && slimeListingsCache.data && Date.now() - slimeListingsCache.at < LAND_LISTINGS_TTL_MS) return slimeListingsCache.data;
  const map = new Map();
  if (landMarket.configured()) {
    let cursor = '', pages = 0;
    do {
      const { items, nextCursor } = await landMarket.listListings(cursor);
      for (const it of items) if (!map.has(String(it.tokenId))) map.set(String(it.tokenId), it);
      cursor = nextCursor;
    } while (cursor && ++pages < 20);
  }
  slimeListingsCache.data = map; slimeListingsCache.at = Date.now();
  return map;
}

const landRowOf = (s, L) => ({
  tokenId: s.tokenId,
  coords: s.coords,
  name: s.slimeName || s.parcelName,
  slimeName: s.slimeName,
  parcelName: s.parcelName,
  search: `${s.slimeName || ''} ${s.parcelName} ${s.coords.x} ${s.coords.y}`,
  traits: s.traits,
  rank: s.rank,
  listed: !!L,
  priceEth: L ? L.priceEth : null,
  totalEth: L ? L.priceEth : null, // OpenSea price is already all-in
  listingId: L ? L.orderHash : null,
  protocolAddress: L ? L.protocolAddress : null,
  seller: L ? L.seller : null,
  listedAt: 0,
});
// A listed parcel the slime catalogue doesn't know yet (still sweeping, or the rare
// parcel with no pet) must still appear for sale — just without traits/rank.
const listingRowOf = (tokenId, L) => landRowOf({
  tokenId, coords: L.coords || {}, slimeName: null,
  parcelName: L.name || `LAND #${tokenId}`, traits: {}, rank: null,
}, L);

async function getLandBrowse(searchParams) {
  const f = parseBrowseQuery(searchParams);
  const [fx, listings] = await Promise.all([getMarketplaceFx(), landListingsByToken()]);
  const index = slimeIndex.getSlimeIndex(); // null while the first sweep runs

  const rows = [];
  const seen = new Set();
  if (index) for (const s of index.items) { seen.add(String(s.tokenId)); rows.push(landRowOf(s, listings.get(String(s.tokenId)))); }
  // Listed parcels missing from the catalogue still show for sale (completeness — a
  // marketplace must never hide a buyable item behind an unfinished index).
  for (const [tokenId, L] of listings) if (!seen.has(tokenId)) rows.push(listingRowOf(tokenId, L));

  const wantAll = f.scope === 'all';
  const pool = wantAll ? rows : rows.filter(r => r.listed);
  const matched = pool.filter(it => browseMatch(it, f)).sort(BROWSE_SORTS[f.sort]);
  const start = f.page * BROWSE_PAGE_SIZE;
  let lo = null, hi = null;
  for (const r of rows) {
    if (r.totalEth == null) continue;
    if (lo === null || r.totalEth < lo) lo = r.totalEth;
    if (hi === null || r.totalEth > hi) hi = r.totalEth;
  }
  // Attach a collection-wide rarity % to every trait value: the share of ALL catalogued
  // slimes that carry it. It's a stable property of the collection, so it's read from the
  // index's traitFreq (not the filtered pool) — `n` already tells "how many match now".
  const facets = index ? computeBrowseFacets(pool, f) : [];
  if (index && index.total) for (const facet of facets) for (const val of facet.values) {
    const c = index.traitFreq.get(`${facet.type}:${val.v}`);
    if (c != null) { val.total = c; val.pct = c / index.total; }
  }
  return {
    // traits stay on the row (only a few small fields) so the modal needs no extra fetch.
    items: matched.slice(start, start + BROWSE_PAGE_SIZE).map(({ search, listedAt, ...pub }) => pub),
    total: matched.length,
    page: f.page,
    hasMore: start + BROWSE_PAGE_SIZE < matched.length,
    scope: wantAll ? 'all' : 'listed',
    // 'all' needs the full catalogue; until it's built we can only show listed parcels.
    indexing: !index,
    facets,
    priceRange: lo === null ? null : { min: lo, max: hi },
    listedTotal: rows.reduce((n, r) => n + (r.listed ? 1 : 0), 0),
    collectionTotal: index ? index.total : null,
    ethUsd: fx.ethUsd,
    fxRates: fx.fxRates,
    fetchedAt: new Date().toISOString(),
  };
}

// Public marketplace API — browse only (no auth, no wallet, nothing sensitive).
// --- Transak card on-ramp (secure widget URL) — CURRENTLY INACTIVE ------------------------
// This is the "mint through OUR OWN Transak partner account" path. It's NOT wired into the
// on-ramp handler: that routes through Immutable's hosted checkout instead (immutableOnrampUrl
// below), which rides Immutable's account and needs no creds of ours. Our account's session API
// returns 401 errorCode 1002 pending Transak activation / backend-IP allowlisting. Kept for a
// possible future switch to our own account (fee capture); see the on-ramp note in README.md.
//
// Transak deprecated query-param widget URLs (June 2026 migration): every direct
// global.transak.com/?apiKey=… link now fails with a generic error. The widget loads only
// with a sessionId minted by a backend call. We run Transak's two-step flow — refresh-token →
// create-session — entirely server-side (the secret never leaves here) and hand the client a
// short-lived (5 min, single-use) widget URL. Staging keys work only on the -stg hosts.
const TRANSAK_HOSTS = TRANSAK_ENV === 'staging'
  ? { auth: 'https://api-stg.transak.com', gateway: 'https://api-gateway-stg.transak.com' }
  : { auth: 'https://api.transak.com',     gateway: 'https://api-gateway.transak.com' };
const transakOnrampConfigured = () => !!(TRANSAK_API_KEY && TRANSAK_API_SECRET);

// Partner access token: valid ~7 days, but Transak honours only the LATEST issued token, so a
// refresh elsewhere can invalidate ours before it expires. We cache one and, on a 401/403 from
// the session call, bust + refresh once. The refresh call is the only one carrying the secret.
let transakToken = { value: null, expiresAtMs: 0 };
async function transakAccessToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && transakToken.value && now < transakToken.expiresAtMs - 60_000) return transakToken.value;
  // Auth is the api-secret header + apiKey in the body (matches Transak's working partner
  // integrations). A real User-Agent/Accept is essential: Node's native fetch sends a bot-like
  // default UA that Transak's Cloudflare WAF 429s with an HTML challenge — the proven SDKs use
  // an HTTP client that sets a normal UA, which is the actual difference, not any auth header.
  const res = await fetch(`${TRANSAK_HOSTS.auth}/partners/api/v2/refresh-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'HighriseCreatureClub/1.0 (+https://highrisecreatureclub.com)',
      'api-secret': TRANSAK_API_SECRET,
    },
    body: JSON.stringify({ apiKey: TRANSAK_API_KEY }),
  });
  if (!res.ok) throw new Error(`transak refresh-token ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json().catch(() => ({}));
  const token = j?.data?.accessToken;
  const expSec = Number(j?.data?.expiresAt); // unix seconds
  console.log(`[transak] refresh ok: tokenLen=${token ? String(token).length : 0} keys=${Object.keys(j?.data || {}).join(',')} exp=${expSec}`); // TODO: drop after diagnosis
  if (!token) throw new Error('transak refresh-token: missing accessToken');
  transakToken = { value: token, expiresAtMs: Number.isFinite(expSec) ? expSec * 1000 : now + 6 * 86400 * 1000 };
  return token;
}

// Mint one widget URL. `network` is pinned ('immutablezkevm' | 'ethereum') so funds land on the
// right chain; cryptoCurrencyCode forces the token (and is required for defaultCryptoAmount to
// apply); disableWalletAddressForm locks the destination to the buyer's wallet. The access
// token is cached for its full ~7-day life — refresh-token is heavily rate-limited (429s on
// abuse), so we never auto-refresh on a transient 401; the cache expiry drives refreshes.
async function transakWidgetUrl(opts) {
  const { network, token, address, fiatUsd, referrerDomain } = opts;
  const accessToken = await transakAccessToken();
  const widgetParams = {
    apiKey: TRANSAK_API_KEY,
    referrerDomain,
    productsAvailed: 'BUY',
    network,
    cryptoCurrencyCode: token,
    walletAddress: address,
    disableWalletAddressForm: true,
  };
  // Prefill in fiat (the buyer pays in fiat anyway, and the crypto-amount field is integer-only).
  if (Number.isFinite(fiatUsd) && fiatUsd > 0) {
    widgetParams.defaultFiatAmount = Math.round(fiatUsd);
    widgetParams.defaultFiatCurrency = 'USD';
  }
  // The session call authenticates with the access-token header; same UA/Accept as refresh.
  const res = await fetch(`${TRANSAK_HOSTS.gateway}/api/v2/auth/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'HighriseCreatureClub/1.0 (+https://highrisecreatureclub.com)',
      'access-token': accessToken,
    },
    body: JSON.stringify({ widgetParams }),
  });
  if (!res.ok) throw new Error(`transak session ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json().catch(() => ({}));
  const url = j?.data?.widgetUrl;
  if (!url) throw new Error('transak session: missing widgetUrl');
  return url;
}

// --- Immutable-hosted on-ramp (zkEVM) -----------------------------------------------------
// This is the exact call Immutable's toolkit on-ramp page makes: it mints a Transak widget
// session through Immutable's OWN (zkEVM-enabled) Transak account, so it works without our
// partner account being provisioned — and still pins network + token + amount. We use it for
// zkEVM (Creatures); LAND stays on our own Transak account (Ethereum isn't offered here).
const IMMUTABLE_CHECKOUT_CONFIG_URL = 'https://checkout-api.immutable.com/v1/config';
const IMMUTABLE_CHECKOUT_WIDGET_URL = 'https://api.immutable.com/checkout/v1/widget-url';
const ONRAMP_UA = 'HighriseCreatureClub/1.0 (+https://hcc.highrise.game)';

// Immutable's public Transak key lives in their checkout config (keyed by provider id). Fetched
// + cached (6h) rather than hardcoded, so a rotation on their side doesn't break us.
let imxOnrampKey = { value: null, fetchedAtMs: 0 };
async function immutableOnrampKey() {
  const now = Date.now();
  if (imxOnrampKey.value && now < imxOnrampKey.fetchedAtMs + 6 * 3600 * 1000) return imxOnrampKey.value;
  const res = await fetch(IMMUTABLE_CHECKOUT_CONFIG_URL, { headers: { Accept: 'application/json', 'User-Agent': ONRAMP_UA } });
  if (!res.ok) throw new Error(`immutable config ${res.status}`);
  const j = await res.json().catch(() => ({}));
  const key = Object.values(j?.onramp || {}).map(v => v?.publishableApiKey).find(Boolean);
  if (!key) throw new Error('immutable config: no onramp publishableApiKey');
  imxOnrampKey = { value: key, fetchedAtMs: now };
  return key;
}

// Mint a card on-ramp URL via Immutable's hosted checkout (rides Immutable's Transak account, so
// no creds of ours). It serves BOTH networks:
//   network 'immutablezkevm' → IMX (gas), delivered natively to zkEVM.
//   network 'ethereum'       → ETH (Creature/LAND price), delivered to Ethereum — Transak has no
//                              fiat→zkEVM-ETH product (confirmed by a live order: ETH lands on L1),
//                              so the buyer then bridges to zkEVM via the in-panel bridge.
// fiatUsd prefills the buy amount (integer USD). The returned global.transak.com?sessionId=… URL
// is short-lived + single-use, so we mint on click.
async function immutableOnrampUrl({ network, token, address, fiatUsd, referrerDomain }) {
  const apiKey = await immutableOnrampKey();
  const body = {
    api_key: apiKey,
    network,
    products_availed: 'buy',
    default_payment_method: 'credit_debit_card',
    default_crypto_currency: token,
    crypto_currency_code: token, // lock the token so funds can't land as the wrong asset
    hide_menu: true,
    wallet_address: address,
    referrer_domain: referrerDomain,
  };
  if (Number.isFinite(fiatUsd) && fiatUsd > 0) {
    body.default_fiat_amount = Math.round(fiatUsd);
    body.default_fiat_currency = 'USD';
  }
  const res = await fetch(IMMUTABLE_CHECKOUT_WIDGET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': ONRAMP_UA },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`immutable widget-url ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json().catch(() => ({}));
  if (!j.url) throw new Error('immutable widget-url: missing url');
  return j.url;
}

async function handleMarketplaceApi(request, response, url) {
  const { pathname } = url;

  // Bound upstream load from public browsing (per client IP). The pet-render endpoint
  // is image-like (a slime grid loads ~24 at once) and carries its OWN, looser limiter
  // below — so it's exempt from this tight per-call API budget, which is sized for the
  // JSON browse/detail calls, not an image wall.
  const ip = (request.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || request.socket.remoteAddress || 'unknown';
  const isPetRender = /^\/api\/market\/land\/pet\//.test(pathname);
  if (!isPetRender) {
    const wait = rateLimited(`mkt:${ip}`, 90, 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many requests.' }, { 'Retry-After': String(wait) }); return; }
  }

  if (pathname === '/api/market/creatures/listings') {
    const data = await getCreatureListings(url.searchParams.get('cursor') || '');
    sendJson(response, 200, data, { 'Cache-Control': 'public, max-age=30' });
    return;
  }

  // Filterable explorer: name search, trait/rarity facets, price range, sort.
  if (pathname === '/api/market/creatures/browse') {
    const data = await getCreatureBrowse(url.searchParams);
    sendJson(response, 200, data, { 'Cache-Control': 'public, max-age=15' });
    return;
  }

  // One token's active listing, from the browse snapshot — powers ?token= deep links
  // (e.g. Discord new-listing pings), where the paged grid feed may not contain the
  // token. Same wire shape as a /listings item; null when the token isn't listed.
  const listingForMatch = pathname.match(/^\/api\/market\/creatures\/listing\/(\d{1,80})$/);
  if (listingForMatch) {
    const listIdx = await getBrowseIndex();
    const found = listIdx.items.find(it => String(it.tokenId) === listingForMatch[1]);
    let listing = null;
    if (found) { const { traits, listedAt, ...pub } = found; listing = pub; }
    sendJson(response, 200, { listing }, { 'Cache-Control': 'public, max-age=15' });
    return;
  }

  const tokenMatch = pathname.match(/^\/api\/market\/creatures\/token\/(\d{1,80})$/);
  if (tokenMatch) {
    const data = await getCreatureToken(tokenMatch[1]);
    sendJson(response, 200, data, { 'Cache-Control': 'public, max-age=120' });
    return;
  }

  // The buyer's ETH on Ethereum MAINNET — powers the friendly "your ETH just needs to
  // switch networks" guidance (the #1 source of confusion). Public on-chain data for the
  // caller's own address; the client can't read mainnet itself (CSP blocks external RPCs).
  const elsewhereMatch = pathname.match(/^\/api\/market\/creatures\/eth-elsewhere\/(0x[0-9a-fA-F]{40})$/);
  if (elsewhereMatch) {
    const addr = elsewhereMatch[1];
    // Both reads feed the funds/gas helpers: ETH (the price token to bridge) and IMX held
    // on mainnet (the gas coin — bridging that straight over is cheaper than swapping ETH).
    // Independent so one failing still yields the other.
    const [ethRes, imxRes] = await Promise.allSettled([
      ethGetBalance(ETH_BALANCE_RPC, addr),
      ethCall(ETH_RPC_URL, IMX_L1_TOKEN, SEL_BALANCE_OF + padUint(BigInt(addr))),
    ]);
    if (ethRes.status === 'rejected') console.error('Mainnet ETH balance failed:', ethRes.reason?.message);
    if (imxRes.status === 'rejected') console.error('Mainnet IMX balance failed:', imxRes.reason?.message);
    const mainnetEthWei = ethRes.status === 'fulfilled' ? ethRes.value : null;
    let mainnetImxWei = null;
    if (imxRes.status === 'fulfilled' && imxRes.value) {
      try { mainnetImxWei = BigInt(imxRes.value).toString(); } catch { /* leave null */ }
    }
    sendJson(response, 200, { mainnetEthWei, mainnetImxWei }, { 'Cache-Control': 'no-store' });
    return;
  }

  // Prepare a buy: returns the unsigned transactions (approval + fulfilment) for the
  // buyer's wallet to sign. No auth — the wallet signature is the real authorization;
  // the taker address only scopes the prepared transactions to that buyer.
  if (pathname === '/api/market/creatures/buy/prepare' && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    // Order preparation hits the orderbook + RPC upstream — tighter cap than browsing.
    const bWait = rateLimited(`mktbuy:${ip}`, 15, 60 * 1000);
    if (bWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(bWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const listingId = String(body.listingId || '').toLowerCase();
    const taker = String(body.takerAddress || '').toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(listingId)) {
      sendJson(response, 400, { error: 'bad_listing' }); return;
    }
    if (!HEX_ADDRESS.test(taker)) { sendJson(response, 400, { error: 'bad_address' }); return; }

    try {
      const prepared = await mktOrderbook.prepareBuy(listingId, taker);
      sendJson(response, 200, prepared);
    } catch (err) {
      // On a LISTING buy the "fulfiller" is the buyer — seaport's fulfiller-balance
      // error here just means the buyer lacks ETH, which the client turns into the
      // funds-help panel (balances + bridge quote), not a generic failure.
      const code = err.code === 'taker_float' ? 'insufficient' : err.code;
      sendJson(response, err.statusCode || 503, { error: code || 'unavailable' });
    }
    return;
  }

  // The seller's own Creatures (sell picker) and active listings (My listings).
  // Public on-chain data; the address is the caller's own connected wallet.
  const ownedMatch = pathname.match(/^\/api\/market\/creatures\/(owned|mine)\/(0x[0-9a-f]{40})$/);
  if (ownedMatch) {
    const data = ownedMatch[1] === 'owned'
      ? await getOwnedCreatures(ownedMatch[2])
      : await getMyListings(ownedMatch[2]);
    sendJson(response, 200, data, { 'Cache-Control': 'no-store' }); // wallet-keyed — never shared-cache it
    return;
  }

  // The "History" tab: a wallet's past (sold / cancelled / expired) Creature listings.
  // Heavier than owned/mine (several upstream queries + a meta batch), so it carries its
  // own modest per-IP limit on top of the shared budget. Wallet-keyed — never shared-cache.
  const historyMatch = pathname.match(/^\/api\/market\/creatures\/history\/(0x[0-9a-f]{40})$/);
  if (historyMatch) {
    const hWait = rateLimited(`mkthist:${ip}`, 15, 60 * 1000);
    if (hWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(hWait) }); return; }
    const data = await getMyListingHistory(historyMatch[1]);
    sendJson(response, 200, data, { 'Cache-Control': 'no-store' });
    return;
  }

  const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  // Prepare a listing: NFT approval tx (first time only) + typed data to sign (gasless).
  if (pathname === '/api/market/creatures/sell/prepare' && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    const sWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (sWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(sWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const maker = String(body.makerAddress || '').toLowerCase();
    const tokenId = String(body.tokenId || '');
    const wei = parseEthToWei(body.priceEth);
    if (!HEX_ADDRESS.test(maker)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (!/^\d{1,80}$/.test(tokenId)) { sendJson(response, 400, { error: 'bad_token' }); return; }
    if (wei == null) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      const prepared = await mktOrderbook.prepareSell({
        makerAddress: maker, sellContract: CREATURE_CONTRACT, tokenId,
        buyContract: IMX_ETH_TOKEN, amountWei: wei.toString(),
      });
      sendJson(response, 200, prepared);
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Create the listing from the signed order (gasless; the orderbook verifies the
  // signature against the order's offerer, so a forged body can't list anyone's NFT).
  if (pathname === '/api/market/creatures/sell/create' && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    const cWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (cWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(cWait) }); return; }

    const body = await readJsonBody(request, 64 * 1024);
    const { orderComponents, orderHash, signature } = body || {};
    if (!orderComponents || typeof orderComponents !== 'object'
      || !/^0x[0-9a-f]{64}$/i.test(String(orderHash || ''))
      || !/^0x[0-9a-f]{60,2600}$/i.test(String(signature || ''))) {
      sendJson(response, 400, { error: 'bad_order' }); return;
    }
    // Scope allowlist: this endpoint only relays orders selling THIS collection for
    // THIS payment token (mirrors what sell/prepare pins). The orderbook would verify
    // the signature anyway, but without this the endpoint is a generic Seaport relay.
    const offer = Array.isArray(orderComponents.offer) ? orderComponents.offer : [];
    const consideration = Array.isArray(orderComponents.consideration) ? orderComponents.consideration : [];
    const scopeOk = offer.length === 1
      && String(offer[0]?.token || '').toLowerCase() === CREATURE_CONTRACT.toLowerCase()
      && consideration.length >= 1
      && consideration.every(c => String(c?.token || '').toLowerCase() === IMX_ETH_TOKEN);
    if (!scopeOk) { sendJson(response, 400, { error: 'bad_order' }); return; }
    try {
      const created = await mktOrderbook.createSell({ orderComponents, orderHash, signature });
      listingsCache.clear(); // the new listing should appear in browse promptly
      sendJson(response, 200, created);
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Gasless cancel: typed data to sign, then submit with the signature. Only the
  // order's creator can produce a valid signature — the orderbook enforces that.
  if ((pathname === '/api/market/creatures/cancel/prepare' || pathname === '/api/market/creatures/cancel')
      && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    const kWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (kWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(kWait) }); return; }

    const body = await readJsonBody(request, 16 * 1024);
    const addr = String(body.accountAddress || '').toLowerCase();
    const orderIds = Array.isArray(body.orderIds) ? body.orderIds.map(s => String(s).toLowerCase()) : [];
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (!orderIds.length || orderIds.length > 20 || !orderIds.every(id => ORDER_ID.test(id))) {
      sendJson(response, 400, { error: 'bad_order' }); return;
    }
    try {
      if (pathname.endsWith('/prepare')) {
        sendJson(response, 200, await mktOrderbook.prepareCancel(orderIds, addr));
      } else {
        const signature = String(body.signature || '');
        if (!/^0x[0-9a-f]{60,2600}$/i.test(signature)) { sendJson(response, 400, { error: 'bad_signature' }); return; }
        const result = await mktOrderbook.submitCancel(orderIds, addr, signature);
        listingsCache.clear(); // cancelled listings should drop out of browse promptly
        sendJson(response, 200, result);
      }
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // --- Offers (bids): standing offers on a specific Creature, or collection-wide
  // ("floor") offers any holder can sell into. Same trust model as listings: the
  // bidder's signature is the authorization; the orderbook + Seaport verify it.

  // Read endpoints (public orderbook data).
  if (pathname === '/api/market/creatures/offers/collection') {
    const data = await mktOrderbook.listCollectionOffers({ nftContract: CREATURE_CONTRACT, ethContract: IMX_ETH_TOKEN });
    sendJson(response, 200, { offers: await fundedOffersOnly(data.offers) }, { 'Cache-Control': 'public, max-age=15' });
    return;
  }
  const offersTokenMatch = pathname.match(/^\/api\/market\/creatures\/offers\/token\/(\d{1,80})$/);
  if (offersTokenMatch) {
    const data = await mktOrderbook.listTokenOffers({ nftContract: CREATURE_CONTRACT, ethContract: IMX_ETH_TOKEN, tokenId: offersTokenMatch[1] });
    sendJson(response, 200, { offers: await fundedOffersOnly(data.offers) }, { 'Cache-Control': 'public, max-age=15' });
    return;
  }
  const offersMineMatch = pathname.match(/^\/api\/market\/creatures\/offers\/mine\/(0x[0-9a-f]{40})$/);
  if (offersMineMatch) {
    const data = await mktOrderbook.listMyOffers({ nftContract: CREATURE_CONTRACT, ethContract: IMX_ETH_TOKEN, accountAddress: offersMineMatch[1] });
    // The user's OWN offers are annotated, not hidden — an unfunded one needs their
    // attention (top up or cancel), not silence.
    const annotated = await annotateOffersFunded(data.offers);
    sendJson(response, 200, { offers: annotated.map(({ grossWei, ...rest }) => rest) }, { 'Cache-Control': 'no-store' });
    return;
  }

  // Prepare an offer: ERC20 approval tx (first time only) + typed data to sign (gasless).
  if (pathname === '/api/market/creatures/offer/prepare' && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    const oWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (oWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(oWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const maker = String(body.makerAddress || '').toLowerCase();
    const wei = parseEthToWei(body.priceEth);
    const tokenId = body.tokenId != null ? String(body.tokenId) : null;
    if (!HEX_ADDRESS.test(maker)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (wei == null) { sendJson(response, 400, { error: 'bad_price' }); return; }
    if (tokenId != null && !/^\d{1,80}$/.test(tokenId)) { sendJson(response, 400, { error: 'bad_token' }); return; }

    try {
      const prepared = await mktOrderbook.prepareOffer({
        makerAddress: maker, ethContract: IMX_ETH_TOKEN, amountWei: wei.toString(),
        nftContract: CREATURE_CONTRACT, tokenId,
      });
      sendJson(response, 200, prepared);
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Create the offer from the signed order. Scope allowlist mirrors sell/create, with
  // sides flipped: a bid OFFERS the ETH token and takes the Creature in consideration
  // (fee items ride along in ETH).
  if (pathname === '/api/market/creatures/offer/create' && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    const cWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (cWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(cWait) }); return; }

    const body = await readJsonBody(request, 64 * 1024);
    const { orderComponents, orderHash, signature } = body || {};
    if (!orderComponents || typeof orderComponents !== 'object'
      || !/^0x[0-9a-f]{64}$/i.test(String(orderHash || ''))
      || !/^0x[0-9a-f]{60,2600}$/i.test(String(signature || ''))) {
      sendJson(response, 400, { error: 'bad_order' }); return;
    }
    const offer = Array.isArray(orderComponents.offer) ? orderComponents.offer : [];
    const consideration = Array.isArray(orderComponents.consideration) ? orderComponents.consideration : [];
    const creature = CREATURE_CONTRACT.toLowerCase();
    const scopeOk = offer.length === 1
      && String(offer[0]?.token || '').toLowerCase() === IMX_ETH_TOKEN
      && consideration.length >= 1
      && consideration.every(c => {
        const tk = String(c?.token || '').toLowerCase();
        return tk === creature || tk === IMX_ETH_TOKEN;
      })
      && consideration.some(c => String(c?.token || '').toLowerCase() === creature);
    if (!scopeOk) { sendJson(response, 400, { error: 'bad_order' }); return; }

    try {
      const created = await mktOrderbook.createOffer({ orderComponents, orderHash, signature, collection: !!body.collection });
      sendJson(response, 200, created);
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Recipient safety assessment for transfers (checksum, protocol-contract block,
  // on-chain activity) — read-only, never blocks on RPC blips.
  if (pathname === '/api/market/creatures/transfer/check' && request.method === 'POST') {
    const tWait = rateLimited(`mkt:${ip}`, 90, 60 * 1000);
    if (tWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(tWait) }); return; }
    const body = await readJsonBody(request, 4 * 1024);
    const chain = body.chain === 'ethereum' ? 'ethereum' : 'zkevm';
    sendJson(response, 200, await checkTransferRecipient(body.to, chain), { 'Cache-Control': 'no-store' });
    return;
  }

  // Exact-output bridge quote via Squid: "send X ETH on Ethereum, receive ≥ what you're
  // short on Immutable zkEVM", plus the ready-to-sign mainnet transaction. Quotes hit
  // Squid's API (integrator id from env), so the cap is tight; 'not_configured' tells
  // the client to fall back to the deep-link.
  if (pathname === '/api/market/creatures/bridge/quote' && request.method === 'POST') {
    if (!squidBridge.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const qWait = rateLimited(`mktbridge:${ip}`, 6, 60 * 1000);
    if (qWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(qWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const addr = String(body.address || '').toLowerCase();
    const wei = parseEthToWei(body.needEth);
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (wei == null) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      sendJson(response, 200, await squidBridge.quoteBridge(wei, addr));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Exact-output GAS top-up quote: "send X ETH on Ethereum, receive ≥ Y native IMX on
  // Immutable zkEVM". IMX (not the ETH ERC-20) is what pays gas, so a seller/transferrer
  // with no IMX can't sign their one on-chain action — this bridges a little over. The
  // in-panel tracker reuses /bridge/status (it keys on the tx hash, asset-agnostic).
  if (pathname === '/api/market/creatures/bridge/gas/quote' && request.method === 'POST') {
    if (!squidBridge.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const gWait = rateLimited(`mktbridge:${ip}`, 6, 60 * 1000);
    if (gWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(gWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const addr = String(body.address || '').toLowerCase();
    const wei = parseEthToWei(body.needImx);
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    // A gas top-up is a few IMX; cap it so a tampered request can't quote a huge bridge.
    if (wei == null || wei > 50n * 10n ** 18n) { sendJson(response, 400, { error: 'bad_price' }); return; }
    // Source asset: 'imx' bridges the user's existing mainnet IMX straight over (cheapest —
    // no swap); 'eth' (default) swaps a little mainnet ETH into IMX.
    const fromToken = body.from === 'imx' ? squidBridge.IMX_L1 : undefined;

    try {
      sendJson(response, 200, await squidBridge.quoteBridge(wei, addr, { toToken: squidBridge.ZK_IMX, fromToken }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // In-site cash-out quote: the EXACT-INPUT reverse bridge — "send X of your zkEVM ETH,
  // receive ~Y native ETH on Ethereum mainnet" — plus the ready-to-sign zkEVM transaction
  // and the ERC-20 approval target. Powers the Token-Trove-style Move flow in the cash-out
  // modal, so sellers never have to leave the site to reach an exchange-friendly network.
  // Amount is the seller's own proceeds; capped so a tampered request can't quote a huge
  // bridge against our shared integrator id.
  if (pathname === '/api/market/creatures/cashout/quote' && request.method === 'POST') {
    if (!squidBridge.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const cWait = rateLimited(`mktbridge:${ip}`, 6, 60 * 1000);
    if (cWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(cWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const addr = String(body.address || '').toLowerCase();
    const wei = parseEthToWei(body.amountEth);
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (wei == null || wei > 100n * 10n ** 18n) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      sendJson(response, 200, await squidBridge.quoteCashout(wei, addr));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Standalone "Add funds" quote: the EXACT-INPUT funding move — "send X of your mainnet
  // ETH, receive ~Y ETH on Immutable zkEVM". The checkout-shortfall bridge (bridge/quote,
  // exact-output) stays for buys; this one powers the wallet-bar modal where the user
  // picks the amount themselves. Same cap + rate bucket as the cash-out quote.
  if (pathname === '/api/market/creatures/topup/quote' && request.method === 'POST') {
    if (!squidBridge.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const tqWait = rateLimited(`mktbridge:${ip}`, 6, 60 * 1000);
    if (tqWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(tqWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const addr = String(body.address || '').toLowerCase();
    const wei = parseEthToWei(body.amountEth);
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (wei == null || wei > 100n * 10n ** 18n) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      sendJson(response, 200, await squidBridge.quoteTopup(wei, addr));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Fiat on-ramp: mint a fresh, single-use card-on-ramp session via Immutable's hosted checkout
  // (rides Immutable's Transak account — no creds of ours, no dependency on our account being
  // provisioned). Transak has no fiat→zkEVM-ETH product (a live test order delivered ETH to L1),
  // so routing is by what each network can actually deliver:
  //   chain=zkevm    → network 'immutablezkevm', IMX (gas) — native to zkEVM.
  //   chain=ethereum → network 'ethereum', ETH (Creature/LAND price) — lands on Ethereum, then
  //                    the buyer bridges to zkEVM via the in-panel bridge.
  // `fiat` prefills the buy amount in USD (editable). The minted URL is single-use + expires in
  // ~5 min, so the client mints on click. On failure the client falls back (zkEVM → Immutable's
  // keyless hosted page; ethereum → hides the CTA).
  if (pathname === '/api/market/onramp' && request.method === 'GET') {
    const oWait = rateLimited(`mktonramp:${ip}`, 20, 60 * 1000);
    if (oWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(oWait) }); return; }

    const chain = String(url.searchParams.get('chain') || '');
    const addr = String(url.searchParams.get('address') || '').toLowerCase();
    const reqToken = String(url.searchParams.get('token') || 'ETH').toUpperCase();
    const fiatUsd = Number(url.searchParams.get('fiat'));
    // zkEVM only delivers IMX here (gas); Ethereum delivers ETH (price). Pin accordingly.
    const network = chain === 'zkevm' ? 'immutablezkevm' : chain === 'ethereum' ? 'ethereum' : null;
    const token = chain === 'zkevm' ? 'IMX' : 'ETH';
    if (!network) { sendJson(response, 400, { error: 'bad_chain' }); return; }
    if (!HEX_ADDRESS.test(addr)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (reqToken !== token) { sendJson(response, 400, { error: 'bad_token' }); return; }

    // referrerDomain: the request host (strip port) unless explicitly overridden.
    const referrerDomain = TRANSAK_REFERRER_DOMAIN
      || String(request.headers.host || '').split(':')[0]
      || 'localhost';
    try {
      const widgetUrl = await immutableOnrampUrl({ network, token, address: addr, fiatUsd, referrerDomain });
      sendJson(response, 200, { url: widgetUrl }, { 'Cache-Control': 'no-store' });
    } catch (err) {
      console.error('On-ramp mint failed:', err.message);
      sendJson(response, 502, { error: 'onramp_unavailable' });
    }
    return;
  }

  // Live bridge progress for the in-panel tracker. Squid's status API is the primary
  // signal; before Squid indexes the tx (~1 min) we fall back to the source-chain
  // receipt so the tracker can still show "confirmed on Ethereum". `dir=out` flips the
  // chain pair for cash-out (zkEVM → mainnet) transactions — same stages, zkEVM receipt.
  if (pathname === '/api/market/creatures/bridge/status') {
    const sWait = rateLimited(`mktbst:${ip}`, 30, 60 * 1000);
    if (sWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(sWait) }); return; }

    const tx = String(url.searchParams.get('tx') || '').toLowerCase();
    const quoteId = String(url.searchParams.get('quoteId') || '').slice(0, 100);
    const requestId = String(url.searchParams.get('requestId') || '').slice(0, 100);
    const reverse = url.searchParams.get('dir') === 'out';
    if (!/^0x[0-9a-f]{64}$/.test(tx)) { sendJson(response, 400, { error: 'bad_tx' }); return; }
    if ((quoteId && !/^[\w-]+$/.test(quoteId)) || (requestId && !/^[\w-]+$/.test(requestId))) {
      sendJson(response, 400, { error: 'bad_request' }); return;
    }

    let squid = null;
    if (squidBridge.configured()) {
      try { squid = await squidBridge.getStatus({ txHash: tx, quoteId, requestId, reverse }); }
      catch (err) { console.error('Squid status failed:', err.message); }
    }
    const MAP = { success: 'arrived', ongoing: 'bridging', needs_gas: 'needs_gas', partial_success: 'failed', refund: 'failed' };
    let stage = MAP[squid?.squidStatus] || null;
    let destUrl = squid?.destUrl || null;
    // Squid's status indexer can lag a FINISHED bridge by 30+ minutes (a live cash-out
    // sat on "Crossing" while Axelar showed it executed after 72s) — so whenever Squid
    // hasn't given a terminal answer, ask Axelar's GMP API directly. Both bridge
    // directions ride Axelar, so this covers funding too.
    if (stage !== 'arrived' && stage !== 'failed' && stage !== 'needs_gas') {
      try {
        const ax = await squidBridge.getAxelarStatus(tx, { reverse });
        if (ax?.stage) { stage = ax.stage; destUrl = destUrl || ax.destUrl; }
      } catch (err) {
        console.error('Axelar status failed:', err.message);
      }
    }
    if (!stage) { // not indexed anywhere yet — check the source-chain receipt
      try {
        const rec = await ethGetTxReceipt(reverse ? ZK_RPC_URL : ETH_RPC_URL, tx);
        stage = rec ? (rec.status === '0x1' ? 'src_confirmed' : 'failed_src') : 'submitted';
      } catch (err) {
        console.error('Bridge receipt check failed:', err.message);
        stage = 'submitted'; // tracker stays at step 1 rather than erroring
      }
    }
    sendJson(response, 200, {
      stage,
      axelarUrl: squid?.axelarUrl || `https://axelarscan.io/gmp/${tx}`,
      srcUrl: squid?.srcUrl || null,
      destUrl,
    });
    return;
  }

  // Accept an offer (the holder sells into it): unsigned NFT-approval + fill txs.
  // For collection offers, tokenId picks which Creature is sold into the bid.
  if (pathname === '/api/market/creatures/offer/accept/prepare' && request.method === 'POST') {
    if (!mktOrderbook.available()) { sendJson(response, 503, { error: 'unavailable' }); return; }
    const aWait = rateLimited(`mktbuy:${ip}`, 15, 60 * 1000);
    if (aWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(aWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const offerId = String(body.offerId || '').toLowerCase();
    const taker = String(body.takerAddress || '').toLowerCase();
    const tokenId = body.tokenId != null ? String(body.tokenId) : null;
    // Multi-unit collection bids (buy.amount > 1) are filled one Creature at a time.
    const amountToFill = body.amountToFill != null ? String(body.amountToFill) : null;
    if (!ORDER_ID.test(offerId)) { sendJson(response, 400, { error: 'bad_listing' }); return; }
    if (!HEX_ADDRESS.test(taker)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (tokenId != null && !/^\d{1,80}$/.test(tokenId)) { sendJson(response, 400, { error: 'bad_token' }); return; }
    if (amountToFill != null && !/^[1-9]\d{0,2}$/.test(amountToFill)) { sendJson(response, 400, { error: 'bad_request' }); return; }

    try {
      const prepared = await mktOrderbook.prepareFulfill(offerId, taker, tokenId, amountToFill);
      sendJson(response, 200, prepared);
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // --- LAND (Ethereum mainnet, via OpenSea) ---
  // Same shape as the Creature endpoints; different chain + protocol underneath.
  if (pathname === '/api/market/land/listings') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const [data, fx] = await Promise.all([
      landMarket.listListings(url.searchParams.get('cursor') || ''),
      getMarketplaceFx(),
    ]);
    sendJson(response, 200, { ...data, ethUsd: fx.ethUsd, fxRates: fx.fxRates }, { 'Cache-Control': 'public, max-age=30' });
    return;
  }
  // Active collection-wide offers ("standing offers") on LAND, best first. Read-only:
  // surfaces existing OpenSea demand so holders can see the floor bid. WETH-denominated.
  if (pathname === '/api/market/land/offers/collection') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const data = await landMarket.listCollectionOffers();
    sendJson(response, 200, data, { 'Cache-Control': 'public, max-age=30' });
    return;
  }
  // Unified LAND browse: every parcel via its Slime — trait facets, rarity rank,
  // price when listed. (LAND and its Slime are one NFT — one browse, not two.)
  if (pathname === '/api/market/land/browse') {
    const data = await getLandBrowse(url.searchParams);
    sendJson(response, 200, data, { 'Cache-Control': 'public, max-age=15' });
    return;
  }
  const landTokenMatch = pathname.match(/^\/api\/market\/land\/token\/(\d{1,80})$/);
  if (landTokenMatch) {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const data = await landMarket.getToken(landTokenMatch[1]);
    sendJson(response, 200, data, { 'Cache-Control': 'public, max-age=300' });
    return;
  }
  const landOwnedMatch = pathname.match(/^\/api\/market\/land\/owned\/(0x[0-9a-f]{40})$/);
  if (landOwnedMatch) {
    // Token ids come straight from the LAND contract (see landOwnedOnChain) — zero indexer
    // lag, no 200-parcel page cap. OpenSea remains only as the fallback for an RPC hiccup.
    let data;
    try {
      data = { items: await landOwnedOnChain(landOwnedMatch[1]), truncated: false };
    } catch (err) {
      console.error('Chain read of owned LAND failed, falling back to OpenSea:', err.message);
      if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
      data = await landMarket.ownedLand(landOwnedMatch[1]);
    }
    // Attach coords + slime traits + rank from the background sweep so the Sell/Transfer
    // pickers show the parcel's slime pet and filter like Browse. Sync peek (no build) —
    // sparse until the parcel is swept.
    const sidx = slimeIndex.getSlimeIndex();
    if (sidx) for (const it of (data.items || [])) {
      const s = sidx.byToken.get(String(it.tokenId));
      it.traits = s?.traits || {};
      it.rank = s?.rank ?? null;
      if (!it.coords && s?.coords) it.coords = s.coords;
      // Chain items carry a placeholder "#id" name — swap in the familiar "(x, y)" one.
      if (s?.coords && /#\d+$/.test(it.name || '')) it.name = `Highrise LAND (${s.coords.x}, ${s.coords.y})`;
    }
    sendJson(response, 200, data, { 'Cache-Control': 'no-store' });
    return;
  }
  // The parcel's attached Slime pet, rendered server-side from Highrise's public
  // pet-part assets into one self-contained SVG (see lib/land-pets.js). 404 when the
  // parcel has no pet — the client falls back to the plot image. Coords are the only
  // input and are pinned to integers, so this can't be used as an open proxy.
  const landPetMatch = pathname.match(/^\/api\/market\/land\/pet\/(-?\d{1,4})\/(-?\d{1,4})$/);
  if (landPetMatch) {
    const petWait = rateLimited(`landpet:${ip}`, 900, 60 * 1000); // image-grid budget; renders are cached + ETagged
    if (petWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(petWait) }); return; }
    try {
      const pet = await landPets.renderPet(Number(landPetMatch[1]), Number(landPetMatch[2]));
      if (pet.status !== 'ok') { sendJson(response, 404, { error: 'no_pet' }); return; }
      // CSP + sandbox neutralize any active content if the SVG is opened as a page
      // (as an <img> it's inert anyway); pets change rarely, so short-cache + ETag.
      const headers = {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=600, must-revalidate',
        'ETag': pet.etag,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      };
      if (request.headers['if-none-match'] === pet.etag) {
        response.writeHead(304, headers);
        response.end();
      } else {
        response.writeHead(200, headers);
        response.end(pet.svg);
      }
    } catch (err) {
      console.error(`LAND pet ${landPetMatch[1]}:${landPetMatch[2]} render failed:`, err.message);
      sendJson(response, 503, { error: 'unavailable' });
    }
    return;
  }
  if (pathname === '/api/market/land/buy/prepare' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const bWait = rateLimited(`mktbuy:${ip}`, 15, 60 * 1000);
    if (bWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(bWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const orderHash = String(body.orderHash || '').toLowerCase();
    const protocolAddress = String(body.protocolAddress || '').toLowerCase();
    const taker = String(body.takerAddress || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(orderHash)) { sendJson(response, 400, { error: 'bad_listing' }); return; }
    if (!HEX_ADDRESS.test(protocolAddress)) { sendJson(response, 400, { error: 'bad_listing' }); return; }
    if (!HEX_ADDRESS.test(taker)) { sendJson(response, 400, { error: 'bad_address' }); return; }

    try {
      sendJson(response, 200, await landMarket.prepareBuy({ orderHash, protocolAddress, taker }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Prepare accepting a LAND collection offer (sell a parcel INTO a standing bid): the
  // one-time conduit approval (if needed) + the Seaport fulfilment, both bound to the seller.
  if (pathname === '/api/market/land/offer/accept/prepare' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const aWait = rateLimited(`mktbuy:${ip}`, 15, 60 * 1000);
    if (aWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(aWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const orderHash = String(body.orderHash || '').toLowerCase();
    const protocolAddress = String(body.protocolAddress || '').toLowerCase();
    const tokenId = String(body.tokenId || '');
    const taker = String(body.takerAddress || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(orderHash)) { sendJson(response, 400, { error: 'bad_listing' }); return; }
    if (!HEX_ADDRESS.test(protocolAddress)) { sendJson(response, 400, { error: 'bad_listing' }); return; }
    if (!/^\d{1,80}$/.test(tokenId)) { sendJson(response, 400, { error: 'bad_token' }); return; }
    if (!HEX_ADDRESS.test(taker)) { sendJson(response, 400, { error: 'bad_address' }); return; }

    try {
      sendJson(response, 200, await landMarket.prepareAcceptOffer({ orderHash, protocolAddress, tokenId, taker }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Prepare a LAND listing: one-time conduit approval (if needed) + the Seaport order
  // typed-data the seller signs. Same trust model as the Creature sell flow; the order
  // is built server-side so the client can't smuggle a different collection or recipient.
  if (pathname === '/api/market/land/sell/prepare' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    if (!landMarket.sellEnabled()) { sendJson(response, 503, { error: 'disabled' }); return; }
    const sWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (sWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(sWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const maker = String(body.makerAddress || '').toLowerCase();
    const tokenId = String(body.tokenId || '');
    const wei = parseEthToWei(body.priceEth);
    if (!HEX_ADDRESS.test(maker)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (!/^\d{1,80}$/.test(tokenId)) { sendJson(response, 400, { error: 'bad_token' }); return; }
    if (wei == null || wei <= 0n) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      sendJson(response, 200, await landMarket.prepareListing({
        tokenId, priceWei: wei.toString(), maker, durationDays: body.durationDays,
      }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Create the LAND listing from the signed order (relayed to OpenSea). The scope guard
  // in createListing keeps our API key from posting anything but LAND listings.
  if (pathname === '/api/market/land/sell/create' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    if (!landMarket.sellEnabled()) { sendJson(response, 503, { error: 'disabled' }); return; }
    const cWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (cWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(cWait) }); return; }

    const body = await readJsonBody(request, 32 * 1024);
    const { orderParameters, signature } = body || {};
    if (!orderParameters || typeof orderParameters !== 'object'
      || !/^0x[0-9a-f]{60,2600}$/i.test(String(signature || ''))) {
      sendJson(response, 400, { error: 'bad_order' }); return;
    }
    try {
      const created = await landMarket.createListing({ orderParameters, signature });
      // The new listing should appear on the "On sale" browse promptly. Drop the cached
      // listings snapshot now, and force-refresh it ~10s out — by then OpenSea has indexed
      // the order, so the refresh captures it (a plain re-fetch right now could re-cache a
      // still-missing snapshot for a full TTL). See landListingsByToken(force).
      slimeListingsCache.data = null;
      setTimeout(() => { landListingsByToken(true).catch(() => {}); }, 10000);
      sendJson(response, 200, created);
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Prepare a LAND collection offer: WETH wrap/approval (if needed) + the Seaport order
  // (orderType 3 + OpenSea zone) the maker signs. The order is built server-side so the
  // client can't smuggle a different collection, recipient or fee.
  if (pathname === '/api/market/land/offer/prepare' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    if (!landMarket.offerEnabled()) { sendJson(response, 503, { error: 'disabled' }); return; }
    const oWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (oWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(oWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const maker = String(body.makerAddress || '').toLowerCase();
    const wei = parseEthToWei(body.priceEth);
    if (!HEX_ADDRESS.test(maker)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    if (wei == null || wei <= 0n) { sendJson(response, 400, { error: 'bad_price' }); return; }

    try {
      sendJson(response, 200, await landMarket.prepareOffer({ makerAddress: maker, priceWei: wei.toString(), durationDays: body.durationDays }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Create the LAND offer from the signed order (relayed to OpenSea). createOffer's scope
  // guard keeps our API key from posting anything but a LAND collection offer.
  if (pathname === '/api/market/land/offer/create' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    if (!landMarket.offerEnabled()) { sendJson(response, 503, { error: 'disabled' }); return; }
    const cWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (cWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(cWait) }); return; }

    const body = await readJsonBody(request, 32 * 1024);
    const { orderParameters, signature, criteria } = body || {};
    if (!orderParameters || typeof orderParameters !== 'object'
      || !/^0x[0-9a-f]{60,2600}$/i.test(String(signature || ''))) {
      sendJson(response, 400, { error: 'bad_order' }); return;
    }
    try {
      sendJson(response, 200, await landMarket.createOffer({ orderParameters, signature, criteria }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // The caller's own active LAND listings (for "my listings" + cancel). Public on-chain
  // data keyed to the connected wallet — no-store so it's never shared-cached.
  const landMineMatch = pathname.match(/^\/api\/market\/land\/mine\/(0x[0-9a-f]{40})$/);
  if (landMineMatch) {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    try {
      const data = await landMarket.myListings(landMineMatch[1]);
      // Attach coords + slime traits (same sweep join as /owned) so "My listings" shows the
      // parcel's slime pet, matching the grid + pickers rather than the flat plot tile.
      const sidx = slimeIndex.getSlimeIndex();
      if (sidx) for (const it of (data.items || [])) {
        const s = sidx.byToken.get(String(it.tokenId));
        if (s) { it.coords = s.coords; it.traits = s.traits; it.rank = s.rank ?? null; }
      }
      sendJson(response, 200, data, { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // The "History" tab for LAND: the wallet's past buys, sales and transfers, from OpenSea's
  // account events feed. Heavier than mine/owned (a bounded multi-page scan), so it carries
  // its own modest per-IP limit. Wallet-keyed — never shared-cache.
  const landHistoryMatch = pathname.match(/^\/api\/market\/land\/history\/(0x[0-9a-f]{40})$/);
  if (landHistoryMatch) {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const hWait = rateLimited(`mkthist:${ip}`, 15, 60 * 1000);
    if (hWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(hWait) }); return; }
    try {
      sendJson(response, 200, await landMarket.myHistory(landHistoryMatch[1]), { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // The caller's own active LAND offers (for "your offers" + cancel). Public on-chain data
  // keyed to the connected wallet — no-store so it's never shared-cached.
  const landOffersMineMatch = pathname.match(/^\/api\/market\/land\/offers\/mine\/(0x[0-9a-f]{40})$/);
  if (landOffersMineMatch) {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    try {
      sendJson(response, 200, await landMarket.myOffers(landOffersMineMatch[1]), { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  // Prepare an on-chain Seaport cancel for one of the caller's own LAND listings. Only
  // the order's offerer can produce a valid cancel — Seaport enforces it, and we re-check.
  if (pathname === '/api/market/land/cancel/prepare' && request.method === 'POST') {
    if (!landMarket.configured()) { sendJson(response, 503, { error: 'not_configured' }); return; }
    const kWait = rateLimited(`mktsell:${ip}`, 15, 60 * 1000);
    if (kWait) { sendJson(response, 429, { error: 'rate_limited' }, { 'Retry-After': String(kWait) }); return; }

    const body = await readJsonBody(request, 4 * 1024);
    const orderHash = String(body.orderHash || '').toLowerCase();
    const maker = String(body.accountAddress || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(orderHash)) { sendJson(response, 400, { error: 'bad_listing' }); return; }
    if (!HEX_ADDRESS.test(maker)) { sendJson(response, 400, { error: 'bad_address' }); return; }
    try {
      sendJson(response, 200, await landMarket.prepareCancel({ orderHash, maker }));
    } catch (err) {
      sendJson(response, err.statusCode || 503, { error: err.code || 'unavailable' });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

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

// Where the OAuth round-trip lands back on the site. Sign-in buttons live on more
// than one page now (Council › Apply & Vote, Polls & Votes), so the login endpoint
// remembers which one started the flow in a short-lived cookie — allowlisted paths
// only, so a crafted link can never turn the callback into an open redirect.
const RETURN_COOKIE = 'hcc_return';
const RETURN_PATHS = new Set(['/council/vote', '/polls']);
// Validate an untrusted return target against the allowlist; anything else falls back
// to the Council vote page. Shared by login (reads it from the round-trip cookie) and
// logout (reads it straight from the ?return= query param).
function safeReturnPath(raw) {
  return RETURN_PATHS.has(raw) ? raw : '/council/vote';
}
function returnPathFrom(cookies) {
  return safeReturnPath(cookies?.[RETURN_COOKIE]);
}

// Send the user back to the panel that started the sign-in; `error` (if set) is
// read by the front-end (apply.js / polls.js render it as a friendly alert).
function redirectToApp(request, response, error) {
  const cookies = auth.parseCookies(request);
  const base = returnPathFrom(cookies);
  const location = error ? `${base}?auth=${encodeURIComponent(error)}` : base;
  response.writeHead(302, {
    Location: location,
    'Set-Cookie': auth.serializeCookie(RETURN_COOKIE, '', { maxAge: 0, secure: auth.isSecure(request) }),
    'Cache-Control': 'no-store',
  });
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

  // Step 1 — begin OAuth: redirect to Discord with a CSRF state cookie. An optional
  // ?return= names the page that started the flow (allowlisted — see RETURN_PATHS)
  // so the callback can land the user back where they were.
  if (pathname === '/api/auth/discord/login') {
    if (!auth.isConfigured()) { sendJson(response, 503, { error: 'Discord login is not configured.' }); return; }
    const { location, stateCookie } = auth.buildLoginRedirect(request);
    const wanted = url.searchParams.get('return') || '';
    const secure = auth.isSecure(request);
    const returnCookie = RETURN_PATHS.has(wanted)
      ? auth.serializeCookie(RETURN_COOKIE, wanted, { maxAge: 600, secure })
      : auth.serializeCookie(RETURN_COOKIE, '', { maxAge: 0, secure });
    response.writeHead(302, { Location: location, 'Set-Cookie': [stateCookie, returnCookie], 'Cache-Control': 'no-store' });
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
      // Self-heal a candidate's stored avatar on every login (best-effort, no await).
      db.updateApplicationAvatar(profile.id, safeIconUrl(sessionProfile.highriseIcon));

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
        Location: returnPathFrom(cookies),
        'Set-Cookie': [
          auth.serializeCookie(auth.SESSION_COOKIE, sid, { maxAge: SESSION_MAX_AGE, secure }),
          auth.serializeCookie(auth.STATE_COOKIE, '', { maxAge: 0, secure }),
          auth.serializeCookie(RETURN_COOKIE, '', { maxAge: 0, secure }),
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
      // Election phase (non-sensitive — same flags the public board exposes) so the
      // eligibility card can hide "Run for a seat" once candidacy closes and steer
      // eligible holders to the ballot once voting opens.
      phase: { applicationsOpen: APPLICATIONS_OPEN, votingOpen: VOTING_OPEN, resultsOpen: RESULTS_OPEN },
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

  // Logout. Returns the user to the page they logged out from (?return=, allowlisted)
  // so signing out on Polls doesn't bounce them over to Council; defaults to the
  // Council vote page. All these pages render fine signed-out (they show the sign-in
  // gate), so returning in place is the least surprising behaviour.
  if (pathname === '/api/auth/logout') {
    const cookies = auth.parseCookies(request);
    const sid = cookies[auth.SESSION_COOKIE];
    const endingSession = await db.getSession(sid);
    await db.deleteSession(sid);
    db.recordEvent({ event: 'auth.logout', discordId: endingSession?.discord_id || null });
    response.writeHead(302, {
      Location: safeReturnPath(url.searchParams.get('return')),
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

// Voting-phase flag — distinct from APPLICATIONS_OPEN. While voting hasn't started, the
// matcher is an ANONYMISED preview: candidate names are NEVER sent to the client (only
// bracket, pitch and match %), so the application phase shows how voting will look and a
// preview of the field without revealing who's who. Names are revealed once VOTING_OPEN=1.
const VOTING_OPEN = envFlag(process.env.VOTING_OPEN);

// Results phase — set RESULTS_OPEN=1 once voting has closed to publish per-race
// tallies and outcomes on /api/election. Aggregates only — individual ballots are
// never exposed, and there is no live tally while VOTING_OPEN (publishing a running
// count would invite pile-ons in a confirmation race).
const RESULTS_OPEN = envFlag(process.env.RESULTS_OPEN);

// --- Unopposed races: the confirmation-vote rule ---
// A race with no more candidates than seats is NOT auto-won. Its ballot becomes a
// choice between "Seat the candidate(s)" and "Reopen nominations":
//   • Seat wins a majority of votes cast on that race → seated with a real mandate.
//   • Reopen wins a STRICT majority → that bracket's candidacy window reopens once
//     (set REOPENED_BRACKETS + REOPEN_DEADLINE). A new candidate entering makes the
//     re-run a normal contested race (bump VOTE_ROUND=2 for the re-vote). If nobody
//     new enters by the deadline, the original candidates are seated by rule.
// Rejection therefore has to be CONSTRUCTIVE — the only way to unseat an unopposed
// candidate is to field someone who beats them. A hostile voting bloc can force a
// real contest but can never vote a bracket's representation into a vacancy, which
// closes the gatekeeping/sabotage exploit. Ties favour seating for the same reason.
const VOTE_ROUND = Math.max(1, parseInt(process.env.VOTE_ROUND, 10) || 1);
const REOPENED_BRACKETS = String(process.env.REOPENED_BRACKETS || '')
  .split(',').map(s => s.trim()).filter(id => BRACKETS.some(b => b.id === id));
const REOPEN_DEADLINE_MS = Date.parse(process.env.REOPEN_DEADLINE || '') || 0;

// Confirmation-ballot choice tokens as stored on ballot rows (never candidate ids).
const SEAT_TOKEN = '__seat__';
const REOPEN_TOKEN = '__reopen__';

// --- Runoff: a constrained re-vote for a single vacated seat ---
// When a winner of a CONTESTED race steps down, the seat is NOT refilled by a full
// bracket re-run (that would discard valid ballots and re-contest the seats already
// won). Instead a narrow runoff is held — only the next-in-line candidates, only the
// vacated seat, on the SAME frozen electorate — and the round-1 winners who kept their
// seats carry over into the final result untouched. Config (inert unless RUNOFF_BRACKET
// is set):
//   RUNOFF_BRACKET     bracket holding the runoff (e.g. 'single')
//   RUNOFF_ROUND       ballot round for the runoff (default 2 — kept distinct from the
//                      concluded round-1 ballots/tallies/receipts, never collides)
//   RUNOFF_SEATS       seats the runoff fills (default 1)
//   RUNOFF_CANDIDATES  comma-separated Discord ids of the candidates ON the runoff ballot
//   RUNOFF_SEATED      comma-separated Discord ids of round-1 winners who KEEP their seat
//                      (carried into the final result; not on the runoff ballot)
//   RUNOFF_DEADLINE    ISO timestamp shown as the close time (the hard stop is flipping
//                      VOTING_OPEN — this is for display)
const RUNOFF = (() => {
  const bracket = String(process.env.RUNOFF_BRACKET || '').trim();
  if (!bracket || !BRACKETS.some(b => b.id === bracket)) return null;
  const ids = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  return {
    bracket,
    round: Math.max(2, parseInt(process.env.RUNOFF_ROUND, 10) || 2),
    seats: Math.max(1, parseInt(process.env.RUNOFF_SEATS, 10) || 1),
    candidates: new Set(ids(process.env.RUNOFF_CANDIDATES)),
    seated: ids(process.env.RUNOFF_SEATED),
    deadlineMs: Date.parse(process.env.RUNOFF_DEADLINE || '') || 0,
  };
})();
const runoffActive = bracket => !!RUNOFF && RUNOFF.bracket === bracket;

// The candidates actually on a bracket's ballot, and the seat count that ballot fills —
// both narrowed to the runoff during one. Everywhere else: the full field + configured seats.
function ballotCandidates(bracket, cands) {
  return runoffActive(bracket) ? cands.filter(c => RUNOFF.candidates.has(c.discord_id)) : cands;
}
function ballotSeats(bracket) {
  const seats = BRACKETS.find(b => b.id === bracket)?.seats ?? 0;
  return runoffActive(bracket) ? RUNOFF.seats : seats;
}
// A bracket's race is concluded (its ballot read-only) when a later round is live and
// this bracket isn't the one being re-voted: during a runoff only the runoff bracket
// accepts votes; otherwise it's the reopen path (VOTE_ROUND bumped past round 1).
function concludedFor(bracket) {
  if (RUNOFF) return !runoffActive(bracket);
  return VOTE_ROUND > 1 && !REOPENED_BRACKETS.includes(bracket);
}

// True while a bracket's one-time post-rejection nomination window is open.
function reopenActiveFor(bracket) {
  return REOPENED_BRACKETS.includes(bracket) && Date.now() < REOPEN_DEADLINE_MS;
}

// The candidacy window for a bracket: the global window, or that bracket's reopen.
function applicationWindowOpenFor(bracket) {
  return APPLICATIONS_OPEN || (!!bracket && reopenActiveFor(bracket));
}

// How long a SUBMITTED application stays editable: through the candidacy window and
// the quiet period after it, locking only once voting begins (VOTING_OPEN — or
// RESULTS_OPEN, so the lock holds through the phases after). A bracket's
// post-rejection reopen counts as its window, so its candidates can edit for the
// re-run even though the wider election has moved on.
function applicationEditableFor(bracket) {
  return (!VOTING_OPEN && !RESULTS_OPEN) || applicationWindowOpenFor(bracket);
}

// The round a bracket's race is decided in: reopened brackets re-vote in round 2
// (once VOTE_ROUND is bumped); every other race concluded in round 1.
function roundFor(bracket) {
  if (runoffActive(bracket)) return RUNOFF.round;
  return REOPENED_BRACKETS.includes(bracket) ? VOTE_ROUND : 1;
}

// 'confirmation' when the field is unopposed (0 < candidates ≤ seats), 'contested'
// when there are more runners than seats, null while the field is empty.
function raceMode(candidateCount, seats) {
  if (!candidateCount) return null;
  return candidateCount <= seats ? 'confirmation' : 'contested';
}

// --- The frozen electorate (continuous-holding rule, enforceable form) ---
// True continuous holding can't be proven from a single chain read, so it's enforced
// as TWO checkpoints: when VOTER_SNAPSHOT=<label> is set, voting requires the voter's
// wallet to be (1) in that snapshot — the holder set frozen when the election was
// announced — AND (2) holding at vote time (the live eligibility check). Assets bought
// after the announcement can't vote in this election. The snapshot is captured ONCE,
// at startup, from the bulk holder data, unioned with the authoritative per-wallet
// reads in `applicants` (covers holders the bulk snapshot's indexer missed); re-runs
// are no-ops because the existing snapshot is found and reused. FAIL-CLOSED: while
// the flag is set but the snapshot isn't captured yet, ballots are rejected.
const VOTER_SNAPSHOT = String(process.env.VOTER_SNAPSHOT || '').trim();
let voterSnapshotInfo = null; // { wallets, capturedAt } once captured/loaded

async function ensureVoterSnapshot() {
  if (!VOTER_SNAPSHOT) return;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      // Local testing seed — honored only when the gitignored dev-login helper is
      // loaded (the same trust gate as dev-login itself), so it can't exist in prod.
      if (devLogin && process.env.VOTER_SNAPSHOT_SEED) {
        const rows = process.env.VOTER_SNAPSHOT_SEED.split(',').map(s => s.trim()).filter(Boolean)
          .map(wallet => ({ wallet, creatureCount: 1, landCount: 0 }));
        await db.saveVoterSnapshot(VOTER_SNAPSHOT, rows);
        voterSnapshotInfo = await db.getVoterSnapshotInfo(VOTER_SNAPSHOT);
        console.warn(`[snapshot] '${VOTER_SNAPSHOT}' seeded with ${voterSnapshotInfo?.wallets ?? 0} dev wallets (dev-login present).`);
        return;
      }
      const existing = await db.getVoterSnapshotInfo(VOTER_SNAPSHOT);
      if (existing) {
        // Captured on a previous boot — the electorate stays frozen across restarts.
        voterSnapshotInfo = existing;
        console.log(`[snapshot] '${VOTER_SNAPSHOT}' already captured: ${existing.wallets} wallets (${existing.capturedAt}).`);
        return;
      }
      if (holderCounts.fetchedAt > 0) {
        const byWallet = new Map();
        const add = (w, key, n) => {
          const r = byWallet.get(w) || { wallet: w, creatureCount: 0, landCount: 0 };
          r[key] = Math.max(r[key], n | 0); // union keeps the higher count per source
          byWallet.set(w, r);
        };
        for (const [w, n] of holderCounts.creature) add(w.toLowerCase(), 'creatureCount', n);
        for (const [w, n] of holderCounts.land) add(w.toLowerCase(), 'landCount', n);
        for (const a of await db.getApplicantWallets()) {
          add(a.wallet.toLowerCase(), 'creatureCount', a.creature_count);
          add(a.wallet.toLowerCase(), 'landCount', a.land_count);
        }
        const rows = [...byWallet.values()].filter(r => r.creatureCount + r.landCount > 0);
        await db.saveVoterSnapshot(VOTER_SNAPSHOT, rows);
        voterSnapshotInfo = await db.getVoterSnapshotInfo(VOTER_SNAPSHOT);
        db.recordEvent({ event: 'snapshot.captured', detail: { label: VOTER_SNAPSHOT, wallets: rows.length } });
        console.log(`[snapshot] '${VOTER_SNAPSHOT}' captured: ${rows.length} holder wallets.`);
        return;
      }
    } catch (err) {
      console.error('[snapshot] capture attempt failed:', err.message);
    }
    await new Promise(r => setTimeout(r, 15000)); // holder data / DB not ready yet — retry
  }
  console.error(`[snapshot] '${VOTER_SNAPSHOT}' could NOT be captured — ballots stay blocked (fail-closed).`);
}
ensureVoterSnapshot();

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
  const races = RACE_ORDER.map(id => {
    // During a runoff the bracket's public card shows the narrowed contest (the two
    // next-in-line candidates for the one vacated seat), not the full original field.
    if (runoffActive(id)) {
      return {
        bracket: id,
        seats: RUNOFF.seats,
        candidates: RUNOFF.candidates.size,
        mode: raceMode(RUNOFF.candidates.size, RUNOFF.seats),
        runoff: true,
        runoffDeadline: RUNOFF.deadlineMs ? new Date(RUNOFF.deadlineMs).toISOString() : null,
        reopened: false,
        reopenDeadline: null,
      };
    }
    return {
      bracket: id,
      seats: seatsFor(id),
      candidates: counts[id] || 0,
      mode: raceMode(counts[id] || 0, seatsFor(id)),
      reopened: reopenActiveFor(id),
      reopenDeadline: reopenActiveFor(id) ? new Date(REOPEN_DEADLINE_MS).toISOString() : null,
    };
  });
  const data = {
    applicationsOpen: APPLICATIONS_OPEN,
    votingOpen: VOTING_OPEN,
    resultsOpen: RESULTS_OPEN,
    // Electorate transparency: the size + capture date of the frozen voter snapshot
    // (count only — never the wallet list).
    voterSnapshot: VOTER_SNAPSHOT && voterSnapshotInfo
      ? { wallets: voterSnapshotInfo.wallets, capturedAt: voterSnapshotInfo.capturedAt }
      : null,
    races,
    totalCandidates: races.reduce((n, r) => n + r.candidates, 0),
    // True elected-seat total (whole brackets), independent of a runoff narrowing one
    // card to the single vacated seat — so the footnote's seat count stays correct.
    electedSeats: RACE_ORDER.reduce((n, id) => n + seatsFor(id), 0),
    appointedSeats: APPOINTED_SEATS,
    lastUpdated: new Date().toISOString(),
  };
  if (RESULTS_OPEN) data.results = await computeElectionResults();
  electionCache.data = data;
  electionCache.at = Date.now();
  return data;
}

// Final per-race results — published on /api/election only once RESULTS_OPEN. Reads
// ONLY aggregate tallies (no voter identities) and resolves each race per the rules
// above. Candidate names are public by this point (voting has opened), so seated
// names + per-candidate counts are included.
async function computeElectionResults() {
  const [candidates, tallies, allReceipts] = await Promise.all([
    db.getCandidates(), db.getBallotTallies(), db.getBallotReceipts(),
  ]);
  return RACE_ORDER.map(id => {
    const seats = BRACKETS.find(b => b.id === id)?.seats ?? 0;
    // getCandidates() orders by submitted_at ASC — kept as the transparent tie-break
    // (first to declare wins a dead heat).
    const cands = candidates.filter(c => c.bracket === id);
    const round = roundFor(id);
    const roundTallies = tallies.filter(t => t.bracket === id && Number(t.round) === round);
    const turnout = roundTallies.reduce((n, t) => n + t.n, 0);
    const votesFor = choice => roundTallies.find(t => t.choice === choice)?.n || 0;

    // Inclusion verifiability: the race's receipt codes are published with the result
    // (codes only — random, linked to neither voter nor choice, sorted neutrally).
    // Every voter can find their own code, and receipts.length must equal turnout.
    const receipts = allReceipts
      .filter(r => r.bracket === id && Number(r.round) === round)
      .map(r => r.receipt);

    // Runoff bracket: the final seats = the round-1 winner(s) who carried over PLUS the
    // runoff winner(s). Only the runoff candidates are tallied (round = RUNOFF.round);
    // the carried winner keeps their seat without re-running. Submission-order tie-break
    // is preserved (getCandidates() is submitted_at ASC + a stable sort).
    if (runoffActive(id)) {
      const rows = cands
        .filter(c => RUNOFF.candidates.has(c.discord_id))
        .map(c => ({ name: c.display_name || '', votes: votesFor(c.discord_id) }))
        .sort((a, b) => b.votes - a.votes);
      rows.forEach((r, i) => { r.seated = i < RUNOFF.seats; });
      const carried = cands.filter(c => RUNOFF.seated.includes(c.discord_id)).map(c => c.display_name || '');
      return {
        bracket: id, seats, round, turnout, receipts,
        mode: 'contested', runoff: true, status: 'seated', rows, carried,
        seated: [...carried, ...rows.filter(r => r.seated).map(r => r.name)],
      };
    }

    const mode = raceMode(cands.length, seats);
    const base = { bracket: id, seats, mode, round, turnout, receipts };
    if (!mode) return { ...base, status: 'vacant', seated: [] }; // empty field → appointment track

    if (mode === 'contested') {
      // A reopened race that gained candidates is contested, but its re-vote lives in
      // round 2 — until VOTE_ROUND is bumped the round-1 tallies are confirmation
      // tokens, not candidate votes, so the result is still pending.
      if (REOPENED_BRACKETS.includes(id) && round === 1) {
        return { ...base, status: 'revote', seated: [] };
      }
      const rows = cands
        .map(c => ({ name: c.display_name || '', votes: votesFor(c.discord_id) }))
        .sort((a, b) => b.votes - a.votes); // stable sort → submission order breaks ties
      rows.forEach((r, i) => { r.seated = i < seats; });
      return { ...base, status: 'seated', rows, seated: rows.filter(r => r.seated).map(r => r.name) };
    }

    // Confirmation race: "Seat" vs "Reopen nominations".
    const seatVotes = votesFor(SEAT_TOKEN);
    const reopenVotes = votesFor(REOPEN_TOKEN);
    const names = cands.map(c => c.display_name || '');
    const conf = { ...base, seatVotes, reopenVotes };
    if (reopenVotes <= seatVotes) {
      // Majority (or tie — status quo favours seating) to seat.
      return { ...conf, status: 'seated', seated: names };
    }
    if (reopenActiveFor(id)) {
      // Reopen won and the window is live: nominations are open right now.
      return { ...conf, status: 'reopened', seated: [], reopenDeadline: new Date(REOPEN_DEADLINE_MS).toISOString() };
    }
    if (REOPENED_BRACKETS.includes(id) && REOPEN_DEADLINE_MS && Date.now() >= REOPEN_DEADLINE_MS) {
      // Window came and went with no new entrant (the field is still ≤ seats, or we'd
      // be in the contested branch) → the original candidates are seated by rule.
      return { ...conf, status: 'seatedByRule', seated: names };
    }
    // Reopen won but the window hasn't been scheduled yet.
    return { ...conf, status: 'reopenPending', seated: [] };
  });
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

// Affinity between a voter's stances and a candidate's positions: per shared
// proposition, agreement = 1 − |Δstance| / 4 (scale 1–5), averaged. Pure function.
function affinity(voterPos, candPositions) {
  let sum = 0, n = 0;
  for (const id of PROPOSITION_IDS) {
    const v = voterPos[id];
    const c = candPositions?.[id]?.stance;
    if (v >= 1 && v <= 5 && c >= 1 && c <= 5) { sum += 1 - Math.abs(v - c) / 4; n++; }
  }
  return n ? { pct: Math.round((sum / n) * 100), n } : null;
}

// Validate a client-sent voter ballot into { propId: stance 1-5 }, known props only.
function cleanVoterPositions(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const id of PROPOSITION_IDS) {
      const s = parseInt(raw[id], 10);
      if (s >= 1 && s <= 5) out[id] = s;
    }
  }
  return out;
}

// Opaque, stable per-candidate id for the client to reference a candidate (e.g. to open
// their profile) WITHOUT ever exposing the Discord id. A truncated SHA-256 — not
// reversible to the Discord id, stable across restarts.
function candidateId(discordId) {
  return crypto.createHash('sha256').update(String(discordId)).digest('hex').slice(0, 16);
}

// A candidate avatar is served only if it's a Highrise CDN URL — both on the way into
// the DB (server-derived from the session, never the client) and on the way out, so a
// bad stored value can never reach a page (CSP img-src is the second fence).
function safeIconUrl(u) {
  return typeof u === 'string' && /^https:\/\/cdn\.highrisegame\.com\//.test(u) ? u : null;
}

// Highrise icon URLs are versioned (…/{version}_icon.png) and the old URL is deleted —
// it starts returning 404 — the moment a user restyles their avatar. Avatars are only
// captured at apply/login, so over a multi-week election a candidate's stored URL goes
// stale and the ballot shows a broken image. Periodically re-fetch each submitted
// candidate's current icon from the Highrise profile API and refresh the stored value.
// Same trust model as login: server-derived, cdn.highrisegame.com-only via safeIconUrl.
// Best-effort — never throws, skips any candidate it can't resolve, and only writes
// when the value actually changed.
let avatarRefreshRunning = false;
async function refreshCandidateAvatars() {
  if (avatarRefreshRunning) return;
  avatarRefreshRunning = true;
  let updated = 0;
  try {
    const candidates = await db.getCandidates();
    for (const c of candidates) {
      try {
        // The Highrise user_id is embedded in the stored icon URL (…/user/{id}/…), so a
        // refresh usually needs no extra call. Fall back to the wallet lookup for
        // candidates whose avatar was never captured (the empty ones).
        let userId = (typeof c.avatar === 'string' && (c.avatar.match(/\/user\/([0-9a-f]+)\//i) || [])[1]) || null;
        if (!userId) {
          const wallet = await auth.fetchHighriseWallet(c.discord_id).catch(() => null);
          userId = wallet?.userId || null;
        }
        if (!userId) continue;
        const profile = await auth.fetchHighriseProfile(userId);
        const icon = safeIconUrl(profile?.iconUrl);
        if (icon && icon !== c.avatar) {
          await db.updateApplicationAvatar(c.discord_id, icon);
          updated++;
        }
        await new Promise(r => setTimeout(r, 150)); // gentle on the Highrise API
      } catch { /* skip this candidate; keep the others going */ }
    }
    if (updated) console.log(`[avatars] refreshed ${updated} candidate avatar(s)`);
  } catch (err) {
    console.error('[avatars] refresh failed:', err.message);
  } finally {
    avatarRefreshRunning = false;
  }
}
// Warm shortly after boot (backfills stale/empty avatars on deploy) then hourly, so
// avatars stay current as candidates keep restyling through the election.
setTimeout(() => { refreshCandidateAvatars(); }, 15 * 1000).unref();
setInterval(() => { refreshCandidateAvatars(); }, 60 * 60 * 1000).unref();

// A single candidate's public profile for the click-through detail view. Consented
// fields only — never wallet or Discord id. During the CANDIDACY phase it's an
// anonymous preview: pitch + VAA positions (the matchable part) are shown, but the
// candidate's NAME and free-text open-question ANSWERS are withheld until voting opens,
// at which point the full profile becomes public.
function publicCandidateProfile(c) {
  const profile = {
    id: candidateId(c.discord_id),
    bracket: c.bracket || null,
    pitch: c.pitch || '',
    positions: c.positions || {},
  };
  if (VOTING_OPEN) {
    profile.name = c.display_name || '';
    profile.avatar = safeIconUrl(c.avatar);
    profile.answers = c.answers || {};
  }
  return profile;
}

// /api/vote — the voting-advice matcher, computed ENTIRELY server-side so candidate
// positions never reach the browser (the client only ever sees ranked names + match %).
// Gated to signed-in, voting-eligible holders.
//   GET  → { propositions, candidateCount } (to render the questionnaire).
//   POST { positions } → { results: [{ name, bracket, pitch, pct, n }], candidateCount }.
// PRIVACY: the gate reads the STORED eligibility snapshot (no recompute side-effects),
// and the handler writes NOTHING and logs NOTHING about the voter's answers — they're
// matched in memory and discarded. No DB row, no audit event, so there's no persistent
// trace of who matched or how they voted. POST is lightly rate-limited per voter to
// blunt attempts to infer candidate positions by probing many crafted ballots.
async function handleVoteApi(request, response) {
  const cookies = auth.parseCookies(request);
  const session = await db.getSession(cookies[auth.SESSION_COOKIE]);
  if (!session) { sendJson(response, 401, { error: 'Sign in to find your match.' }); return; }
  const elig = session.eligibility || {};
  if (!elig.canVotePendingHoldTime) { sendJson(response, 403, { error: 'Only eligible voters can use the matcher.' }); return; }

  if (request.method === 'GET') {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const cid = url.searchParams.get('candidate');

    // Click-through: one candidate's full profile (positions + answers) on demand.
    // Lazy + per-candidate (not bulk), and like the match it writes/logs nothing about
    // which profile was viewed, so a voter's interest stays untraceable.
    if (cid) {
      const wait = rateLimited(`profile:${session.discord_id}`, 240, 60 * 60 * 1000);
      if (wait) { sendJson(response, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': String(wait) }); return; }
      const cand = (await db.getCandidates()).find(c => candidateId(c.discord_id) === cid);
      if (!cand) { sendJson(response, 404, { error: 'Candidate not found.' }); return; }
      sendJson(response, 200, { candidate: publicCandidateProfile(cand) });
      return;
    }

    const candidates = await db.getCandidates();
    sendJson(response, 200, { propositions: PROPOSITIONS, candidateCount: candidates.length, votingOpen: VOTING_OPEN });
    return;
  }

  if (request.method === 'POST') {
    const wait = rateLimited(`match:${session.discord_id}`, 60, 60 * 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many match requests. Try again shortly.' }, { 'Retry-After': String(wait) }); return; }

    let body;
    try { body = await readJsonBody(request); }
    catch (err) { sendJson(response, err.statusCode || 400, { error: err.message }); return; }

    const voterPos = cleanVoterPositions(body.positions);
    const candidates = await db.getCandidates();
    const results = Object.keys(voterPos).length
      ? candidates
          .map(c => {
            const m = affinity(voterPos, c.positions);
            // `id` is the opaque handle the client uses to open this candidate's profile.
            const row = { id: candidateId(c.discord_id), bracket: c.bracket || null, pitch: c.pitch || '', pct: m ? m.pct : null, n: m ? m.n : 0 };
            // Candidate names (and avatars — equally identifying) are withheld until
            // the voting phase opens — never sent during the anonymous preview.
            if (VOTING_OPEN) {
              row.name = c.display_name || '';
              row.avatar = safeIconUrl(c.avatar);
            }
            return row;
          })
          .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
      : [];
    sendJson(response, 200, { results, candidateCount: candidates.length, votingOpen: VOTING_OPEN });
    return;
  }

  sendJson(response, 405, { error: 'Method not allowed.' });
}

// /api/ballot — the OFFICIAL vote (the matcher above is advisory and casts nothing).
// Gated to signed-in, voting-eligible holders; the 3-month continuous-hold rule is
// verified against the candidacy-window snapshot, as on the rest of the panel.
//   GET  → phase + the voter's races: candidates (opaque id, name once voting is
//          open, pitch), each race's mode, and the caller's own ballot if cast.
//   POST { bracket, choice } → casts the ballot. Votes are FINAL once cast (the
//          published rule) — storage is insert-only and re-votes get a 409.
// PRIVACY: the ballot row (voter ↔ choice) exists only to enforce one vote per race;
// it never leaves the server. The audit event records THAT a ballot was cast, never
// the choice. Tallies are published only as aggregates once RESULTS_OPEN.
async function handleBallotApi(request, response) {
  const cookies = auth.parseCookies(request);
  const session = await db.getSession(cookies[auth.SESSION_COOKIE]);
  if (!session) { sendJson(response, 401, { error: 'Sign in to vote.' }); return; }
  // LIVE eligibility — recompute against current holdings (same as the application
  // API) so a wallet emptied since login can't vote on a stale session snapshot.
  const elig = await refreshEligibility(session, cookies[auth.SESSION_COOKIE]);
  if (!elig.canVotePendingHoldTime) { sendJson(response, 403, { error: 'Only eligible holders can vote.' }); return; }

  // Checkpoint two of the continuous-holding rule: the wallet must be in the frozen
  // electorate. Fail-closed while the snapshot flag is set but capture hasn't landed.
  const snapshotActive = !!VOTER_SNAPSHOT;
  const snapshotReady = !snapshotActive || !!(voterSnapshotInfo && voterSnapshotInfo.wallets);
  const inSnapshot = !snapshotActive
    || (snapshotReady && await db.isInVoterSnapshot(VOTER_SNAPSHOT, elig.ethWallet));

  if (request.method === 'GET') {
    const [candidates, own] = await Promise.all([
      db.getCandidates(),
      db.getBallotsFor(session.discord_id),
    ]);
    // Map a stored choice to its client-safe form: confirmation tokens become
    // 'seat'/'reopen'; a candidate Discord id becomes the opaque hash.
    const clientChoice = c => c === SEAT_TOKEN ? 'seat' : c === REOPEN_TOKEN ? 'reopen' : candidateId(c);
    const races = RACE_ORDER.map(id => {
      const cands = ballotCandidates(id, candidates.filter(c => c.bracket === id)); // runoff narrows the field
      const seats = ballotSeats(id);                                                // runoff fills only the vacated seat(s)
      const round = roundFor(id);
      const mode = raceMode(cands.length, seats);
      // All of the voter's picks in this race (up to `seats`).
      const mine = own.filter(b => b.bracket === id && Number(b.round) === round);
      const picks = mine.map(b => ({ choice: clientChoice(b.choice), receipt: b.receipt, castAt: b.cast_at || null }));
      return {
        bracket: id,
        seats,
        mode,
        round,
        runoff: runoffActive(id) || undefined,
        runoffDeadline: runoffActive(id) && RUNOFF.deadlineMs ? new Date(RUNOFF.deadlineMs).toISOString() : undefined,
        // Concluded races are read-only: the other brackets while a runoff is live, or
        // round-1 races once a later round is running.
        concluded: concludedFor(id),
        candidates: cands.map(c => ({
          id: candidateId(c.discord_id),
          pitch: c.pitch || '',
          // Names + avatars are public from the moment voting opens, results included.
          ...(VOTING_OPEN || RESULTS_OPEN ? { name: c.display_name || '', avatar: safeIconUrl(c.avatar) } : {}),
        })),
        picks,
        // How many more picks this voter may still cast in this race.
        picksRemaining: mode ? Math.max(0, seats - picks.length) : 0,
      };
    });
    sendJson(response, 200, {
      votingOpen: VOTING_OPEN,
      resultsOpen: RESULTS_OPEN,
      round: VOTE_ROUND,
      snapshot: snapshotActive
        ? { active: true, ready: snapshotReady, in: inSnapshot, capturedAt: voterSnapshotInfo?.capturedAt || null }
        : { active: false },
      races,
    });
    return;
  }

  if (request.method === 'POST') {
    if (!VOTING_OPEN) { sendJson(response, 403, { error: 'Voting is not open.' }); return; }
    if (snapshotActive && !snapshotReady) {
      sendJson(response, 503, { error: 'The voter snapshot isn\'t ready yet — try again in a moment.' });
      return;
    }
    if (!inSnapshot) {
      sendJson(response, 403, { error: 'Voting is limited to wallets in the official holder snapshot.' });
      return;
    }
    // 3 races and final votes — a low cap comfortably covers honest use.
    const wait = rateLimited(`ballot:${session.discord_id}`, 20, 60 * 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': String(wait) }); return; }

    let body;
    try { body = await readJsonBody(request); }
    catch (err) { sendJson(response, err.statusCode || 400, { error: err.message }); return; }

    const bracket = RACE_ORDER.includes(body.bracket) ? body.bracket : null;
    if (!bracket) { sendJson(response, 400, { error: 'Unknown race.' }); return; }
    if (concludedFor(bracket)) {
      sendJson(response, 403, { error: 'This race has already concluded.' });
      return;
    }

    // During a runoff only the two runoff candidates are accepted, and only one pick.
    const cands = ballotCandidates(bracket, (await db.getCandidates()).filter(c => c.bracket === bracket));
    const seats = ballotSeats(bracket);
    const mode = raceMode(cands.length, seats);
    if (!mode) { sendJson(response, 400, { error: 'This race has no candidates.' }); return; }

    // Resolve the client choice into the stored value, validating it against the mode.
    const rawChoice = String(body.choice || '');
    let choice = null;
    if (mode === 'confirmation') {
      if (rawChoice === 'seat') choice = SEAT_TOKEN;
      else if (rawChoice === 'reopen') choice = REOPEN_TOKEN;
    } else {
      choice = cands.find(c => candidateId(c.discord_id) === rawChoice)?.discord_id || null;
    }
    if (!choice) { sendJson(response, 400, { error: 'That choice isn\'t on this ballot.' }); return; }

    const receipt = crypto.randomBytes(5).toString('hex').toUpperCase();
    // A voter may cast up to `seats` distinct picks in this race (the Member race
    // elects 2; single-seat and confirmation races cap at 1).
    const { row: saved, reason, count } = await db.castBallot({
      discordId: session.discord_id,
      bracket,
      round: roundFor(bracket),
      choice,
      receipt,
      maxPicks: seats,
    });
    if (!saved) {
      // seats === 1 → any rejection just means "already voted here". seats > 1 → tell
      // them whether it's a duplicate candidate or they're out of votes.
      const msg = seats <= 1
        ? 'You already voted in this race — votes are final once cast.'
        : reason === 'duplicate'
          ? 'You already voted for that candidate — pick a different one for your other vote.'
          : `You've used all ${seats} of your votes in this race.`;
      sendJson(response, 409, { error: msg });
      return;
    }

    // Audit THAT a pick was cast (turnout traceability) — never the choice.
    db.recordEvent({ event: 'ballot.cast', discordId: session.discord_id, detail: { bracket, round: saved.round, mode, pick: count, seats } });
    sendJson(response, 200, { ok: true, bracket, receipt: saved.receipt, castAt: saved.cast_at || null, picksRemaining: Math.max(0, seats - count) });
    return;
  }

  sendJson(response, 405, { error: 'Method not allowed.' });
}

// /api/polls — official community polls (lib/polls.js), the Council's mechanism for
// sending a big call to an HCC-wide vote. Same trust chain as the election ballot:
// Discord sign-in → Highrise-linked wallet → live holder check. One holder, one vote
// (enforced per account AND per wallet), insert-only with a private receipt.
//   GET  → viewer context (signed-in? holder?) + every poll's status, options,
//          turnout, the caller's own vote, and — once closed — the final tallies
//          with the published receipt-code list (inclusion verifiability, as on
//          the election board).
//   POST /api/polls/vote { poll, choice } → casts the vote. FINAL once cast —
//          storage is insert-only and re-votes get a 409.
// PRIVACY: the vote row (voter ↔ choice) exists only to enforce the one-vote rule;
// it never leaves the server. The audit event records THAT a vote was cast, never
// the choice. No running tally while a poll is open (same rule as the election).
// Read the raw request body as a Buffer (bounded). The ingest route needs the exact
// bytes to verify the HMAC, so it can't go through readJsonBody (which parses).
function readRawBody(request, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, aborted = false; const chunks = [];
    request.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > limitBytes) {
        aborted = true; chunks.length = 0;
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    request.on('error', err => { if (!aborted) reject(err); });
  });
}

// Constant-time hex compare that never throws on malformed input.
function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

// Verify the ingest HMAC: sha256(secret, rawBody). The header may be bare hex or
// prefixed 'sha256='. Replay of a captured request is harmless — every write is an
// idempotent upsert/delete keyed on the message id — so no timestamp/nonce is needed.
function verifyIngestSignature(rawBody, headerVal) {
  if (!ANNOUNCEMENTS_INGEST_SECRET) return false;
  const provided = String(headerVal || '').trim().replace(/^sha256=/i, '');
  const expected = crypto.createHmac('sha256', ANNOUNCEMENTS_INGEST_SECRET).update(rawBody).digest('hex');
  return safeEqualHex(provided, expected);
}

const DISCORD_IMG_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
// Keep only https URLs served from Discord's own CDNs (matches the page CSP img-src).
// Anything else is dropped so a malformed/hostile payload can't point an <img> off-site.
function safeDiscordImg(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && DISCORD_IMG_HOSTS.has(u.host) ? u.href : null;
  } catch { return null; }
}
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)(\?|$)/i;
function isImageAttachment(att) {
  return /^image\//i.test(att?.content_type || '') || IMAGE_EXT_RE.test(att?.filename || att?.url || '');
}

function discordMessageUrl(messageId) {
  return `https://discord.com/channels/${DISCORD_GUILD_ID}/${ANNOUNCEMENTS_CHANNEL_ID}/${messageId}`;
}

// Bound + normalize an incoming Discord message into the row our DB stores. Trusted
// source (the bot), but still capped so one bad payload can't bloat the table.
function normalizeAnnouncementMessage(msg) {
  const clip = (s, n) => String(s ?? '').slice(0, n);
  const attachments = Array.isArray(msg.attachments) ? msg.attachments.slice(0, 10).map(a => ({
    url: clip(a.url, 600),
    filename: clip(a.filename, 200),
    content_type: clip(a.content_type, 100),
    width: Number(a.width) || null,
    height: Number(a.height) || null,
    size: Number(a.size) || null,
  })) : [];
  const embeds = Array.isArray(msg.embeds) ? msg.embeds.slice(0, 10).map(e => ({
    title: clip(e.title, 400),
    description: clip(e.description, 4000),
    url: clip(e.url, 600),
    image: clip(e.image?.url || e.image, 600),
    thumbnail: clip(e.thumbnail?.url || e.thumbnail, 600),
  })) : [];
  // Resolved mention names, keyed by snowflake id. Bounded and type-checked so a bad
  // payload can't bloat the row; names are escaped at render time, never trusted as HTML.
  const mentions = {};
  const rawMentions = (msg.mentions && typeof msg.mentions === 'object' && !Array.isArray(msg.mentions)) ? msg.mentions : {};
  let mcount = 0;
  for (const [id, val] of Object.entries(rawMentions)) {
    if (mcount >= 200) break;
    if (!/^\d{1,25}$/.test(id) || !val) continue;
    const type = ['role', 'user', 'channel'].includes(val.type) ? val.type : 'user';
    mentions[id] = { type, name: clip(val.name, 100) };
    mcount++;
  }
  return {
    messageId: String(msg.id),
    channelId: String(msg.channel_id),
    authorId: msg.author?.id ? String(msg.author.id) : null,
    authorName: clip(msg.author?.username, 200) || null,
    authorDisplay: clip(msg.author?.display_name || msg.author?.global_name, 200) || null,
    authorAvatar: clip(msg.author?.avatar, 600) || null,
    content: clip(msg.content, 8000),
    attachments,
    embeds,
    mentions,
    postedAt: msg.timestamp,
    editedAt: msg.edited_timestamp || null,
  };
}

// Merge announcements that are one post split across several back-to-back messages.
// Consecutive rows by the SAME author within ANNOUNCEMENTS_GROUP_WINDOW_MS collapse into
// one row: texts joined in order, attachments/embeds/mentions concatenated, timestamp =
// the first message (when the announcement began), edited = the latest edit in the group,
// and message_id = the first message so "View on Discord" opens where it starts. Purely a
// read-time transform — stored rows remain individual, so edits/deletes still work and a
// deleted middle message just drops out and the group re-forms. Input is newest-first (as
// db returns); output is newest-first too.
function groupAnnouncementRows(rows) {
  if (ANNOUNCEMENTS_GROUP_WINDOW_MS <= 0) return rows;
  const asc = rows.slice().sort((a, b) => new Date(a.posted_at) - new Date(b.posted_at));
  const groups = [];
  for (const r of asc) {
    const g = groups[groups.length - 1];
    const prev = g && g[g.length - 1];
    const sameAuthor = prev && r.author_id && prev.author_id && String(r.author_id) === String(prev.author_id);
    const gap = prev ? (new Date(r.posted_at) - new Date(prev.posted_at)) : Infinity;
    if (prev && sameAuthor && gap >= 0 && gap <= ANNOUNCEMENTS_GROUP_WINDOW_MS) g.push(r);
    else groups.push([r]);
  }
  const merged = groups.map(g => {
    if (g.length === 1) return g[0];
    const first = g[0];
    const mentions = {};
    for (const r of g) Object.assign(mentions, (r.mentions && typeof r.mentions === 'object') ? r.mentions : {});
    const editTimes = g.map(r => r.edited_at).filter(Boolean).map(t => new Date(t).getTime());
    return {
      ...first,
      content: g.map(r => r.content || '').join('\n\n'),
      attachments: g.flatMap(r => Array.isArray(r.attachments) ? r.attachments : []),
      embeds: g.flatMap(r => Array.isArray(r.embeds) ? r.embeds : []),
      mentions,
      posted_at: first.posted_at,
      edited_at: editTimes.length ? new Date(Math.max(...editTimes)) : null,
    };
  });
  merged.sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at));
  return merged;
}

// Shape a stored row for the public feed. Announcements are already public in Discord,
// so nothing here is sensitive — but URLs are still constrained to Discord's CDNs and
// image/file attachments are split so the client renders each correctly.
function shapeAnnouncement(row) {
  const atts = Array.isArray(row.attachments) ? row.attachments : [];
  const attachments = atts.map(a => {
    if (isImageAttachment(a)) {
      const src = safeDiscordImg(a.url);
      return src ? { type: 'image', url: src, name: a.filename || '', width: a.width || null, height: a.height || null } : null;
    }
    // Non-image files render as a download chip; the href is a plain link (not an <img>).
    return a.url ? { type: 'file', url: String(a.url), name: a.filename || 'attachment', size: a.size || null } : null;
  }).filter(Boolean);

  const embeds = (Array.isArray(row.embeds) ? row.embeds : []).map(e => ({
    title: e.title || '',
    description: e.description || '',
    url: /^https?:\/\//i.test(e.url || '') ? e.url : '',
    image: safeDiscordImg(e.image) || safeDiscordImg(e.thumbnail) || '',
  })).filter(e => e.title || e.description || e.image);

  return {
    id: row.message_id,
    url: discordMessageUrl(row.message_id),
    author: {
      name: row.author_display || row.author_name || 'Highrise Creature Club',
      avatar: safeDiscordImg(row.author_avatar) || null,
    },
    content: row.content || '',
    attachments,
    embeds,
    mentions: (row.mentions && typeof row.mentions === 'object') ? row.mentions : {},
    postedAt: row.posted_at ? new Date(row.posted_at).toISOString() : null,
    editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null,
  };
}

// Announcements feed API.
//   GET  /api/announcements          → public feed (live rows, newest first)
//   POST /api/announcements/ingest   → the bot mirrors create/edit/delete here.
// INGEST CONTRACT (see the config block near the top of this file):
//   Auth: header `X-HCC-Signature: sha256=<hmac>` where hmac = HMAC-SHA256(secret, rawBody).
//   Body: a single `{ type, message }` or a batch `{ events: [{ type, message }, ...] }`.
//     type 'upsert' (default) stores/updates; 'delete' soft-deletes by message id.
//   GUARDS: a message is only stored when it belongs to ANNOUNCEMENTS_CHANNEL_ID and
//   carries no thread_id — so thread replies under an announcement, and anything from
//   another channel, are refused. Upsert is keyed on the message id, so an edited
//   message updates its one card instead of ever creating a second.
async function handleAnnouncementsApi(request, response, url) {
  const { pathname } = url;

  if (pathname === '/api/announcements' && request.method === 'GET') {
    const rows = await db.getAnnouncements({ limit: 50 });
    sendJson(response, 200, {
      channelUrl: `https://discord.com/channels/${DISCORD_GUILD_ID}/${ANNOUNCEMENTS_CHANNEL_ID}`,
      announcements: groupAnnouncementRows(rows).map(shapeAnnouncement),
    }, { 'Cache-Control': 'public, max-age=60' });
    return;
  }

  if (pathname === '/api/announcements/ingest' && request.method === 'POST') {
    if (!ANNOUNCEMENTS_INGEST_SECRET) {
      sendJson(response, 503, { error: 'Announcement ingest is not configured.' });
      return;
    }
    // Light rate limit — the bot batches, so this only ever trips on abuse.
    const wait = rateLimited(`ann-ingest:${request.socket.remoteAddress || 'unknown'}`, 240, 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many requests.' }, { 'Retry-After': String(wait) }); return; }

    let raw;
    try { raw = await readRawBody(request); }
    catch (err) { sendJson(response, err.statusCode || 400, { error: err.message }); return; }

    if (!verifyIngestSignature(raw, request.headers['x-hcc-signature'])) {
      db.recordEvent({ event: 'announcement.ingest', ok: false, detail: { reason: 'bad_signature' } });
      sendJson(response, 401, { error: 'Invalid signature.' });
      return;
    }

    let body;
    try { body = JSON.parse(raw.toString('utf8') || '{}'); }
    catch { sendJson(response, 400, { error: 'Invalid JSON.' }); return; }

    const events = Array.isArray(body.events) ? body.events
      : (body.message || body.type) ? [{ type: body.type, message: body.message }] : [];
    if (!events.length) { sendJson(response, 400, { error: 'No events.' }); return; }
    if (events.length > 200) { sendJson(response, 413, { error: 'Too many events in one request.' }); return; }

    let upserted = 0, deleted = 0, skipped = 0;
    for (const ev of events) {
      const msg = ev?.message || {};
      const type = ev?.type === 'delete' ? 'delete' : 'upsert';
      const messageId = msg.id != null ? String(msg.id) : null;
      if (!messageId) { skipped++; continue; }

      if (type === 'delete') {
        // Safe to delete by id alone: only ids we actually stored exist in the table,
        // and thread replies were never stored, so this can't touch anything but a
        // real announcement.
        await db.deleteAnnouncement(messageId);
        deleted++;
        continue;
      }

      // Upsert guards: right channel, and NOT a thread reply.
      if (String(msg.channel_id) !== ANNOUNCEMENTS_CHANNEL_ID || msg.thread_id) { skipped++; continue; }
      if (!msg.timestamp) { skipped++; continue; }
      await db.upsertAnnouncement(normalizeAnnouncementMessage(msg));
      upserted++;
    }

    db.recordEvent({ event: 'announcement.ingest', ok: true, detail: { upserted, deleted, skipped } });
    sendJson(response, 200, { ok: true, upserted, deleted, skipped });
    return;
  }

  sendJson(response, request.method === 'GET' || request.method === 'POST' ? 404 : 405,
    { error: request.method === 'GET' || request.method === 'POST' ? 'Not found' : 'Method not allowed.' });
}

async function handlePollsApi(request, response, url) {
  const { pathname } = url;
  const cookies = auth.parseCookies(request);
  const sid = cookies[auth.SESSION_COOKIE];
  const session = await db.getSession(sid);

  if (pathname === '/api/polls' && request.method === 'GET') {
    // Viewer context for the page's gates. Eligibility is recomputed against the
    // current holder snapshot (cheap in-memory read) so buys/sells reflect
    // without a re-login — same behaviour as the eligibility card.
    let viewer = { authenticated: false };
    let myVotes = [];
    if (session) {
      const elig = await refreshEligibility(session, sid);
      viewer = {
        authenticated: true,
        profile: publicProfile(session.profile),
        linked: !!(elig.linked && elig.ethWallet),
        holdersAvailable: !!elig.holdersAvailable,
        holder: !!elig.canVotePendingHoldTime,
      };
      myVotes = await db.getPollVotesFor(session.discord_id);
    }

    const tallies = await db.getPollTallies();
    const polls = [];
    for (const p of POLLS) {
      const status = pollStatus(p);
      const mine = myVotes.find(v => v.poll_id === p.id);
      const row = {
        id: p.id,
        key: p.i18nKey,
        options: p.options,
        status,
        opensAt: p.opensAt ? new Date(p.opensAt).toISOString() : null,
        closesAt: p.closesAt ? new Date(p.closesAt).toISOString() : null,
        // Participation count is public while open (motivating, reveals no choice);
        // per-option counts wait for the close.
        turnout: tallies.filter(t => t.poll_id === p.id).reduce((n, t) => n + t.n, 0),
        myVote: mine ? { choice: mine.choice, receipt: mine.receipt, castAt: mine.cast_at || null } : null,
      };
      if (status === 'closed') {
        const counts = {};
        for (const opt of p.options) {
          counts[opt] = tallies.find(t => t.poll_id === p.id && t.choice === opt)?.n || 0;
        }
        row.results = { counts, receipts: await db.getPollReceipts(p.id) };
      }
      polls.push(row);
    }
    sendJson(response, 200, { viewer, polls });
    return;
  }

  if (pathname === '/api/polls/vote' && request.method === 'POST') {
    if (!session) { sendJson(response, 401, { error: 'Sign in to vote.' }); return; }
    // LIVE eligibility — recompute against current holdings so a wallet emptied
    // since login can't vote on a stale session snapshot (same as the ballot).
    const elig = await refreshEligibility(session, sid);
    if (!elig.canVotePendingHoldTime || !elig.ethWallet) {
      sendJson(response, 403, { error: 'Only HCC holders can vote in official polls.' });
      return;
    }

    const wait = rateLimited(`poll:${session.discord_id}`, 20, 60 * 60 * 1000);
    if (wait) { sendJson(response, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': String(wait) }); return; }

    let body;
    try { body = await readJsonBody(request); }
    catch (err) { sendJson(response, err.statusCode || 400, { error: err.message }); return; }

    const poll = POLLS.find(p => p.id === String(body.poll || ''));
    if (!poll) { sendJson(response, 400, { error: 'Unknown poll.' }); return; }
    const status = pollStatus(poll);
    if (status !== 'open') {
      sendJson(response, 403, { error: status === 'closed' ? 'This poll has closed.' : 'This poll isn\'t open yet.' });
      return;
    }
    const choice = poll.options.includes(String(body.choice || '')) ? String(body.choice) : null;
    if (!choice) { sendJson(response, 400, { error: 'That choice isn\'t on this poll.' }); return; }

    const receipt = crypto.randomBytes(5).toString('hex').toUpperCase();
    const { row: saved, reason } = await db.castPollVote({
      pollId: poll.id,
      discordId: session.discord_id,
      wallet: elig.ethWallet,
      choice,
      receipt,
    });
    if (!saved) {
      const msg = reason === 'wallet'
        ? 'Your linked wallet already voted in this poll — one holder, one vote.'
        : 'You already voted in this poll — votes are final once cast.';
      sendJson(response, 409, { error: msg });
      return;
    }

    // Audit THAT a vote was cast (turnout traceability) — never the choice.
    db.recordEvent({ event: 'poll.cast', discordId: session.discord_id, detail: { poll: poll.id } });
    sendJson(response, 200, { ok: true, poll: poll.id, receipt: saved.receipt, castAt: saved.cast_at || null });
    return;
  }

  sendJson(response, pathname === '/api/polls' || pathname === '/api/polls/vote' ? 405 : 404,
    { error: pathname === '/api/polls' || pathname === '/api/polls/vote' ? 'Method not allowed.' : 'Not found' });
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
    if (!applicationWindowOpenFor(elig.bracket)) {
      // Outside the window, only a submitted candidate who can still edit (i.e.
      // voting hasn't begun) keeps the AI draft — it exists to polish their live profile.
      const existing = await db.getApplication(session.discord_id);
      if (!(existing?.status === 'submitted' && applicationEditableFor(elig.bracket))) {
        sendJson(response, 403, { error: 'Applications are not open yet.' });
        return;
      }
    }
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
      // Per-user window: the global candidacy phase, or this holder's bracket having
      // its one-time reopen after a "reopen nominations" outcome.
      applicationsOpen: applicationWindowOpenFor(elig.bracket),
      // Whether a submitted application can still be edited — true until voting begins.
      canEdit: applicationEditableFor(elig.bracket),
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

    // Editing a live candidacy: once submitted, an application STAYS submitted — a
    // "draft" save must never silently pull the candidate out of the race — and it
    // stays editable until voting begins, then freezes so the field voters see
    // can't shift mid-vote. Every edit re-runs full validation.
    const existing = await db.getApplication(session.discord_id);
    const alreadySubmitted = existing?.status === 'submitted';
    if (alreadySubmitted && !applicationEditableFor(elig.bracket)) {
      db.recordEvent({ event: 'application.edit_blocked', discordId: session.discord_id, ok: false, detail: { reason: 'voting_open' } });
      sendJson(response, 403, { error: 'Voting has begun — your submitted application is locked.' });
      return;
    }

    const status = (alreadySubmitted || body.status === 'submitted') ? 'submitted' : 'draft';
    // Candidacy window closed — drafts are allowed (so candidates can prepare),
    // but a FIRST submission is blocked until the window (global or the bracket's
    // post-rejection reopen) is open. Edits to an already-submitted application
    // passed the editable gate above instead.
    if (status === 'submitted' && !alreadySubmitted && !applicationWindowOpenFor(elig.bracket)) {
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
      avatar: safeIconUrl(session.profile?.highriseIcon),
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
          resubmission: alreadySubmitted,
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
const PUBLIC_FILES = new Set(['index.html', 'changelog.json', 'gen2-progress.json', 'favicon.ico', 'robots.txt']);
// Gzip candidates: text formats plus raw OpenType/TrueType fonts (~45% smaller).
// WOFF/WOFF2 and images are already compressed — recompressing wastes CPU for ~0%.
const COMPRESSIBLE_EXT = new Set(['.html', '.css', '.js', '.json', '.svg', '.otf', '.ttf']);
const gzipCache = new Map(); // filePath → { etag, body } — one gzipped copy per content version
// Clean tab URLs (/council, /roadmap/gen2, …) all serve the app shell; the client
// router in js/app.js opens the matching tab from location.pathname. 'apply' is a
// legacy alias — the old Apply & Vote tab now lives at /council/vote and the client
// router rewrites it — kept so bookmarks and old OAuth redirects keep working.
const TAB_ROUTES = new Set(['club', 'announcements', 'council', 'apply', 'polls', 'roadmap', 'guides', 'perks',
  'holders', 'market', 'trade', 'changelog', 'contribute', 'terms', 'privacy']);
const SERVABLE_EXT = new Set([
  '.html', '.css', '.js', '.json',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.otf', '.ttf', '.woff', '.woff2', '.txt',
]);

// Content-Security-Policy for HTML pages: scripts only from self + the Chart.js CDN
// (no inline/eval scripts); images from self + the Discord & Highrise avatar CDNs;
// inline styles allowed (the markup uses style="" attributes); frames only for the
// YouTube guide embeds; everything else self.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cdn.highrisegame.com https://cdn.discordapp.com https://media.discordapp.net https://cdn-production.joinhighrise.com https://i2c.seadn.io",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src https://www.youtube.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

// Security headers. CSP + framing protection only matter for the HTML document;
// nosniff/referrer apply to everything.
// Referrer-Policy is `same-origin` (not the `strict-origin-when-cross-origin` default): the
// card on-ramp rides Immutable's Transak account, and Transak's edge 403s the widget
// ("Access Denied. T-INF-201") when the request carries a Referer outside that account's
// whitelisted domains — which our origin is. No outbound link here needs a referrer, so we
// send none cross-origin (also nice privacy-wise); full referrers stay for same-origin use.
function securityHeaders(extension) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
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

  // Clean tab routes: up to three short lowercase segments with no extension
  // (e.g. /roadmap, /roadmap/gen2, /guides/walkthroughs/funding) serve the app shell.
  // This only ever returns index.html — it never reads an arbitrary path — so it
  // can't leak files; the file allowlist below is unchanged.
  if (segments.length <= 3 && TAB_ROUTES.has(segments[0]) &&
      !path.extname(normalized) && segments.every(s => /^[a-z0-9-]+$/.test(s))) {
    return path.join(root, 'index.html');
  }

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

// Parse a request URL against the (untrusted) Host header. A malformed Host makes
// `new URL` throw synchronously — before any async .catch() attaches — which would
// crash the process; return null instead so routes can answer 400.
function parseRequestUrl(request) {
  try { return new URL(request.url, `http://${request.headers.host || 'localhost'}`); }
  catch { return null; }
}

const server = http.createServer((request, response) => {
  // Auth + eligibility API (async). Catches errors so a failed lookup sends the
  // user back to the Apply panel with an error flag instead of hanging.
  if (request.url.startsWith('/api/auth') || request.url === '/api/me') {
    const url = parseRequestUrl(request);
    if (!url) { sendJson(response, 400, { error: 'Bad request.' }); return; }
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

  if (request.url.startsWith('/api/vote')) {
    handleVoteApi(request, response).catch(err => {
      console.error('Vote match API error:', err.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
    });
    return;
  }

  if (request.url.startsWith('/api/ballot')) {
    handleBallotApi(request, response).catch(err => {
      console.error('Ballot API error:', err.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
    });
    return;
  }

  if (request.url.startsWith('/api/polls')) {
    const url = parseRequestUrl(request);
    if (!url) { sendJson(response, 400, { error: 'Bad request.' }); return; }
    handlePollsApi(request, response, url).catch(err => {
      console.error('Polls API error:', err.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
    });
    return;
  }

  if (request.url.startsWith('/api/announcements')) {
    const url = parseRequestUrl(request);
    if (!url) { sendJson(response, 400, { error: 'Bad request.' }); return; }
    handleAnnouncementsApi(request, response, url).catch(err => {
      console.error('Announcements API error:', err.message);
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

  if (request.url.startsWith('/api/market/creatures') || request.url.startsWith('/api/market/land')
      || request.url.startsWith('/api/market/onramp')) {
    const url = parseRequestUrl(request);
    if (!url) { sendJson(response, 400, { error: 'bad_request' }); return; }
    handleMarketplaceApi(request, response, url).catch(err => {
      console.error('Marketplace API error:', err.message);
      // readJsonBody rejections carry a 4xx statusCode (bad JSON / oversized body);
      // wrapper errors carry a stable .code (e.g. 'unavailable').
      if (!response.headersSent) sendJson(response, err.statusCode || 503, { error: err.code || (err.statusCode ? 'bad_request' : 'unavailable') });
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

    // Text (and OTF/TTF font) responses gzip well and this app ships big ones —
    // ~200KB CSS and ~140KB HTML, both `no-cache`. Served raw, a slow connection
    // paints the HTML before the stylesheet lands (flash of unstyled content), so
    // compression is a rendering fix, not just bandwidth. Vary only on responses
    // that can differ per encoding, to keep shared caches from fragmenting media.
    const compressible = COMPRESSIBLE_EXT.has(extension);
    const vary = compressible ? { Vary: 'Accept-Encoding' } : {};

    // Honour conditional requests — cheap 304 when the browser already has this content.
    // The ETag is weak (content-derived, encoding-agnostic), so it validates both the
    // gzipped and identity variants.
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl, ...vary, ...secHeaders });
      response.end();
      return;
    }

    const baseHeaders = {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      ETag: etag,
      ...vary,
      ...secHeaders,
    };

    const acceptsGzip = String(request.headers['accept-encoding'] || '').includes('gzip');
    if (!compressible || !acceptsGzip) {
      response.writeHead(200, baseHeaders);
      response.end(data);
      return;
    }

    // Compress once per content version, then serve from memory. The cache is bounded
    // by the allowlisted static text files, and a stale entry self-evicts when the
    // file's ETag moves on.
    const cached = gzipCache.get(filePath);
    if (cached && cached.etag === etag) {
      response.writeHead(200, { ...baseHeaders, 'Content-Encoding': 'gzip' });
      response.end(cached.body);
      return;
    }
    zlib.gzip(data, (gzipError, gzipped) => {
      if (gzipError || gzipped.length >= data.length) {
        response.writeHead(200, baseHeaders);
        response.end(data);
        return;
      }
      gzipCache.set(filePath, { etag, body: gzipped });
      response.writeHead(200, { ...baseHeaders, 'Content-Encoding': 'gzip' });
      response.end(gzipped);
    });
  });
});

server.listen(port, host, () => {
  console.log(`HCC Player Council site running on http://${host}:${port}`);
});
