'use strict';

// Sign and broadcast a NATIVE-COIN TRANSFER on Immutable zkEVM. Nothing else.
//
// This is the only place in the codebase that holds a private key and signs a
// transaction. Everything else here is non-custodial: the member's own wallet signs and
// the server only ever reads the chain. That property is worth protecting, so this
// module is deliberately built to be incapable of anything but paying someone's gas:
// `data` is hard-coded empty and there is no calldata parameter, so it cannot call a
// contract, grant an approval, or move a token. If a future feature needs those, it
// should get its own reviewed module rather than widen this one.
//
// Built on @noble/curves + @noble/hashes (already direct deps — audited, zero-dep) so
// there's no wallet library in the tree that could grow extra powers on an upgrade.

const { secp256k1 } = require('@noble/curves/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3');

const CHAIN_ID = 13371n; // Immutable zkEVM mainnet

// Immutable zkEVM runs a ~0 base fee (observed: 49 wei) and a 10 gwei minimum priority
// fee, so effectively the whole gas price is priority. Floor our bid at the network
// minimum and pad it, or a transfer sits unmined during a busy block.
const MIN_PRIORITY_WEI = 10n * 10n ** 9n;
const PLAIN_TRANSFER_GAS = 21000n;
const GAS_CAP = 150000n; // a transfer to a smart-contract wallet costs more than 21k; cap the blast radius

// --- RLP ---------------------------------------------------------------------------
// Minimal encoder: just the two forms a transaction envelope needs (byte string, list).

// Minimal big-endian bytes for a quantity. RLP has no leading zeros and encodes 0 as
// the empty string, which is also what EIP-1559 expects for an unset field.
function qtyBytes(n) {
  if (n < 0n) throw new Error('negative quantity');
  let hex = n.toString(16);
  if (hex === '0') return Buffer.alloc(0);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

function lenPrefix(len, offset) {
  if (len <= 55) return Buffer.from([offset + len]);
  const l = qtyBytes(BigInt(len));
  return Buffer.concat([Buffer.from([offset + 55 + l.length]), l]);
}

function rlpBytes(buf) {
  // A single byte below 0x80 is its own encoding; everything else takes a length prefix.
  if (buf.length === 1 && buf[0] < 0x80) return buf;
  return Buffer.concat([lenPrefix(buf.length, 0x80), buf]);
}

const rlpQty = n => rlpBytes(qtyBytes(n));
const rlpList = items => {
  const payload = Buffer.concat(items);
  return Buffer.concat([lenPrefix(payload.length, 0xc0), payload]);
};

// --- keys / addresses --------------------------------------------------------------

function normalizeKey(raw) {
  const hex = String(raw || '').trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const buf = Buffer.from(hex, 'hex');
  // Reject a key outside the curve order (and zero) — noble would throw later anyway,
  // but failing here keeps the error away from anything that might log the value.
  try { if (!secp256k1.utils.isValidPrivateKey(buf)) return null; } catch { return null; }
  return buf;
}

function addressFromKey(privKey) {
  const pub = secp256k1.getPublicKey(privKey, false); // 65 bytes, 0x04-tagged
  return '0x' + Buffer.from(keccak_256(pub.slice(1))).toString('hex').slice(-40);
}

const addrBytes = a => Buffer.from(String(a).replace(/^0x/, ''), 'hex');

// --- RPC ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One JSON-RPC call, with a short retry on transport failures and transient statuses.
//
// The retry is not optional politeness. The site already hammers api.immutable.com to
// build the collection index, and a single `fetch failed` under that load would otherwise
// turn gas assist off for that member with a bare "unavailable" — the same failure mode
// the Squid gas quote had (see lib/squid-bridge.js). Reads are idempotent, so retrying
// them is free; `retries: 0` is passed for the broadcast, which is handled separately in
// sendNative because a lost response there needs care rather than a blind resend.
async function rpc(url, method, params, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      // DNS, socket, TLS or timeout — undici collapses all of these to "fetch failed".
      if (attempt >= retries) {
        throw Object.assign(new Error(`rpc ${method}: ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`), { cause: err });
      }
      await sleep(400 * (attempt + 1));
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3000) : 400 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message || `rpc ${method} failed`), { rpcError: body.error });
    return body.result;
  }
}

const hexToBig = h => BigInt(h ?? '0x0');

// A transaction's hash is keccak256 of its signed bytes, so we know it before we send.
// That's what lets a lost broadcast response be resolved instead of guessed at.
const txHashOf = rawHex => '0x' + Buffer.from(keccak_256(Buffer.from(rawHex.slice(2), 'hex'))).toString('hex');


// --- fees --------------------------------------------------------------------------

// Bid the network's suggested priority (floored at the 10 gwei minimum) plus a 25%
// pad, and set maxFee above it with room for a base-fee move. EIP-1559 only charges
// base + actual priority, so over-bidding maxFee costs nothing.
async function feeFields(url) {
  const [suggested, block] = await Promise.all([
    rpc(url, 'eth_maxPriorityFeePerGas', []).catch(() => null),
    rpc(url, 'eth_getBlockByNumber', ['latest', false]),
  ]);
  const baseFee = hexToBig(block?.baseFeePerGas);
  let priority = suggested ? hexToBig(suggested) : MIN_PRIORITY_WEI;
  if (priority < MIN_PRIORITY_WEI) priority = MIN_PRIORITY_WEI;
  priority = (priority * 125n) / 100n;
  return { maxPriorityFeePerGas: priority, maxFeePerGas: priority + baseFee * 2n + MIN_PRIORITY_WEI };
}

// --- signing -----------------------------------------------------------------------

// EIP-1559 (type 0x02) envelope. `data` is always empty — see the file header.
function buildSigned({ privKey, nonce, to, value, gasLimit, maxFeePerGas, maxPriorityFeePerGas }) {
  const fields = [
    rlpQty(CHAIN_ID),
    rlpQty(nonce),
    rlpQty(maxPriorityFeePerGas),
    rlpQty(maxFeePerGas),
    rlpQty(gasLimit),
    rlpBytes(addrBytes(to)),
    rlpQty(value),
    rlpBytes(Buffer.alloc(0)), // data: none, and no way to pass any
    rlpList([]),               // accessList: empty
  ];
  const unsigned = Buffer.concat([Buffer.from([0x02]), rlpList(fields)]);
  const sig = secp256k1.sign(keccak_256(unsigned), privKey); // low-S by default, as Ethereum requires
  const signed = Buffer.concat([
    Buffer.from([0x02]),
    rlpList([...fields, rlpQty(BigInt(sig.recovery)), rlpQty(sig.r), rlpQty(sig.s)]),
  ]);
  return '0x' + signed.toString('hex');
}

// --- send --------------------------------------------------------------------------

// Nonce bookkeeping. Concurrent grants would otherwise reuse a nonce and one would be
// dropped, so every send goes through one in-process queue and tracks the next nonce
// locally. Any failure clears the cached value so the following send re-reads the chain
// (cheaper than trying to reason about which of a batch actually landed).
const senders = new Map(); // from-address -> { queue: Promise, nextNonce: bigint|null }

function laneFor(from) {
  let lane = senders.get(from);
  if (!lane) { lane = { queue: Promise.resolve(), nextNonce: null }; senders.set(from, lane); }
  return lane;
}

// Send `valueWei` of native IMX to `to`. Returns the transaction hash. Throws on any
// RPC or signing failure — the caller treats that as "the grant didn't happen".
async function sendNative({ rpcUrl, privKey, to, valueWei }) {
  const from = addressFromKey(privKey);
  const lane = laneFor(from);
  const run = lane.queue.then(async () => {
    if (lane.nextNonce == null) {
      lane.nextNonce = hexToBig(await rpc(rpcUrl, 'eth_getTransactionCount', [from, 'pending']));
    }
    const nonce = lane.nextNonce;
    try {
      const fees = await feeFields(rpcUrl);
      // Most destinations are plain wallets (21000), but a Highrise account could be a
      // smart-contract wallet whose receive hook costs more. Estimate, pad, and clamp.
      let gasLimit = PLAIN_TRANSFER_GAS;
      try {
        const est = hexToBig(await rpc(rpcUrl, 'eth_estimateGas', [{
          from, to, value: '0x' + valueWei.toString(16),
        }]));
        if (est > gasLimit) gasLimit = (est * 125n) / 100n;
      } catch { /* estimate is a nicety; 21000 covers the ordinary case */ }
      if (gasLimit > GAS_CAP) gasLimit = GAS_CAP;

      const raw = buildSigned({ privKey, nonce, to, value: valueWei, gasLimit, ...fees });
      const localHash = txHashOf(raw);
      let hash;
      try {
        hash = await rpc(rpcUrl, 'eth_sendRawTransaction', [raw], { retries: 0 });
      } catch (err) {
        // The dangerous case: the node accepted the transaction but we lost the answer.
        // Reporting failure there would release the grant and let the member claim again
        // even though they were already paid. We know the hash without the node's reply,
        // so ask whether it exists before deciding.
        // The chain is the authority, not the error text: if our exact transaction is
        // there (mempool or mined), it was sent. "nonce too low" with nothing at our hash
        // means a DIFFERENT transaction took the nonce, which is a real failure.
        const landed = await rpc(rpcUrl, 'eth_getTransactionByHash', [localHash]).catch(() => null);
        if (!landed) throw err;
        console.warn(`[zk-tx] broadcast reply lost but ${localHash} is on chain — treating as sent`
          + ` (node said: ${(err.rpcError?.message || err.message || '').slice(0, 120)})`);
        hash = localHash;
      }
      lane.nextNonce = nonce + 1n;
      return hash;
    } catch (err) {
      lane.nextNonce = null; // resync from chain on the next attempt
      throw err;
    }
  });
  // Keep the lane alive whatever happens, so one failure can't wedge later sends.
  lane.queue = run.then(() => {}, () => {});
  return run;
}

async function nativeBalance(rpcUrl, address) {
  return hexToBig(await rpc(rpcUrl, 'eth_getBalance', [address, 'latest']));
}

module.exports = { CHAIN_ID, normalizeKey, addressFromKey, sendNative, nativeBalance, rpc };
