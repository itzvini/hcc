'use strict';

// The marketplace's audit trail.
//
// Every other part of this site already records what it did — logins, ballots, gas grants,
// announcements — and until now the part that moves real money recorded nothing. That was
// survivable while every order lived in OpenSea's book and they held the record. It stopped
// being survivable when we started keeping a book of our own: there was no first-party answer
// to "did this member really list that parcel, at that price, when they say they did".
//
// WHAT THIS CAN KNOW, AND WHAT IT CANNOT. This marketplace is non-custodial: we prepare
// unsigned transactions and the member's wallet signs them somewhere we never see. So a row
// here is evidence of what THIS SERVER did, never of what settled on-chain. The event names
// keep that distinction rather than blurring it — `buy_prepare` is "we handed this address
// the calldata to fill that order", which is the whole truth and is not the same claim as
// "they bought it". The chain is where fills are checked; this is where intent is recorded.
//
// The one real outcome we do observe is `book_closed`: our own sweep reading the chain and
// retiring an order it can no longer settle. That row is a fact about the world.

const db = require('./db');

// Shortened for console lines only. The full address goes in the row (see below).
const mask = a => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : '(addr)');

// Keys that must never reach the trail, whatever a caller passes.
//
// `signature` is the dangerous one and the reason this list exists rather than a convention.
// A Seaport signature is a bearer credential: anyone holding it can fill the order straight on
// Seaport. Our house cancel is a soft one — it de-indexes the order and leaves the signature
// live — so a signature sitting in the audit table would be a working key to an order its
// seller believes they withdrew, kept in the one place we promise to retain forever.
const NEVER = new Set(['signature', 'signatures', 'orderParameters', 'orderComponents', 'parameters', 'key', 'apiKey', 'typedData']);

// A whole order won't fit in a log line and doesn't belong in one. Trim anything long enough
// to be a payload rather than a fact.
const MAX_LEN = 200;

function clean(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail || {})) {
    if (NEVER.has(k) || v === undefined || v === null || v === '') continue;
    if (typeof v === 'string') { out[k] = v.length > MAX_LEN ? v.slice(0, MAX_LEN) + '…' : v; continue; }
    if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; continue; }
    if (typeof v === 'bigint') { out[k] = v.toString(); continue; }
    if (Array.isArray(v)) { out[k] = v.slice(0, 20).map(x => String(x).slice(0, MAX_LEN)); continue; }
    // Anything else (an order, a transaction, an Error) is a payload, not a fact.
  }
  return out;
}

/**
 * Record one marketplace action.
 *
 * `action` is the verb, and it becomes `market.<action>` in the trail so the whole set comes
 * back with one prefix query. `ok:false` marks a refusal, which is half the value here: a
 * member saying "it wouldn't let me list" should leave a row saying why.
 *
 * Deliberately NOT given a Discord id, even where a session exists. Trading is wallet-gated,
 * not account-gated, so the wallet is the actor; writing both onto one row would mint a new
 * wallet-to-identity link in a table that has no business holding one. The wallet itself is
 * stored in full and unmasked, because a listing IS a public on-chain offer signed by that
 * address, and a trail that can't name the actor answers no dispute at all.
 *
 * Never awaited by its callers: an audit write must not be able to fail a trade, or delay one.
 */
// Smallest units are what the ROW stores, because money has to be exact and a float is not.
// A console line has the opposite job, so it gets the human figure.
const DECIMALS = { eth: 18, usdc: 6 };
function human(units, currency) {
  const d = DECIMALS[currency];
  if (d == null) return `${units} ${currency || ''}`.trim();
  try {
    const n = Number(BigInt(units)) / 10 ** d;
    return `${n.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${currency.toUpperCase()}`;
  } catch { return `${units} ${currency}`; }
}

function record(action, opts = {}) {
  // The invariant this whole module is written around: an audit write must never be able to
  // fail a trade, or delay one. Callers do not await it, and nothing in here is allowed to
  // throw back into a route that is holding someone's money.
  try { return write(action, opts); }
  catch (err) { console.error(`[market] audit threw for ${action}:`, err.message); }
}

function write(action, { ok = true, wallet = null, ...detail } = {}) {
  const event = `market.${action}`;
  const row = clean({ ...detail, wallet: wallet ? String(wallet).toLowerCase() : null });
  // One console line per write, for whoever is tailing the deploy. Masked there because
  // stdout goes off to a log aggregator; the table is ours.
  const bits = [row.coll, row.book, row.tokenId ? `#${row.tokenId}` : null,
    row.priceUnits && row.currency ? human(row.priceUnits, row.currency) : null,
    row.reason || null, wallet ? mask(String(wallet)) : null,
    ok ? null : `REFUSED ${row.error || '?'}`]
    .filter(Boolean).join(' ');
  console.log(`[market] ${action}${bits ? ' · ' + bits : ''}`);
  return db.recordEvent({ event, ok, detail: row }).catch(err => {
    console.error(`[market] audit write failed for ${event}:`, err.message);
  });
}

module.exports = { record, mask };
