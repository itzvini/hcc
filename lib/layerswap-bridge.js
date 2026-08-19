// Layerswap cash-out: moving a member's ETH off Immutable zkEVM back to Ethereum.
//
// WHY THIS EXISTS ALONGSIDE squid-bridge.js
// Squid routes this corridor through Immutable's canonical bridge, which prepays the
// Ethereum-side execution gas through Axelar's gas service. That payment is denominated in
// IMX (zkEVM's native coin) and has to be sitting in the wallet BEFORE the move is signed.
// Measured on 2026-08-19 it ran 54-215 IMX ($5-$21) for the same $211 move inside half an
// hour, and members holding ETH but no IMX simply could not leave: every route we offered
// for acquiring IMX started on Ethereum, where they had nothing.
//
// Layerswap is a solver. The member makes a plain ERC-20 transfer on zkEVM and Layerswap
// pays out ETH from its own float on the other side, so the only gas involved is an
// ordinary zkEVM transfer (a fraction of a cent, well inside what any wallet already
// holds). The fee comes out of the ETH being moved, which is the part that removes the
// trap. Measured: ~$0.65 on 0.105 ETH in about 25 seconds, against $12.42 and ~20 minutes
// through Squid.
//
// THE TRADE-OFF, STATED PLAINLY: the ETH goes to a Layerswap-controlled address and comes
// back from Layerswap's float. For those seconds it is a custody risk the canonical bridge
// does not carry. Immutable list Layerswap on their own toolkit but explicitly disclaim it
// ("Immutable neither builds, owns, operates or deploys Layerswap"). That is why the
// canonical route stays on offer for anyone holding the IMX to pay for it.
//
// No API key: swap creation is unauthenticated, so there is no secret here to leak.

const API = 'https://api.layerswap.io/api/v2';
const SRC_NETWORK = 'IMMUTABLEZK_MAINNET';
const DST_NETWORK = 'ETHEREUM_MAINNET';
const TOKEN = 'ETH';
// ETH on Immutable zkEVM. The transfer we sign has to target THIS contract; a token address
// out of an API response is a claim, not a fact.
const ZK_ETH_TOKEN = '0x52a6c53869ce09a731cd772f245b97a4401d3348';

// Layerswap prices to 8 decimals, so amounts are floored to 8 dp before they are sent.
// Flooring (never rounding up) matters: a value a hair above the wallet's balance would
// quote fine and then fail at signing.
const AMOUNT_DP = 8;

// A kill switch, so the route can be pulled without a deploy if Layerswap has a bad day.
// Unset means on: this is the default cash-out path.
const ENABLED = process.env.LAYERSWAP_ENABLED !== '0';

const fail = (code, statusCode = 503, detail = '') => {
  if (detail) console.error(`layerswap: ${code}: ${detail}`);
  throw Object.assign(new Error(code), { code, statusCode });
};

const configured = () => ENABLED;

// Wei to the decimal string Layerswap's API expects, floored at 8 dp. Kept in BigInt the
// whole way: going via Number loses precision above ~0.009 ETH, which is most of our moves.
function weiToAmountStr(wei) {
  const scale = 10n ** BigInt(18 - AMOUNT_DP);        // wei per 1e-8 ETH
  const units = BigInt(wei) / scale;                  // floor
  const whole = units / 10n ** BigInt(AMOUNT_DP);
  const frac = (units % 10n ** BigInt(AMOUNT_DP)).toString().padStart(AMOUNT_DP, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
// The inverse, for reporting exactly what will move rather than what was asked for.
function amountStrToWei(s) {
  const [w, f = ''] = String(s).split('.');
  return BigInt(w || '0') * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}

async function call(path, { method = 'GET', body = null, timeout = 20000 } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    fail('unavailable', 503, `${method} ${path} threw: ${err.message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // ROUTE_NOT_FOUND means the corridor itself is not on offer right now, which for a
    // solver is a normal operating state rather than a fault: the route exists only while
    // someone is willing to hold the float on the far side. Watched live on 2026-08-19,
    // zkEVM -> Ethereum for ETH was quoting happily and then vanished from Layerswap's own
    // destination list within the hour, while the reverse direction stayed up throughout —
    // Ethereum is the expensive leg to service, so it is the first one pulled.
    //
    // This gets its own code because it needs its own answer. "Try again in a moment" is a
    // lie when the route is gone, and the honest response is to move the member to the
    // canonical bridge instead, which is always there.
    const gone = res.status === 404 || /ROUTE_NOT_FOUND/i.test(text);
    // 400 is Layerswap rejecting the amount itself, which in practice means it sits outside
    // their min/max. The client turns that into "try a different amount".
    const code = gone ? 'route_down' : res.status === 429 ? 'rate_limited' : res.status === 400 ? 'no_route' : 'unavailable';
    const status = gone ? 503 : res.status === 429 ? 429 : res.status === 400 ? 400 : 503;
    fail(code, status, `${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json().catch(() => null);
  if (!json || !json.data) fail('unavailable', 503, `${path}: response had no data`);
  return json.data;
}

// The smallest and largest move Layerswap will take right now, in wei. The client shows
// these instead of letting someone type an amount that can only be refused.
async function limits() {
  const d = await call(`/limits?source_network=${SRC_NETWORK}&source_token=${TOKEN}`
    + `&destination_network=${DST_NETWORK}&destination_token=${TOKEN}`);
  return {
    minWei: amountStrToWei(String(d.min_amount ?? '0')).toString(),
    maxWei: amountStrToWei(String(d.max_amount ?? '0')).toString(),
    minUsd: Number(d.min_amount_in_usd) || null,
    maxUsd: Number(d.max_amount_in_usd) || null,
  };
}

// Shape a Layerswap quote into the same fields the client already reads off the Squid
// cash-out quote, so one render path serves both routes. `tx` is deliberately absent here:
// a quote is only ever a price, and the transaction is minted by createCashout below.
function shapeQuote(q, amountStr) {
  const toEth = Number(q.receive_amount);
  return {
    provider: 'layerswap',
    fromEth: Number(amountStr),
    toEth: Number.isFinite(toEth) ? toEth : null,
    feeUsd: Math.round((Number(q.total_fee_in_usd) || 0) * 100) / 100,
    feeEth: Number(q.total_fee) || 0,
    // Their ETA is a duration string like "00:00:25.0268830". Seconds is all we show.
    durationSeconds: (() => {
      const m = /^(\d+):(\d+):(\d+)/.exec(String(q.avg_completion_time || ''));
      return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
    })(),
    // No IMX is needed beyond ordinary transfer gas. The client keys the whole gas-shortfall
    // panel off this, so it is stated explicitly rather than left to be inferred.
    needsNativeGas: false,
  };
}

// Price a move without committing to one. Cheap and unauthenticated, so it is safe to call
// on every keystroke behind the client's existing debounce.
async function quoteCashout(fromWei, _address) {
  if (!configured()) fail('not_configured', 503);
  const amount = weiToAmountStr(fromWei);
  if (amountStrToWei(amount) === 0n) fail('no_route', 400, 'amount rounds to zero at 8dp');
  const d = await call(`/quote?source_network=${SRC_NETWORK}&source_token=${TOKEN}`
    + `&destination_network=${DST_NETWORK}&destination_token=${TOKEN}`
    + `&amount=${amount}&use_deposit_address=false`);
  const q = d.quote || d;
  if (!q || q.receive_amount == null) fail('unavailable', 503, 'quote had no receive_amount');
  return shapeQuote(q, amount);
}

// Create the swap and return the exact transaction to sign.
//
// Two things worth knowing about what comes back:
//   * The action is a plain ERC-20 `transfer` on the zkEVM ETH token, NOT a call to a
//     Layerswap contract. So there is no approval step, unlike the Squid route. The
//     recipient is one of Layerswap's own externally-owned accounts, shared across every
//     route they run, which is what makes this custodial for the duration.
//   * Layerswap appends 32 bytes to the end of the standard transfer calldata. Those bytes
//     are their own attribution memo, NOT the swap id the API returns (that uuid appears
//     nowhere in the call). Either way the calldata has to be forwarded BYTE FOR BYTE:
//     rebuilding a "clean" transfer from `to` and `amount` strips the memo, and recovering
//     the money then means a support conversation rather than an automatic match.
//
// Source and destination are pinned to the same address by design: this is a cash-out to
// your own wallet on the other chain, never a send to someone else.
async function createCashout(fromWei, address) {
  if (!configured()) fail('not_configured', 503);
  const amount = weiToAmountStr(fromWei);
  if (amountStrToWei(amount) === 0n) fail('no_route', 400, 'amount rounds to zero at 8dp');

  const d = await call('/swaps', {
    method: 'POST',
    timeout: 25000,
    body: {
      source_network: SRC_NETWORK,
      source_token: TOKEN,
      destination_network: DST_NETWORK,
      destination_token: TOKEN,
      amount: Number(amount),
      source_address: address,
      destination_address: address,
      // Where the money goes back to if Layerswap cannot complete the swap. Their refund
      // lifecycle (pending_refund -> refunded) needs this set, and it is the member's own
      // wallet on the source chain, so a refund lands exactly where the ETH started.
      // Leaving it out is how a failed swap turns into a support ticket instead of a refund.
      refund_address: address,
      use_deposit_address: false,
    },
  });

  const swapId = d.swap?.id;
  const action = (d.deposit_actions || [])[0];
  if (!swapId || !action?.to_address || !action?.call_data) {
    fail('unavailable', 503, 'swap response missing id or deposit action');
  }
  // DECODE the call before anyone signs it. Checking the selector alone, as this first did,
  // leaves the two fields that actually decide where the money goes — the recipient and the
  // amount — travelling unread inside the calldata. A wrong recipient sends a member's ETH to
  // a stranger; a wrong amount empties more of their wallet than they agreed to. Neither is
  // recoverable, and "the API wouldn't do that" is not a control.
  //
  // ERC-20 transfer calldata is 4 + 32 + 32 bytes, and Layerswap appends a 32-byte attribution
  // memo, so 100 bytes total. Anything shorter cannot be decoded and is refused outright.
  if (String(action.type) !== 'transfer') fail('unavailable', 503, `unexpected action type ${action.type}`);
  const data = String(action.call_data || '');
  if (!/^0xa9059cbb[0-9a-f]{128,}$/i.test(data)) fail('unavailable', 503, 'call_data is not a decodable ERC-20 transfer');

  // The token being moved must be OUR ETH token, not whatever the response names.
  if (String(action.to_address).toLowerCase() !== ZK_ETH_TOKEN) {
    fail('unavailable', 503, `transfer targets ${action.to_address}, expected the zkEVM ETH token`);
  }
  // The first argument is the recipient. It must be a plain 20-byte address left-padded with
  // zeros: a non-zero upper 12 bytes means the word is not what we think it is.
  const recipWord = data.slice(10, 74);
  if (!/^0{24}[0-9a-f]{40}$/i.test(recipWord)) fail('unavailable', 503, 'transfer recipient is not a clean address');
  const recipient = ('0x' + recipWord.slice(24)).toLowerCase();
  if (recipient === '0x' + '0'.repeat(40)) fail('unavailable', 503, 'transfer recipient is the zero address');
  // It must not be the member's own wallet either: that would be a no-op transfer that burns
  // gas, credits no swap, and looks to them like the money simply vanished into a loop.
  if (recipient === String(address).toLowerCase()) fail('unavailable', 503, 'transfer recipient is the sender');

  // The second argument is the amount, and it must be EXACTLY what we asked to move. Not more,
  // which would overspend, and not less, which would under-fund the swap and strand it.
  const wantWei = amountStrToWei(amount);
  let gotWei;
  try { gotWei = BigInt('0x' + data.slice(74, 138)); } catch { gotWei = null; }
  if (gotWei !== wantWei) {
    fail('unavailable', 503, `transfer amount ${gotWei} does not match the requested ${wantWei}`);
  }

  const q = d.quote && d.quote.receive_amount != null
    ? d.quote
    : { receive_amount: null, total_fee: 0, total_fee_in_usd: 0 };
  return {
    ...shapeQuote(q, amount),
    swapId,
    fromWei: amountStrToWei(amount).toString(),
    // Decoded and checked above; handed back so the client can assert the same facts rather
    // than trust that the server did.
    recipient,
    tx: {
      to: action.to_address,     // pinned to ZK_ETH_TOKEN above
      data: action.call_data,    // transfer(layerswap, amount) + memo, forwarded verbatim
      value: '0x0',              // an ERC-20 transfer moves no native coin
    },
  };
}

// Map Layerswap's swap status onto the stage vocabulary the in-panel tracker already speaks,
// so the cash-out tracker renders identically whichever route was taken.
const STAGE = {
  user_transfer_pending: 'submitted',   // the member's transfer has not been seen yet
  user_transfer_detected: 'bridging',
  ls_transfer_pending: 'bridging',
  completed: 'arrived',
  // Layerswap could not fill the swap and is sending the ETH back to refund_address. The
  // money is not lost, but it is not arriving on Ethereum either, so it must not read as
  // either success or a plain failure. Still in flight until the refund actually lands.
  pending_refund: 'bridging',
  refunded: 'refunded',
  failed: 'failed',
  cancelled: 'failed',
  expired: 'failed',
};

async function getStatus(swapId) {
  if (!configured()) fail('not_configured', 503);
  if (!/^[0-9a-f-]{10,64}$/i.test(String(swapId))) fail('bad_id', 400);
  const d = await call(`/swaps/${encodeURIComponent(swapId)}`, { timeout: 12000 });
  const sw = d.swap || d;
  const status = String(sw.status || '');
  // An unknown status means Layerswap added one we have not mapped. Treating it as still in
  // flight is the safe default: it keeps the tracker polling rather than telling someone
  // their money failed when it has not.
  const stage = STAGE[status] || 'bridging';
  const txs = sw.transactions || [];
  const withHash = t => (t && t.transaction_hash ? t : null);
  const src = withHash(txs.find(t => t.type === 'input'));
  const dst = withHash(txs.find(t => t.type === 'output'));
  return {
    stage,
    status,
    failReason: sw.fail_reason || null,
    srcUrl: src ? `https://explorer.immutable.com/tx/${src.transaction_hash}` : null,
    destUrl: dst ? `https://etherscan.io/tx/${dst.transaction_hash}` : null,
  };
}

module.exports = { configured, quoteCashout, createCashout, getStatus, limits, weiToAmountStr };
