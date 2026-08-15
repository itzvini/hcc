// Per-upstream health ledger for the two marketplaces.
//
// The problem this solves: a failed read used to become `offers: []` or `listed: false`,
// which renders as a FACT ("no offers", "not for sale") rather than as "we could not ask".
// A user prices a listing against an empty book that isn't really empty. This ledger lets
// every market response say which of its sources answered and how old the data is.
//
// Four states per source:
//   live     — the most recent attempt succeeded.
//   checking — something failed, but not enough to call it an outage yet. Shows no alarm.
//   degraded — sustained failure, and we hold a snapshot within maxAgeMs.
//   down     — sustained failure, and either no snapshot or the snapshot aged out (see
//              last-known.js, which DROPS an expired snapshot rather than serving it).
//
// `checking` exists because the first version alarmed on a single failed read. A cold
// container spends its first seconds building the browse index, and one 429 during that
// window is not an outage. Announcing "the market is offline" while the thing is merely
// warming up is worse than saying nothing: it is the scariest possible message, shown at
// the least reliable moment, and it trained users to distrust a banner that should only
// ever appear when it is true.
//
// The collections are tracked separately on purpose. Immutable being down must never
// change what the LAND tab reports, and vice versa.
'use strict';

// collection -> source -> record
const ledger = new Map();

// Sources that describe presentation only (artwork, names). They can degrade without
// making prices wrong, so they never move the roll-up state or pause trading.
const NON_PRICING = new Set(['meta']);

// Which source gates WRITES for each collection. This is deliberately NOT the roll-up.
// Creature writes go through the @imtbl/orderbook SDK, the same client the offers read
// uses; the Creature browse index is a different client (imxFetch) with a different
// failure mode. Pausing trading because the browse index hiccuped would turn a cosmetic
// outage into a total one for no safety gain, since the write path revalidates the order
// upstream before any transaction reaches the wallet.
const WRITE_SOURCE = { creatures: 'offers', land: 'listings' };

const UPSTREAM = { creatures: 'immutable', land: 'opensea' };

// How stale a snapshot may get before we stop showing it at all.
const MAX_AGE_MS = { creatures: 30 * 60 * 1000, land: 10 * 60 * 1000 };

function rec(coll, source) {
  let byColl = ledger.get(coll);
  if (!byColl) ledger.set(coll, (byColl = new Map()));
  let r = byColl.get(source);
  // `last` records the OUTCOME of the most recent attempt directly. Deriving it by
  // comparing lastFailAt > lastOkAt looked equivalent and is not: Date.now() has 1ms
  // resolution, so a failure recorded in the same millisecond as a success compared as
  // "not newer" and the failure vanished.
  if (!r) byColl.set(source, (r = { last: null, lastOkAt: null, lastFailAt: null, lastError: null, failingSince: null, consecutiveFails: 0 }));
  return r;
}

function noteOk(coll, source) {
  const r = rec(coll, source);
  r.last = 'ok';
  r.lastOkAt = Date.now();
  r.lastError = null;
  r.failingSince = null;
  r.consecutiveFails = 0;
}

// `code` is a stable machine code ('rate_limited' | 'unavailable' | 'not_configured'),
// never a raw upstream message — those must not reach a client.
function noteFail(coll, source, code = 'unavailable') {
  const r = rec(coll, source);
  const now = Date.now();
  r.last = 'fail';
  r.lastFailAt = now;
  r.lastError = code;
  if (!r.failingSince) r.failingSince = now;
  r.consecutiveFails++;
}

// Classify an error into one of the stable codes.
function codeFor(err) {
  const status = Number(err?.status ?? err?.statusCode ?? err?.httpStatus);
  if (status === 429) return 'rate_limited';
  const msg = (err?.message || '').toLowerCase();
  if (/rate.?limit|too many requests|\b429\b/.test(msg)) return 'rate_limited';
  if (/not.?configured|missing api key/.test(msg)) return 'not_configured';
  return 'unavailable';
}

// Before we call an upstream broken it has to fail REPEATEDLY and for long enough that a
// retry would already have fixed it. Both conditions, not either: two fast failures inside
// a second are one blip, and one slow failure is one blip too.
const ALARM_AFTER_FAILS = 2;
const ALARM_AFTER_MS = 10 * 1000;

// Is this source failing badly enough to tell the user about it?
function alarming(r) {
  if (r.consecutiveFails < ALARM_AFTER_FAILS) return false;
  return r.failingSince != null && Date.now() - r.failingSince >= ALARM_AFTER_MS;
}

// State of one source given whether a usable snapshot survives.
// `snapshotAt` is the snapshot's timestamp, or null when there is none.
function sourceState(coll, source, snapshotAt = null) {
  const r = rec(coll, source);
  const failing = r.last === 'fail';
  if (!failing) return { state: 'live', asOf: r.lastOkAt, ageMs: r.lastOkAt ? Date.now() - r.lastOkAt : null, error: null };

  // Failing, but not yet convincingly. Stay quiet, keep trading open, let the client retry.
  if (!alarming(r)) {
    return {
      state: 'checking',
      asOf: r.lastOkAt, ageMs: r.lastOkAt ? Date.now() - r.lastOkAt : null,
      error: null, fails: r.consecutiveFails,
    };
  }

  const maxAge = MAX_AGE_MS[coll] ?? MAX_AGE_MS.creatures;
  const usable = snapshotAt != null && Date.now() - snapshotAt <= maxAge;
  return {
    state: usable ? 'degraded' : 'down',
    asOf: usable ? snapshotAt : null,
    ageMs: usable ? Date.now() - snapshotAt : null,
    error: r.lastError || 'unavailable',
    fails: r.consecutiveFails,
  };
}

// Build the envelope that rides on every market read response.
// `sources` is { name: { state, asOf, ageMs, error } } from sourceState above.
function collectionHealth(coll, sources) {
  const pricing = Object.entries(sources).filter(([name]) => !NON_PRICING.has(name));
  const rank = { live: 0, checking: 1, degraded: 2, down: 3 };
  const worst = pricing.reduce((w, [, s]) => (rank[s.state] > rank[w] ? s.state : w), 'live');

  const writeSrc = WRITE_SOURCE[coll];
  // Most routes don't read the write-path source (a browse response says nothing about the
  // order book), so fall back to what the ledger last saw. That beats assuming: if the
  // offers read failed a second ago, a browse response should still report trading as
  // closed rather than inviting a click that will only fail at the wallet.
  // A source never read at all stays "live", so a healthy market is never paused on
  // missing information.
  const writeState = sources[writeSrc]?.state ?? sourceState(coll, writeSrc, null).state;
  // `checking` keeps trading OPEN. A blip should not yank the buttons out from under
  // someone mid-flow, and letting the attempt through costs nothing: the write path
  // refetches the order and refuses cleanly if it is really gone.
  const trading = writeState === 'live' || writeState === 'checking';

  const withAsOf = pricing.map(([, s]) => s).filter(s => s.asOf != null);
  const asOf = withAsOf.length ? Math.min(...withAsOf.map(s => s.asOf)) : null;
  const r = rec(coll, writeSrc);

  return {
    collection: coll,
    upstream: UPSTREAM[coll] || null,
    state: worst,
    trading,
    asOf: asOf ? new Date(asOf).toISOString() : null,
    ageMs: asOf ? Date.now() - asOf : null,
    maxAgeMs: MAX_AGE_MS[coll] ?? null,
    checkedAt: new Date(Math.max(r.lastOkAt || 0, r.lastFailAt || 0) || Date.now()).toISOString(),
    failingSince: r.failingSince ? new Date(r.failingSince).toISOString() : null,
    error: sources[writeSrc]?.error ?? null,
    sources,
  };
}

// --- Dev fault injection -----------------------------------------------------
// The Immutable host is hardcoded at ~15 call sites with no env override, so without this
// there is no deterministic way to reproduce degraded/down for Creatures. Off unless set.
//   MARKET_FAULT=creatures:offers,creatures:listings
// Holds no secret and is never sent to a client.
// An entry may carry "@afterN": succeed N times, then fail forever. Reaching DEGRADED
// needs a warm snapshot first, so without this the degraded path can only be reproduced by
// waiting for a real outage.
//   MARKET_FAULT=creatures:offers@after1   → first read succeeds, everything after fails
const FAULTS = new Map();
for (const raw of (process.env.MARKET_FAULT || '').split(',').map(s => s.trim()).filter(Boolean)) {
  const [key, after] = raw.split('@after');
  FAULTS.set(key, { remaining: after ? Number(after) || 0 : 0 });
}
function faulted(coll, source) {
  const f = FAULTS.get(`${coll}:${source}`) || FAULTS.get(`${coll}:*`);
  if (!f) return false;
  if (f.remaining > 0) { f.remaining--; return false; }
  return true;
}
function throwIfFaulted(coll, source) {
  if (!faulted(coll, source)) return;
  throw Object.assign(new Error(`MARKET_FAULT ${coll}:${source}`), { status: 503, injected: true });
}

module.exports = {
  noteOk, noteFail, codeFor, sourceState, collectionHealth,
  throwIfFaulted, faulted,
  MAX_AGE_MS, WRITE_SOURCE, UPSTREAM,
};
