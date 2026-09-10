'use strict';

// Sanctions screening for any address we're about to SEND value to.
//
// Reading the chain for anyone is fine. Paying someone is different: the gas faucet
// moves real value out of a company wallet to a member-controlled address, and doing
// that for an OFAC-designated address is a problem no matter how small the amount.
// So every grant is screened first.
//
// Two layers, cheapest first:
//   1. A local denylist (SANCTIONS_DENYLIST) — for anything we're told to block by hand.
//   2. Chainalysis's free on-chain sanctions oracle, which mirrors the OFAC SDN list.
//      No API key and no account. It's deployed on Ethereum mainnet (NOT on Immutable
//      zkEVM — verified: eth_getCode there is empty), so we query it on mainnet. An
//      address is the same address on both chains, so screening it on mainnet is the
//      right question either way.
//
// FAIL CLOSED. If the oracle can't be reached we refuse the grant rather than guess.
// A member seeing "try again in a minute" is a far better outcome than an unscreened
// payment. SANCTIONS_FAIL_OPEN=1 relaxes that for local dev only.
//
// Failing closed only works if reaching the oracle is reliable, and it goes through
// lib/eth-rpc.js for that reason. This used to fetch ONE hardcoded public node, and on
// 2026-09-09 that node (Blockscout) answered HTTP 429 to every single call — so every
// screen failed, every gas grant was refused, and members holding a Creature were sent
// to a ~$30 card on-ramp to buy the $0.0006 of gas we exist to give them. The oracle was
// healthy the whole time; only the transport was dead. Never call a single node here.
//
// Role 'fresh' puts the public node ahead of Blockscout. eth-rpc keeps Blockscout last
// in that order because it can lag on balances, which is irrelevant to an OFAC
// designation — designations change when Treasury publishes, not per block. What is very
// relevant is that this call blocks a member's click and fails closed, so it wants the
// provider most likely to answer on the first try.

const { ethCallVia } = require('./eth-rpc');

const ORACLE = '0x40c57923924b5c5c5455c48d93317139addac8fb'; // Chainalysis sanctions oracle, Ethereum mainnet
const SEL_IS_SANCTIONED = '0xdf592f7d';                      // isSanctioned(address)

const FAIL_OPEN = process.env.SANCTIONS_FAIL_OPEN === '1';

const DENYLIST = new Set(
  (process.env.SANCTIONS_DENYLIST || '')
    .split(',').map(a => a.trim().toLowerCase()).filter(a => /^0x[0-9a-f]{40}$/.test(a)),
);

// Answers change only when OFAC publishes, so cache hard. Bounded so a flood of
// distinct addresses can't grow it without limit.
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE = 5000;
const cache = new Map(); // address -> { sanctioned, at }

async function askOracle(address) {
  const data = SEL_IS_SANCTIONED + address.replace(/^0x/, '').padStart(64, '0');
  const word = String(await ethCallVia(ORACLE, data, { role: 'fresh', timeoutMs: 12000 }) || '');
  // A call to an address with no code returns a bare '0x', not a word. Treating that as
  // "not sanctioned" would pass everyone, so an unparseable answer is no answer.
  if (!/^0x[0-9a-f]{64}$/i.test(word)) throw new Error('sanctions oracle returned no answer');
  return BigInt(word) === 1n;
}

// Screen one address. Returns { ok, sanctioned, source }:
//   ok:false        → we could not get an answer; the caller must NOT pay.
//   sanctioned:true → designated; refuse and log.
// Never throws.
async function screen(address) {
  const addr = String(address || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return { ok: false, sanctioned: false, source: 'bad_address' };
  if (DENYLIST.has(addr)) return { ok: true, sanctioned: true, source: 'denylist' };

  const hit = cache.get(addr);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { ok: true, sanctioned: hit.sanctioned, source: 'cache' };
  }

  try {
    const sanctioned = await askOracle(addr);
    if (cache.size >= MAX_CACHE) cache.clear(); // cheap eviction; re-warms in a few calls
    cache.set(addr, { sanctioned, at: Date.now() });
    return { ok: true, sanctioned, source: 'chainalysis' };
  } catch (err) {
    // Say which kind of nothing we got: every provider down is an outage worth paging on,
    // a single rpcError is a bug in the call above.
    const how = err.allProvidersFailed ? 'all RPC providers failed' : 'oracle refused';
    console.error(`[sanctions] screen failed (${how}):`, err.message);
    // Fail closed: no answer means no payment (unless a dev explicitly opted out).
    return { ok: FAIL_OPEN, sanctioned: false, source: 'unavailable' };
  }
}

module.exports = { screen, ORACLE };
