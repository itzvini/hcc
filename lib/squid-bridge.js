// Squid Router bridge quotes — server-side only (the client never talks to Squid, so
// CSP stays connect-src 'self' and the integrator id stays out of the browser).
//
// Purpose: when a buyer's ETH sits on Ethereum mainnet, quote an EXACT-OUTPUT bridge —
// "send X ETH on Ethereum, receive ≥ the amount you're short on Immutable zkEVM" — and
// return the ready-to-sign transaction (to Squid's audited router, signed by the user's
// own wallet on mainnet; non-custodial like everything else here).
//
// SQUID_INTEGRATOR_ID comes from .env (gitignored) / Railway env — NEVER commit it.
// Without it, quoting reports 'not_configured' and the client falls back to the
// prefilled Squid deep-link.

const SQUID_ROUTE_URL = 'https://apiplus.squidrouter.com/v2/route';
const SQUID_STATUS_URL = 'https://v2.api.squidrouter.com/v2/status'; // note: different host than /route
const INTEGRATOR_ID = (process.env.SQUID_INTEGRATOR_ID || '').trim();

const FROM_CHAIN = '1';      // Ethereum mainnet
const TO_CHAIN = '13371';    // Immutable zkEVM
const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // Squid's native-coin placeholder
const ZK_ETH = '0x52a6c53869ce09a731cd772f245b97a4401d3348';     // ETH (ERC-20) on Immutable zkEVM
// IMX is the NATIVE coin of Immutable zkEVM, so it's the same native placeholder as above
// but resolved on the destination chain — this is what pays gas (the ETH ERC-20 can't).
const ZK_IMX = NATIVE_ETH;
const IMX_L1 = '0xf57e7e7c23978c3caec3c3548e3d615c346e79ff';     // IMX (ERC-20) on Ethereum mainnet

const configured = () => !!INTEGRATOR_ID;

const fail = (code, statusCode, logMsg) => {
  if (logMsg) console.error(`Squid bridge [${code}]:`, logMsg);
  throw Object.assign(new Error(code), { code, statusCode });
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One route request. fromAmountWei is a BigInt; returns { route, requestId }.
// fromToken/toToken select the assets: source is native ETH (NATIVE_ETH) or IMX-on-mainnet
// (IMX_L1); destination is the ETH price token (ZK_ETH) or native IMX gas (ZK_IMX).
// fromChain/toChain default to the funding direction (mainnet → zkEVM); the cash-out
// quote below passes them reversed.
//
// Squid rate-limits per integrator id — which is SHARED across all our users — so a brief
// traffic spike, or just the 2 sequential calls a cross-asset ETH→IMX gas quote needs to
// converge, can return 429. Without a retry the whole quote throws and the client collapses
// to the empty Squid deep-link ("no preset amount"). So retry a few times with backoff
// (honoring Retry-After) before giving up; transient 5xx gets the same treatment.
async function fetchRoute(fromAmountWei, address, toToken = ZK_ETH, fromToken = NATIVE_ETH,
  { fromChain = FROM_CHAIN, toChain = TO_CHAIN } = {}) {
  const payload = JSON.stringify({
    fromChain,
    toChain,
    fromToken,
    toToken,
    fromAmount: fromAmountWei.toString(),
    fromAddress: address,
    toAddress: address,
    slippage: 1,
  });
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(SQUID_ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-integrator-id': INTEGRATOR_ID },
      body: payload,
      signal: AbortSignal.timeout(25000),
    });
    const transient = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    if (!transient || attempt >= 2) break; // up to 3 attempts total
    const ra = Number(res.headers.get('retry-after')); // seconds, if Squid sends it
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 4000) : 700 * (attempt + 1);
    await sleep(wait);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // A 400 is Squid rejecting the parameters themselves — for a validated request that's
    // "no route for this amount" (usually too small for the bridge minimum / fees), which
    // the client turns into "try a larger amount" instead of a generic failure.
    const code = res.status === 429 ? 'rate_limited' : res.status === 400 ? 'no_route' : 'unavailable';
    fail(code, res.status === 429 ? 429 : res.status === 400 ? 400 : 503,
      `route ${res.status}: ${body.slice(0, 300)}`);
  }
  const body = await res.json();
  if (!body?.route?.estimate?.toAmount || !body?.route?.transactionRequest) {
    fail('unavailable', 503, 'route response missing estimate/transactionRequest');
  }
  return {
    route: body.route,
    requestId: res.headers.get('x-request-id') || null,
    quoteId: body.route.quoteId ?? body.quoteId ?? null, // needed by the /status tracker
  };
}

// Quote an exact-output bridge: find a fromAmount whose quoted toAmount covers neededWei.
// Squid quotes are exact-input, so we converge on the right fromAmount by re-quoting from
// the observed rate. For a same-asset bridge (ETH→ETH price) a 1%-over seed lands in one
// quote; for a cross-asset bridge (ETH→IMX gas) the two assets differ in value by orders
// of magnitude, so the proportional re-quote scales the seed DOWN as readily as up.
// `toEth`/`fromEth` are token-amount floats — for the IMX route `toEth` is the IMX amount.
async function quoteBridge(neededWei, address, { toToken = ZK_ETH, fromToken = NATIVE_ETH } = {}) {
  if (!configured()) fail('not_configured', 503);

  // Seed: a same-asset bridge (ETH→ETH price, or IMX→IMX gas) starts ~1% over the target;
  // only the cross-asset ETH→IMX swap needs a small, sane ETH seed (its two sides differ
  // in value by orders of magnitude). The refinement corrects whatever the live rate is.
  const crossAsset = fromToken === NATIVE_ETH && toToken === ZK_IMX;
  let fromAmount = crossAsset ? 3n * 10n ** 15n : (neededWei * 101n) / 100n;
  let route, requestId, quoteId, toAmount;
  for (let i = 0; i < 3; i++) {
    ({ route, requestId, quoteId } = await fetchRoute(fromAmount, address, toToken, fromToken));
    toAmount = BigInt(route.estimate.toAmount);
    // Good enough once the output covers the target without wildly overshooting it.
    if (toAmount >= neededWei && toAmount <= (neededWei * 105n) / 100n) break;
    const next = (fromAmount * neededWei * 101n) / (toAmount * 100n); // observed-rate re-quote + 1% cushion
    if (next <= 0n) break;
    fromAmount = next;
  }
  if (toAmount < neededWei) fail('unavailable', 503, 'exact-output refinement still short');

  const est = route.estimate;
  const tx = route.transactionRequest;
  const usd = list => (list || []).reduce((s, c) => s + (Number(c.amountUsd ?? c.amountUSD) || 0), 0);
  const wei2eth = w => Math.round(Number(w) / 1e12) / 1e6;

  return {
    fromEth: wei2eth(fromAmount),
    toEth: wei2eth(toAmount),
    feeUsd: Math.round((usd(est.feeCosts) + usd(est.gasCosts)) * 100) / 100,
    durationSeconds: Number(est.estimatedRouteDuration) || null,
    requestId,
    quoteId,
    // Only what the wallet needs; value as hex for eth_sendTransaction.
    tx: {
      to: tx.target,
      data: tx.data,
      value: tx.value != null ? '0x' + BigInt(tx.value).toString(16) : '0x0',
      gas: tx.gasLimit != null ? '0x' + BigInt(tx.gasLimit).toString(16) : undefined,
    },
  };
}

// Shared shaping for the EXACT-INPUT quotes below (cash-out + top-up): the user picks
// how much to move, one route call, no convergence loop. `approveSpender` is the router
// target when the source is an ERC-20 (the wallet must approve it for fromWei before
// sending), or null for a native-coin source (the amount rides in tx.value).
function shapeExactInQuote(fromWei, route, requestId, quoteId, approveSpender) {
  const est = route.estimate;
  const tx = route.transactionRequest;
  const usd = list => (list || []).reduce((s, c) => s + (Number(c.amountUsd ?? c.amountUSD) || 0), 0);
  const wei2eth = w => Math.round(Number(w) / 1e12) / 1e6;

  return {
    fromEth: wei2eth(fromWei),
    toEth: wei2eth(BigInt(est.toAmount)),
    feeUsd: Math.round((usd(est.feeCosts) + usd(est.gasCosts)) * 100) / 100,
    durationSeconds: Number(est.estimatedRouteDuration) || null,
    requestId,
    quoteId,
    fromWei: fromWei.toString(),
    approveSpender,
    tx: {
      to: tx.target,
      data: tx.data,
      value: tx.value != null ? '0x' + BigInt(tx.value).toString(16) : '0x0',
      gas: tx.gasLimit != null ? '0x' + BigInt(tx.gasLimit).toString(16) : undefined,
    },
  };
}

// Cash-out quote: the reverse of quoteBridge — "send X of your ETH (ERC-20) on Immutable
// zkEVM, receive ~Y native ETH on Ethereum mainnet". The source is an ERC-20, so the
// wallet must approve the router first (see shapeExactInQuote); the tx's `value` is
// native IMX (zkEVM's gas coin) covering the cross-chain relay — the client checks the
// wallet holds it before offering the button.
async function quoteCashout(fromWei, address) {
  if (!configured()) fail('not_configured', 503);
  const { route, requestId, quoteId } = await fetchRoute(fromWei, address, NATIVE_ETH, ZK_ETH,
    { fromChain: TO_CHAIN, toChain: FROM_CHAIN });
  return shapeExactInQuote(fromWei, route, requestId, quoteId, route.transactionRequest.target);
}

// Top-up quote: the standalone "add funds" move — "send X of your native ETH on Ethereum
// mainnet, receive ~Y ETH (ERC-20) on Immutable zkEVM". Unlike quoteBridge (exact-OUTPUT,
// pinned to a checkout shortfall) the user picks the input amount. Native source → no
// approval; the amount + relay fee ride in tx.value, paid from mainnet ETH.
async function quoteTopup(fromWei, address) {
  if (!configured()) fail('not_configured', 503);
  const { route, requestId, quoteId } = await fetchRoute(fromWei, address);
  return shapeExactInQuote(fromWei, route, requestId, quoteId, null);
}

// Live status of a bridge transaction, for the in-panel tracker. Maps Squid's
// squidTransactionStatus onto our stage vocabulary; 'not_found' just means Squid
// hasn't indexed the tx yet (the caller falls back to a source-chain receipt check).
// `reverse` flips the chain pair for cash-out (zkEVM → mainnet) transactions.
// Squid's status host 429s readily (shared integrator id) — one short retry keeps a
// poll from collapsing to the receipt fallback over a transient limit.
async function getStatus({ txHash, quoteId, requestId, reverse = false }) {
  if (!configured()) fail('not_configured', 503);
  const url = new URL(SQUID_STATUS_URL);
  url.searchParams.set('transactionId', txHash);
  url.searchParams.set('fromChainId', reverse ? TO_CHAIN : FROM_CHAIN);
  url.searchParams.set('toChainId', reverse ? FROM_CHAIN : TO_CHAIN);
  if (quoteId) url.searchParams.set('quoteId', quoteId);
  if (requestId) url.searchParams.set('requestId', requestId);
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { headers: { 'x-integrator-id': INTEGRATOR_ID }, signal: AbortSignal.timeout(15000) });
    const transient = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    if (!transient || attempt >= 1) break; // 2 attempts total — this runs inside a 20s poll
    const ra = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3000) : 1500);
  }
  if (res.status === 404) return { squidStatus: 'not_found' };
  if (!res.ok) fail('unavailable', 503, `status ${res.status}`);
  const b = await res.json().catch(() => ({}));
  return {
    squidStatus: b.squidTransactionStatus || 'unknown',
    axelarUrl: b.axelarTransactionUrl || null,
    srcUrl: b.fromChain?.transactionUrl || null,
    destUrl: b.toChain?.transactionUrl || null,
  };
}

// Independent completion signal: Axelarscan's public GMP API (Squid rides Axelar's
// rails, both directions). Needed because Squid's own status indexer can lag a
// finished bridge by half an hour — a real cash-out sat on "Crossing" for 37 minutes
// while Axelar reported it executed after 72 seconds. No integrator id, no auth.
// Returns { stage, destUrl } with stage ∈ arrived/failed/needs_gas/bridging, or null
// when Axelar doesn't know the tx (yet). `reverse` only picks the destination
// explorer for the link (cash-out lands on Ethereum, funding on zkEVM).
async function getAxelarStatus(txHash, { reverse = false } = {}) {
  const res = await fetch('https://api.axelarscan.io/gmp/searchGMP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash, size: 1 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) fail('unavailable', 503, `axelar ${res.status}`);
  const d = (await res.json().catch(() => ({})))?.data?.[0];
  if (!d?.status) return null;
  const stage = d.status === 'executed' || d.status === 'express_executed' ? 'arrived'
    : d.status === 'error' ? 'failed'
    : d.status === 'insufficient_fee' ? 'needs_gas'
    : 'bridging'; // called / confirming / confirmed / approving / approved / executing
  const destTx = d.executed?.transactionHash || null;
  const destBase = reverse ? 'https://etherscan.io/tx/' : 'https://explorer.immutable.com/tx/';
  return { stage, destUrl: destTx ? destBase + destTx : null };
}

module.exports = { configured, quoteBridge, quoteCashout, quoteTopup, getStatus, getAxelarStatus, ZK_IMX, IMX_L1 };
