// Ordered-failover JSON-RPC for Ethereum mainnet (the LAND side).
//
// Why this exists: every mainnet read used to go to ONE hardcoded public node. When that
// node rate-limited or lagged, holder counts, LAND credits and the sanctions screen all
// failed with it. This tries a list of providers in order and only moves on when the
// failure is a TRANSPORT failure.
//
// The distinction that matters:
//   - transport failure (DNS, TLS, timeout, 429, 5xx, unparseable body) → try the next
//     provider. The question was never answered.
//   - JSON-RPC error object, or a non-429 4xx → the node ANSWERED, and the answer is "no".
//     A revert is a real result (estatesToParcels reverting is how we detect the end of an
//     array). Retrying it on another provider gets the same answer and hides real bugs, so
//     it's tagged `err.rpcError = true` and rethrown immediately.
//
// Callers MUST branch on `err.rpcError` when they treat a revert as data. See
// estateLandOwnedBy in server.js, which used to `catch { break }` and so counted a dead
// node as "this holder owns no more parcels".
'use strict';

const ALCHEMY_KEY = (process.env.ALCHEMY_API_KEY || '').trim();

// Named so failures can be logged without ever printing the Alchemy key (the key sits in
// the URL). Log `p.name`, never `p.url`.
const BLOCKSCOUT = { name: 'blockscout', url: process.env.ETH_RPC_URL || 'https://eth.blockscout.com/api/eth-rpc' };
const PUBLICNODE = { name: 'publicnode', url: process.env.ETH_BALANCE_RPC || 'https://ethereum-rpc.publicnode.com' };
const ALCHEMY    = ALCHEMY_KEY ? { name: 'alchemy', url: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` } : null;

// Two orders, because the two roles want opposite things.
//   read  — heavy, cached, slow-changing estate/LAND calls. Blockscout first to keep load
//           off the rate-limited public node.
//   fresh — wallet balances and allowances, where a stale answer wrongly blocks a funded
//           buyer. Blockscout is LAST here: it has been observed reporting a lagging
//           balance (see the note at server.js:93). Do not reorder without reading it.
const compact = a => a.filter(Boolean);
const CHAINS = {
  read:  compact([BLOCKSCOUT, ALCHEMY, PUBLICNODE]),
  fresh: compact([PUBLICNODE, ALCHEMY, BLOCKSCOUT]),
};

// Alchemy's free tier caps eth_getLogs at a 10 block range (measured 2026-08-15: a wider
// range returns HTTP 400 "you can make eth_getLogs requests with up to a 10 block range").
// Failing over a range read to Alchemy returns an EMPTY log set, not an error, which would
// silently zero every estate's LAND credit. Never send these there.
const NO_ALCHEMY_METHODS = new Set(['eth_getLogs']);

// Remember which provider answered last, so one dead primary isn't re-probed on every call
// of a 3000-call fan-out. Short, so recovery is automatic.
const STICKY_MS = 60 * 1000;
const sticky = new Map(); // role -> { name, at }

function order(role, method) {
  let list = CHAINS[role] || CHAINS.read;
  if (NO_ALCHEMY_METHODS.has(method)) list = list.filter(p => p.name !== 'alchemy');
  const pref = sticky.get(role);
  if (pref && Date.now() - pref.at < STICKY_MS) {
    const first = list.find(p => p.name === pref.name);
    if (first) list = [first, ...list.filter(p => p !== first)];
  }
  return list;
}

// A transport failure means "nobody answered" — worth asking someone else.
function isTransport(err) {
  if (err?.rpcError) return false;          // the node answered; the answer stands
  const status = Number(err?.httpStatus);
  if (Number.isFinite(status)) return status === 429 || status >= 500;
  return true;                              // fetch/DNS/TLS/timeout/abort/parse
}

async function callOne(provider, method, params, timeoutMs) {
  let res;
  try {
    res = await fetch(provider.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw Object.assign(new Error(`${method} transport: ${err.message}`), { transport: true });
  }
  if (!res.ok) {
    const err = new Error(`${method} HTTP ${res.status}`);
    err.httpStatus = res.status;
    // A non-429 4xx is a malformed request on our side. Another provider won't fix it.
    if (res.status < 500 && res.status !== 429) err.rpcError = true;
    throw err;
  }
  let body;
  try { body = await res.json(); }
  catch (err) { throw Object.assign(new Error(`${method}: unparseable body`), { transport: true }); }

  if (body.error) {
    // The node answered and said no (revert, bad params, unknown method). This is DATA.
    throw Object.assign(new Error(`${method}: ${body.error.message || JSON.stringify(body.error)}`), {
      rpcError: true, rpcCode: body.error.code, rpcData: body.error.data,
    });
  }
  return body.result;
}

// Try each provider in order. Returns the first real answer. Throws the last transport
// error only when every provider failed; throws an rpcError immediately.
async function ethRpc(method, params, { role = 'read', timeoutMs = 6000 } = {}) {
  const list = order(role, method);
  if (!list.length) throw new Error(`no RPC provider configured for role ${role}`);
  let last;
  for (const provider of list) {
    try {
      const result = await callOne(provider, method, params, timeoutMs);
      sticky.set(role, { name: provider.name, at: Date.now() });
      return result;
    } catch (err) {
      if (!isTransport(err)) throw err;     // a real answer, or our own bad request
      last = err;
      // Names only. provider.url carries the Alchemy key.
      console.warn(`eth-rpc: ${provider.name} failed for ${method} (${err.message}), trying next`);
    }
  }
  sticky.delete(role);
  throw Object.assign(last || new Error(`${method}: all providers failed`), { allProvidersFailed: true });
}

// Convenience wrappers matching the shapes server.js already uses.
const ethCallVia = (to, data, opts) => ethRpc('eth_call', [{ to, data }, 'latest'], opts);
const providerNames = role => order(role, 'eth_call').map(p => p.name);

module.exports = {
  ethRpc, ethCallVia, providerNames,
  alchemyEnabled: !!ALCHEMY,
  NO_ALCHEMY_METHODS,
};
