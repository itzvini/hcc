// Marketplace orderbook wrapper — the ONLY place the @imtbl/orderbook SDK is touched.
// Server-side preparation only: we build unsigned transactions / typed-data here and the
// user's wallet signs them in the browser (non-custodial; no keys, no funds, no signing
// on this side). 0% marketplace fee: takerFees is always [] (protocol/royalty fees are
// embedded in the order itself by Immutable).
//
// Loaded defensively: if the SDK can't load (broken optional dep, install issue), the
// marketplace browse/transfer features still work and buy/sell answer 503 — the same
// degrade-don't-crash pattern as lib/dev-login.

let orderbook = null;
let loadError = null;
try {
  const { Orderbook } = require('@imtbl/orderbook');
  const { Environment } = require('@imtbl/config');
  orderbook = new Orderbook({ baseConfig: { environment: Environment.PRODUCTION } });
} catch (err) {
  loadError = err;
  console.error('Orderbook SDK unavailable — buy/sell disabled:', err.message);
}

const available = () => !!orderbook;

// Stable error codes the client translates; raw SDK/Seaport messages never reach users.
// statusCode rides along so the route layer can answer 4xx vs 503 correctly.
function mapError(err) {
  const msg = (err?.message || '').toLowerCase();
  if (/same as maker/.test(msg))                       return { code: 'own_listing', statusCode: 400 };
  // Seaport-js phrasing when the TAKER lacks balances — for bid-accepts this means the
  // seller is missing the small ERC-20 fee float (royalties route through their wallet).
  if (/fulfiller does not have/.test(msg))             return { code: 'taker_float', statusCode: 400 };
  if (/not found|404/.test(msg))                       return { code: 'not_found', statusCode: 404 };
  if (/not active|inactive|filled|cancelled|expired/.test(msg)) return { code: 'not_active', statusCode: 409 };
  // Make-offer (bid) shortfall: the SDK rejects a bid the maker can't currently back with
  // "The offerer does not have the amount needed to create or fulfill." — distinct from the
  // taker phrasing above. Neither contains "balance"/"insufficient", so it has to be matched
  // explicitly or it collapses to a misleading "unavailable". (Was the cause of "Buying is
  // temporarily unavailable" on a perfectly healthy orderbook — see the make-offer flow.)
  if (/balance|insufficient|offerer does not have|amount needed to create or fulfill/.test(msg))
    return { code: 'insufficient', statusCode: 400 };
  return { code: 'unavailable', statusCode: 503 };
}

// Serialize one ethers v6 TransactionRequest into the minimal JSON a wallet needs.
// BigInt-safe: value arrives as bigint from the SDK.
function serializeTx(purpose, tx) {
  return {
    purpose, // 'APPROVAL' | 'FULFILL_ORDER' | 'CANCEL'
    to: tx.to,
    data: tx.data,
    value: tx.value != null ? '0x' + BigInt(tx.value).toString(16) : '0x0',
  };
}

// Recursively convert BigInt values (ethers v6 emits them) into decimal strings so
// the result can pass through JSON.stringify and back without loss.
function jsonSafe(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = jsonSafe(val);
    return out;
  }
  return v;
}

// Build the exact eth_signTypedData_v4 payload from an SDK SignableAction message.
// MetaMask requires the EIP712Domain type listed explicitly and a primaryType; the SDK
// gives domain/types/value only, so both are derived here (server-side, so the client
// stays dumb and the payload is consistent).
function toTypedDataV4({ domain, types, value }) {
  const DOMAIN_FIELDS = [
    ['name', 'string'], ['version', 'string'], ['chainId', 'uint256'],
    ['verifyingContract', 'address'], ['salt', 'bytes32'],
  ];
  const eip712Domain = DOMAIN_FIELDS
    .filter(([f]) => domain[f] != null)
    .map(([name, type]) => ({ name, type }));
  // primaryType = the struct no other struct references (e.g. Seaport's OrderComponents).
  const referenced = new Set();
  for (const fields of Object.values(types)) {
    for (const f of fields) referenced.add(String(f.type).replace(/\[\]$/, ''));
  }
  const primaryType = Object.keys(types).find(k => !referenced.has(k)) || Object.keys(types)[0];
  return jsonSafe({
    types: { EIP712Domain: eip712Domain, ...types },
    domain,
    primaryType,
    message: value,
  });
}

// Serialize an SDK action list for the client: TRANSACTION actions become minimal
// unsigned txs, SIGNABLE actions become ready-to-sign eth_signTypedData_v4 payloads.
async function serializeActions(actions) {
  const out = [];
  for (const action of (actions || [])) {
    if (action.type === 'TRANSACTION') {
      out.push({ type: 'TRANSACTION', ...serializeTx(action.purpose, await action.buildTransaction()) });
    } else if (action.type === 'SIGNABLE') {
      out.push({ type: 'SIGNABLE', purpose: action.purpose, typedData: toTypedDataV4(action.message) });
    }
  }
  // Any APPROVAL must be mined before the rest is acted on — keep it first.
  out.sort((a, b) => (a.purpose === 'APPROVAL' ? -1 : 0) - (b.purpose === 'APPROVAL' ? -1 : 0));
  return out;
}

const fail = (context, err) => {
  const mapped = mapError(err);
  console.error(`${context} failed [${mapped.code}]:`, err.message);
  throw Object.assign(new Error(mapped.code), mapped);
};

// --- Transient-failure retry -------------------------------------------------
// The Immutable orderbook API has brief 5xx / network blips (seen in prod logs as
// "Generic Error" and "Internal Server Error (500)"). Reads and order PREPARATION
// are side-effect-free, so a short jittered retry makes those blips invisible to
// the user instead of surfacing as a generic "unavailable". Order SUBMISSION
// (createListing / createBid / cancelOrders) is deliberately NOT retried here — it
// mutates orderbook state, so those callers keep single-shot semantics.
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Worth retrying = a repeat might fix it: a 5xx from the API, or a transport error
// that never received an HTTP status. A 4xx is the caller's fault and is rethrown
// immediately, so a real "not found / not active / insufficient" answer is fast.
function isTransient(err) {
  const status = Number(err?.status ?? err?.statusCode);
  if (Number.isFinite(status)) return status >= 500;
  const msg = (err?.message || '').toLowerCase();
  return /\(5\d\d\)|internal server error|bad gateway|gateway timeout|service unavailable|generic error|fetch failed|network error|timed? ?out|timeout|socket hang up|econnreset|econnrefused|etimedout|enotfound|eai_again|request aborted/.test(msg);
}

// Up to `tries` attempts with exponential backoff + jitter (~0.3s, ~0.6s). Total
// added latency before giving up stays under ~1s, so a successful retry is
// imperceptible while a genuine outage still fails reasonably quickly.
async function withRetry(label, fn, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries || !isTransient(err)) throw err;
      const delay = 300 * 2 ** (attempt - 1) + Math.floor(Math.random() * 120);
      console.warn(`${label}: transient error (attempt ${attempt}/${tries}), retrying in ${delay}ms — ${err.message}`);
      await sleep(delay);
    }
  }
}

// Unsigned transactions to fulfil any open order: usually [APPROVAL?, FULFILL_ORDER].
// Covers buying a listing AND accepting a bid (where the taker is the NFT holder —
// `tokenId` selects which token is sold into a collection bid). The approval must be
// mined before the fulfilment is sent, or the fulfilment reverts — the client sequences.
async function prepareFulfill(orderId, takerAddress, tokenId, amountToFill) {
  if (!orderbook) throw Object.assign(new Error('orderbook unavailable'), { code: 'unavailable', statusCode: 503 });
  let res;
  try {
    res = await withRetry(`prepareFulfill(${orderId})`, () => orderbook.fulfillOrder(orderId, takerAddress, [],
      amountToFill != null ? String(amountToFill) : undefined,
      tokenId != null ? String(tokenId) : undefined));
  } catch (err) { fail(`prepareFulfill(${orderId})`, err); }

  // The SDK returns [APPROVAL?…, FULFILL_ORDER]. The FULFILL_ORDER is an on-chain tx whose
  // gas can only be estimated AFTER its approvals are mined: both buying a listing and
  // accepting a bid pull ERC-20 from the taker (a bid-accept routes the creator royalty
  // through the SELLER's wallet), so a first-timer has an ERC-20 approval still pending and
  // estimateGas on the fulfilment reverts with "ERC20: insufficient allowance". (That
  // revert previously escaped here unmapped → a bare "unavailable" with no log — the exact
  // stuck state first-time sellers hit.) So: build and return the approval(s) now; if any
  // approval is pending, DEFER the fulfilment and tell the client to re-prepare once the
  // approvals confirm — on that pass the allowance is set and the fulfilment builds cleanly.
  try {
    const actions = res.actions || [];
    const hasPendingApproval = actions.some(a => a.type === 'TRANSACTION' && a.purpose === 'APPROVAL');
    const transactions = [];
    for (const a of actions) {
      if (a.type !== 'TRANSACTION') continue; // fulfilment is on-chain; there is no SIGNABLE leg
      if (a.purpose === 'APPROVAL') transactions.push(serializeTx('APPROVAL', await a.buildTransaction()));
      else if (!hasPendingApproval) transactions.push(serializeTx(a.purpose, await a.buildTransaction()));
      // else: fulfilment deferred until the approvals above are mined (client re-prepares)
    }
    if (!transactions.length && !hasPendingApproval) {
      // No approval AND no fulfilment built — a degraded/empty SDK response. Surface it as
      // a retryable error (logged) instead of returning nothing silently.
      console.error(`prepareFulfill(${orderId}): orderbook returned no transactions`);
      throw Object.assign(new Error('no transactions'), { code: 'unavailable', statusCode: 503 });
    }
    return { transactions, needsRefulfill: hasPendingApproval, expiration: res.expiration || null };
  } catch (err) {
    if (err.statusCode) throw err;           // our own coded throw — pass through unchanged
    fail(`prepareFulfill(${orderId})`, err); // map + LOG anything buildTransaction threw (was silent before)
  }
}
const prepareBuy = (listingId, takerAddress) => prepareFulfill(listingId, takerAddress, undefined, undefined);

// Prepare a listing: returns the one-time NFT approval tx (if needed), the typed data
// the seller signs (gasless), and the order components+hash to send back on create.
async function prepareSell({ makerAddress, sellContract, tokenId, buyContract, amountWei }) {
  if (!orderbook) throw Object.assign(new Error('orderbook unavailable'), { code: 'unavailable', statusCode: 503 });
  let res;
  try {
    res = await withRetry(`prepareSell(${tokenId})`, () => orderbook.prepareListing({
      makerAddress,
      sell: { type: 'ERC721', contractAddress: sellContract, tokenId: String(tokenId) },
      buy:  { type: 'ERC20', contractAddress: buyContract, amount: String(amountWei) },
    }));
  } catch (err) { fail(`prepareSell(${tokenId})`, err); }
  return {
    actions: await serializeActions(res.actions),
    orderComponents: jsonSafe(res.orderComponents),
    orderHash: res.orderHash,
  };
}

// Submit the signed listing to the orderbook (gasless). 0% fee: makerFees [].
async function createSell({ orderComponents, orderHash, signature }) {
  if (!orderbook) throw Object.assign(new Error('orderbook unavailable'), { code: 'unavailable', statusCode: 503 });
  try {
    const res = await orderbook.createListing({ orderComponents, orderHash, orderSignature: signature, makerFees: [] });
    return { listingId: res.result?.id || null, status: res.result?.status?.name || null };
  } catch (err) { fail(`createSell(${orderHash})`, err); }
}

// Prepare an offer (bid). With a tokenId it's a bid on that specific NFT; without, a
// COLLECTION bid — a standing offer any holder can sell into ("floor offer"). The maker
// sells ERC20 (the chosen currency — zkEVM ETH or USDC) and buys the NFT, so the prep may
// include a one-time ERC20 approval tx plus the gasless typed-data to sign — mirrors the sell
// flow. `sellContract` is the currency's token; `ethContract` is accepted for back-compat.
async function prepareOffer({ makerAddress, sellContract, ethContract, amountWei, nftContract, tokenId }) {
  if (!orderbook) throw Object.assign(new Error('orderbook unavailable'), { code: 'unavailable', statusCode: 503 });
  const sell = { type: 'ERC20', contractAddress: sellContract || ethContract, amount: String(amountWei) };
  let res;
  try {
    res = await withRetry(`prepareOffer(${tokenId ?? 'collection'})`, () => tokenId != null
      ? orderbook.prepareBid({ makerAddress, sell, buy: { type: 'ERC721', contractAddress: nftContract, tokenId: String(tokenId) } })
      : orderbook.prepareCollectionBid({ makerAddress, sell, buy: { type: 'ERC721_COLLECTION', contractAddress: nftContract, amount: '1' } }));
  } catch (err) { fail(`prepareOffer(${tokenId ?? 'collection'})`, err); }
  return {
    actions: await serializeActions(res.actions),
    orderComponents: jsonSafe(res.orderComponents),
    orderHash: res.orderHash,
  };
}

// Submit the signed offer to the orderbook (gasless). 0% fee: makerFees [].
async function createOffer({ orderComponents, orderHash, signature, collection }) {
  if (!orderbook) throw Object.assign(new Error('orderbook unavailable'), { code: 'unavailable', statusCode: 503 });
  const params = { orderComponents, orderHash, orderSignature: signature, makerFees: [] };
  try {
    const res = collection ? await orderbook.createCollectionBid(params) : await orderbook.createBid(params);
    return { offerId: res.result?.id || null, status: res.result?.status?.name || null };
  } catch (err) { fail(`createOffer(${orderHash})`, err); }
}

// Shape one SDK bid into the public offer row the client renders. Collection bids can
// want MULTIPLE Creatures (buy[0].amount = units) with sell.amount as the TOTAL — all
// prices here are normalised PER CREATURE (a 0.1458-for-2 bid is a 0.0729 offer), which
// is also how a single accept (amountToFill 1) pays out. Gross = what the bidder pays
// per unit; net = what the seller receives after the order's embedded fees. `cur`
// ({ code, decimals }) makes the amount math currency-aware (ETH 18-dec, USDC 6-dec);
// priceEth/netEth stay ETH-native for ETH offers (back-compat) and are null for USDC —
// the ETH-equivalent + USD estimate are filled in server-side where the rate lives.
function shapeOffer(b, collection, cur = { code: 'eth', decimals: 18 }) {
  const grossTotal = BigInt(b.sell?.[0]?.amount || '0');
  const feesTotal = (b.fees || []).reduce((s, f) => s + (f.amount ? BigInt(f.amount) : 0n), 0n);
  const units = collection ? Math.max(1, Number(b.buy?.[0]?.amount || 1) || 1) : 1;
  const uB = BigInt(units);
  const gross = grossTotal / uB;
  const net = (grossTotal - feesTotal) / uB;
  const toAmt = w => Math.round(Number(w) / 10 ** cur.decimals * 1e6) / 1e6;
  const priceAmt = toAmt(gross);
  const netAmt = toAmt(net);
  return {
    offerId: b.id,
    collection: !!collection,
    units, // how many Creatures the bid still wants in total
    from: b.accountAddress || null,
    tokenId: collection ? null : (b.buy?.[0]?.tokenId ?? null),
    currency: cur.code,
    priceAmt, netAmt,           // native amount (ETH or USDC), per unit
    priceEth: cur.code === 'eth' ? priceAmt : null,
    netEth: cur.code === 'eth' ? netAmt : null,
    grossWei: gross.toString(), // per-unit smallest-units — what ONE accept requires the bidder to fund
    expiresAt: b.endAt || null,
  };
}

// Active offers on one specific token (best first), in ONE currency (sellContract).
async function listTokenOffers({ nftContract, sellContract, ethContract, currency, tokenId }) {
  if (!orderbook) throw Object.assign(new Error('orderbook unavailable'), { code: 'unavailable', statusCode: 503 });
  const cur = currency || { code: 'eth', decimals: 18 };
  try {
    const res = await withRetry(`listTokenOffers(${tokenId})`, () => orderbook.listBids({
      status: 'ACTIVE', buyItemContractAddress: nftContract, sellItemContractAddress: sellContract || ethContract,
      buyItemTokenId: String(tokenId), sortBy: 'sell_item_amount', sortDirection: 'desc', pageSize: 10,
    }));
    return { offers: (res.result || []).map(b => shapeOffer(b, false, cur)) };
  } catch (err) { fail(`listTokenOffers(${tokenId})`, err); }
}

// Active collection-wide offers (best first) — the standing "floor offers" — in ONE currency.
async function listCollectionOffers({ nftContract, sellContract, ethContract, currency, accountAddress }) {
  if (!orderbook) throw Object.assign(new Error('orderbook unavailable'), { code: 'unavailable', statusCode: 503 });
  const cur = currency || { code: 'eth', decimals: 18 };
  try {
    const res = await withRetry('listCollectionOffers', () => orderbook.listCollectionBids({
      status: 'ACTIVE', buyItemContractAddress: nftContract, sellItemContractAddress: sellContract || ethContract,
      ...(accountAddress ? { accountAddress } : {}),
      sortBy: 'sell_item_amount', sortDirection: 'desc', pageSize: 10,
    }));
    return { offers: (res.result || []).map(b => shapeOffer(b, true, cur)) };
  } catch (err) { fail('listCollectionOffers', err); }
}

// One account's own active offers (specific bids + collection bids) for management/cancel, one currency.
async function listMyOffers({ nftContract, sellContract, ethContract, currency, accountAddress }) {
  if (!orderbook) throw Object.assign(new Error('orderbook unavailable'), { code: 'unavailable', statusCode: 503 });
  const cur = currency || { code: 'eth', decimals: 18 };
  const sc = sellContract || ethContract;
  try {
    const [bids, coll] = await Promise.all([
      withRetry('listMyOffers.bids', () => orderbook.listBids({ status: 'ACTIVE', buyItemContractAddress: nftContract, sellItemContractAddress: sc, accountAddress, sortBy: 'created_at', sortDirection: 'desc', pageSize: 25 })),
      withRetry('listMyOffers.coll', () => orderbook.listCollectionBids({ status: 'ACTIVE', buyItemContractAddress: nftContract, sellItemContractAddress: sc, accountAddress, sortBy: 'created_at', sortDirection: 'desc', pageSize: 25 })),
    ]);
    return {
      offers: [
        ...(bids.result || []).map(b => shapeOffer(b, false, cur)),
        ...(coll.result || []).map(b => shapeOffer(b, true, cur)),
      ],
    };
  } catch (err) { fail('listMyOffers', err); }
}

// Gasless cancellation: typed data the seller signs, then submit with the signature.
async function prepareCancel(orderIds, accountAddress) {
  if (!orderbook) throw Object.assign(new Error('orderbook unavailable'), { code: 'unavailable', statusCode: 503 });
  try {
    const res = await withRetry(`prepareCancel(${orderIds.join(',')})`, () => orderbook.prepareOrderCancellations(orderIds));
    return { typedData: toTypedDataV4(res.signableAction.message) };
  } catch (err) { fail(`prepareCancel(${orderIds.join(',')})`, err); }
}

async function submitCancel(orderIds, accountAddress, signature) {
  if (!orderbook) throw Object.assign(new Error('orderbook unavailable'), { code: 'unavailable', statusCode: 503 });
  try {
    const res = await orderbook.cancelOrders(orderIds, accountAddress, signature);
    return {
      cancelled: res.result?.successful_cancellations || [],
      pending: res.result?.pending_cancellations || [],
      failed: (res.result?.failed_cancellations || []).map(f => f.order || f),
    };
  } catch (err) { fail(`submitCancel(${orderIds.join(',')})`, err); }
}

module.exports = {
  available, loadError,
  prepareBuy, prepareFulfill, prepareSell, createSell, prepareCancel, submitCancel,
  prepareOffer, createOffer, listTokenOffers, listCollectionOffers, listMyOffers,
};
