// Read-only Creature browse fallback, served from Blockscout instead of Immutable's API.
//
// WHY this exists: api.immutable.com allows 5 requests/second per IP, and when it 429s or
// falls over, browsing dies with it. explorer.immutable.com is a Blockscout instance
// indexing the same chain on a completely separate budget (verified live: `x-ratelimit-limit:
// 180` per ~50s window), so it stays up when the marketplace API does not.
//
// SCOPE, and it is a hard limit: Blockscout indexes the CHAIN. It has no concept of a
// listing, an offer, or a price, and this module must never pretend otherwise. It serves
// three things only — token metadata/traits, ownership, and a wallet's inventory. Trading
// stays off for the duration of an outage; that is the intended behaviour, not a gap to
// paper over. Anything here that looks like a price is null on purpose.
//
// Every export is safe to call when Blockscout itself is down: it returns null or an empty
// list and logs one line. Nothing here throws at a caller, because the caller is already
// on a failure path and a second throw would take out the degraded page too.
'use strict';

// Same collection server.js trades. If that constant ever moves, this must move with it.
const CREATURE_CONTRACT = '0xCf44b1cBC959295bbBb49935B1b339cC0AA77cdA';

const BASE = (process.env.BLOCKSCOUT_BASE || 'https://explorer.immutable.com').replace(/\/+$/, '');
// Off switch so a bad fallback can be killed without a deploy. Unset means on: this path
// needs no API key, so there is no configuration that could be missing.
const ENABLED = !/^(0|off|false|no)$/i.test(String(process.env.CREATURE_FALLBACK ?? '').trim());

const TOKEN_ID  = /^\d+$/;              // path segment — reject anything that isn't a plain integer
const ADDRESS   = /^0x[0-9a-fA-F]{40}$/;

const FETCH_TIMEOUT_MS = 10_000;        // a hung fallback is worse than no fallback
const FETCH_ATTEMPTS   = 2;             // one retry; this is already the second-choice source

// Cache TTLs. Traits are immutable so metadata could be held far longer, but the same
// record carries `owner`, which is not.
const META_TTL_MS   = 5 * 60 * 1000;
const OWNED_TTL_MS  = 60 * 1000;
const COUNT_TTL_MS  = 5 * 60 * 1000;
const CACHE_MAX     = 400;              // bound memory: keys are per token and per address

const OWNED_MAX_PAGES = 40;             // 40 x 50 = 2000 NFTs; the biggest Creature wallet holds 941
const OWNED_PAGE_PACE_MS = 100;         // pace a long sweep rather than sprint at the budget

// --- Rate budget -------------------------------------------------------------
// Blockscout allows ~180 requests per 50s window. We hold well under it: this runs during
// an outage, when several routes are retrying at once, and being rate-limited off our own
// fallback would leave nothing at all. The gate is global on purpose, so a wallet sweep and
// a token lookup draw from one shared allowance.
const RATE_WINDOW_MS = 50_000;
const RATE_BUDGET    = 120;
const MAX_PARALLEL   = 4;               // never an unbounded fan-out over a wallet's tokens

const sent = [];   // send timestamps inside the current window
const queue = [];  // waiting acquire() resolvers
let active = 0;
let wakeTimer = null;

function pump() {
  while (queue.length && active < MAX_PARALLEL) {
    const now = Date.now();
    while (sent.length && now - sent[0] > RATE_WINDOW_MS) sent.shift();
    if (sent.length >= RATE_BUDGET) {
      // Budget spent: sleep until the oldest send falls out of the window, then re-check.
      if (!wakeTimer) {
        wakeTimer = setTimeout(() => { wakeTimer = null; pump(); }, RATE_WINDOW_MS - (now - sent[0]) + 50);
        if (wakeTimer.unref) wakeTimer.unref(); // must never hold the process open
      }
      return;
    }
    sent.push(now);
    active++;
    queue.shift()();
  }
}
const acquire = () => new Promise(resolve => { queue.push(resolve); pump(); });
function release() { active--; pump(); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// GET a Blockscout path. Returns the parsed body, or null for 404 (a token or address the
// indexer has never seen — a real answer, not a failure). Throws on everything else so the
// exported function above it can log once and degrade.
async function bsGet(path) {
  let lastErr;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (attempt) await sleep(600 * attempt);
    await acquire();
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
      const err = Object.assign(new Error(`Blockscout ${res.status} for ${path}`), { status: res.status });
      if (res.status < 500 && res.status !== 429) throw err; // malformed on our side; a retry repeats it
      lastErr = err;
    } catch (err) {
      if (err.status && err.status < 500 && err.status !== 429) throw err;
      lastErr = err;
    } finally {
      release();
    }
  }
  throw lastErr;
}

// --- Cache -------------------------------------------------------------------
// This is the fallback path, so it is hit repeatedly and by several callers at once for the
// same key. The in-flight map matters more than the TTL: without it, ten concurrent requests
// for one wallet become ten sweeps and we rate-limit ourselves off our own backup.
const cache = new Map();    // key -> { at, data }
const inFlight = new Map(); // key -> Promise

function cacheRead(key, ttlMs) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) { cache.delete(key); return undefined; }
  return hit.data;
}
function cacheWrite(key, data) {
  // Map keeps insertion order, so the first key is the oldest written. Oldest out first.
  if (cache.size >= CACHE_MAX && !cache.has(key)) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), data });
}
async function cached(key, ttlMs, fn) {
  const hit = cacheRead(key, ttlMs);
  if (hit !== undefined) return hit; // `undefined` is the miss marker, so a cached null still counts as a hit
  const running = inFlight.get(key);
  if (running) return running;
  const p = fn()
    .then(data => { cacheWrite(key, data); return data; })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// --- Shaping -----------------------------------------------------------------
// Mirrors server.js's normalizeTraitType so a fallback row is indistinguishable from a
// live one: same title-casing, same rejection of the `attributes` blob and snake_case keys.
function normalizeTraitType(tt) {
  const s = String(tt ?? '').trim();
  if (!s || s === 'attributes' || s.includes('_')) return null;
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\b[a-z]/g, c => c.toUpperCase());
}

// Blockscout returns `trait_type`; server.js and the client both read `trait`. Normalise
// here so `attributes.find(a => /rarity/i.test(a.trait))` works unchanged downstream.
function shapeAttributes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(a => ({ trait: normalizeTraitType(a?.trait_type ?? a?.trait ?? a?.name), value: a?.value }))
    .filter(a => a.trait && (typeof a.value === 'string' || typeof a.value === 'number'));
}

const rarityOf = attrs => attrs.find(a => /rarity/i.test(a.trait))?.value ?? null;

function traitsOf(attrs) {
  const traits = {};
  for (const a of attrs) if (!(a.trait in traits)) traits[a.trait] = String(a.value);
  return traits;
}

// A browse row in the exact shape ownedCreatureRows() produces, so the client renders it
// with no change. The orderbook half is null/false because we cannot ask, NOT because we
// asked and got "no". The caller MUST flag the response degraded (see lib/upstream-health.js)
// or the UI will report an outage as "nothing is for sale", which is how someone mis-prices
// against a book that isn't really empty. `source` is here so the caller can badge these.
function browseRow(tokenId, metadata) {
  const id = String(tokenId);
  const attributes = shapeAttributes(metadata?.attributes);
  return {
    tokenId: id,
    name: metadata?.name || `Highrise Creature #${id}`,
    image: metadata?.image || null,
    rarity: rarityOf(attributes),
    rank: null,          // statistical rank is the collection index's job, not the chain's
    traits: traitsOf(attributes),
    listed: false,
    listingId: null,
    seller: null,
    priceEth: null,
    totalEth: null,
    listedAt: 0,
    source: 'blockscout',
  };
}

// --- Exports -----------------------------------------------------------------

// Cheap enough to call per request: no network, no key, just the off switch.
function available() {
  return ENABLED && !!BASE;
}

// One Creature's metadata + current owner, or null when unknown/unavailable.
// `tokenId` is the packed on-chain id (2^128 + n), the same namespace server.js's
// collections and listings endpoints use — verified live, they match exactly.
async function tokenMeta(tokenId) {
  if (!available()) return null;
  const id = String(tokenId ?? '').trim();
  if (!TOKEN_ID.test(id)) return null;
  try {
    return await cached(`meta:${id}`, META_TTL_MS, async () => {
      const body = await bsGet(`/api/v2/tokens/${CREATURE_CONTRACT}/instances/${id}`);
      if (!body) return null;
      const attributes = shapeAttributes(body.metadata?.attributes);
      return {
        tokenId: id,
        name: body.metadata?.name || `Highrise Creature #${id}`,
        image: body.metadata?.image || null,
        rarity: rarityOf(attributes),
        attributes,
        // Lowercased: every wallet comparison in this codebase is case-insensitive, and a
        // checksummed address silently failing an equality check has bitten us before.
        owner: body.owner?.hash ? String(body.owner.hash).toLowerCase() : null,
        source: 'blockscout',
      };
    });
  } catch (err) {
    console.error(`Blockscout token meta failed for ${id}:`, err.message);
    return null;
  }
}

// Every Creature a wallet holds, as browse rows. Returns [] on failure — the caller cannot
// tell "none" from "could not ask" out of this value alone, so it must consult available()
// and its own health ledger before rendering an empty grid as an empty wallet.
async function ownedBy(address) {
  if (!available()) return [];
  const addr = String(address ?? '').trim();
  if (!ADDRESS.test(addr)) return [];
  try {
    return await cached(`owned:${addr.toLowerCase()}`, OWNED_TTL_MS, async () => {
      const byId = new Map(); // also de-dupes across a page boundary
      let next = null;
      for (let page = 0; page < OWNED_MAX_PAGES; page++) {
        const q = new URLSearchParams({ type: 'ERC-721' });
        // Blockscout hands back the next page's params as an object to echo back verbatim.
        for (const [k, v] of Object.entries(next || {})) q.set(k, String(v));
        const body = await bsGet(`/api/v2/addresses/${addr}/nft?${q}`);
        const items = Array.isArray(body?.items) ? body.items : [];
        for (const it of items) {
          // This endpoint returns the wallet's ENTIRE ERC-721 holdings, airdropped spam
          // included. Filter to our contract, case-insensitively: Blockscout checksums the
          // address it echoes back, our constant is checksummed differently by eye.
          const contract = String(it?.token?.address_hash || it?.token?.address || '').toLowerCase();
          if (contract !== CREATURE_CONTRACT.toLowerCase()) continue;
          const id = String(it?.id ?? '');
          if (!TOKEN_ID.test(id) || byId.has(id)) continue;
          byId.set(id, browseRow(id, it.metadata));
        }
        next = body?.next_page_params || null;
        if (!next || !items.length) break;
        await sleep(OWNED_PAGE_PACE_MS);
      }
      return [...byId.values()];
    });
  } catch (err) {
    console.error(`Blockscout wallet inventory failed for ${addr}:`, err.message);
    return [];
  }
}

// Number of distinct Creature holders, or null when unavailable.
async function holderCount() {
  if (!available()) return null;
  try {
    return await cached('holders', COUNT_TTL_MS, async () => {
      const body = await bsGet(`/api/v2/tokens/${CREATURE_CONTRACT}/counters`);
      const n = Number(body?.token_holders_count);
      return Number.isFinite(n) ? n : null;
    });
  } catch (err) {
    console.error('Blockscout holder count failed:', err.message);
    return null;
  }
}

const clearCache = () => { cache.clear(); inFlight.clear(); };

module.exports = {
  available, tokenMeta, ownedBy, holderCount, clearCache,
  CREATURE_CONTRACT, BASE,
};
