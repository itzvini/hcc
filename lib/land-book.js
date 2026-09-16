'use strict';

// The house LAND orderbook — listings this site holds itself, next to the ones it reads
// from OpenSea.
//
// Why it can exist at all: a LAND listing is a plain Seaport order. Measured across 248 live
// listings on 2026-09-10 (see the SIGNED_ZONE note in land-market.js), every one uses zone
// 0x0 and orderType 0, which means no marketplace's signature gates fulfilment. A signed
// order is a public, self-contained offer to sell: whoever holds it can fill it straight on
// Seaport. OpenSea's book is an index, not a gatekeeper. So is this one.
//
// Why it should exist: OpenSea will only accept an order that pays them 1%, and their
// Ethereum book refuses every dollar token (measured 2026-09-07, both order types). An
// order we keep ourselves owes the creator royalty and nothing else, and can be priced in
// USDC. Same seller, same parcel, same chain, a percent more in the seller's pocket.
//
// What this module is NOT: custody. It holds signatures, never keys and never funds. Every
// row here is public by nature — a buyer cannot fill an order they can't see in full. The
// chain remains the only authority on whether an order can settle; `status` is our reading
// of that, refreshed by sweep(), and it is checked again, fail-closed, before any buy.
//
// Depends on lib/land-market.js for all Seaport plumbing and never the other way round.
// server.js merges the two books; neither knows about the other.

const db = require('./db');
const landMarket = require('./land-market');
const stolen = require('./stolen-assets');
const marketAudit = require('./market-audit');

const {
  SEAPORT, CONDUIT, CONDUIT_KEY, ZERO_ADDR, ZERO_HASH, MAX_UINT256, LAND_CONTRACT, USDC,
  SEAPORT_TYPES, EIP712_DOMAIN_FIELDS, seaportDomain, seaportIface, auxIface, usdcIface,
  ethCall, readOwnerOf, isApproved, readCounter,
  landCurrency, landCurrencyByItem, unitsToAmt, wei2eth, joinMeta, fail,
} = landMarket.internals;

const eth = () => landMarket.internals.ethers;
const enabled = () => landMarket.bookEnabled() && !!eth();

// EIP-1271's "yes": what a contract wallet returns from isValidSignature for a good one.
const ERC1271_MAGIC = '0x1626ba7e';
const erc1271Iface = () => new (eth().Interface)(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);

// Withdrawing an order from THIS book costs no gas, so it needs its own proof that the
// caller owns the selling address. One field, the order hash, signed under the Seaport
// domain the order itself was signed under — the same shape OpenSea's cancel endpoint takes,
// for the same reason: only the offerer can produce it.
const CANCEL_TYPES = { OrderHash: [{ name: 'orderHash', type: 'bytes32' }] };

// How long a read may serve the last sweep before paying for a fresh one. Matches the
// OpenSea listings cache in server.js so the two halves of the merged book age alike.
const SWEEP_TTL_MS = 30 * 1000;

// ---------------------------------------------------------------------------------------
// Signature checking
// ---------------------------------------------------------------------------------------

/** Does anything live at this address? Only a contract can answer EIP-1271. */
async function hasCode(address) {
  try {
    const res = await fetch(landMarket.internals.ETH_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    return typeof json.result === 'string' && json.result.length > 2;
  } catch { return false; }
}

/**
 * Does `signature` really come from `offerer`, for this exact order?
 *
 * Plain wallets sign with a key we can recover the address from. Contract wallets can't be
 * recovered from at all — they answer EIP-1271 instead — and that now includes ordinary
 * accounts that have delegated their code under EIP-7702, which read as contracts. So: try
 * the free local recovery, and only ask the chain when there is actually code there to ask.
 * (Calling 1271 on a bare address doesn't just fail, it fails LOUDLY, logging a chain error
 * for what is really just a mistyped signature.) A wallet that fails both stays out.
 */
async function signerOwnsOrder(message, signature, offerer) {
  const E = eth();
  const domain = seaportDomain();
  try {
    if (E.verifyTypedData(domain, SEAPORT_TYPES, message, signature).toLowerCase() === offerer) return true;
  } catch { /* not a recoverable signature — a contract wallet still might vouch for it */ }
  if (!(await hasCode(offerer))) return false;
  try {
    const digest = E.TypedDataEncoder.hash(domain, SEAPORT_TYPES, message);
    const iface = erc1271Iface();
    const res = await ethCall(offerer, iface.encodeFunctionData('isValidSignature', [digest, signature]));
    return String(iface.decodeFunctionResult('isValidSignature', res)[0]).toLowerCase() === ERC1271_MAGIC;
  } catch { return false; } // it refused, or it isn't a 1271 wallet — either way, no
}

// ---------------------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------------------

/** Sum of every consideration amount: what the buyer pays all-in. */
function totalOf(consideration) {
  return consideration.reduce((s, c) => s + BigInt(c.startAmount || '0'), 0n);
}

const item = c => ({
  itemType: Number(c.itemType), token: String(c.token).toLowerCase(),
  identifierOrCriteria: String(c.identifierOrCriteria), startAmount: String(c.startAmount), endAmount: String(c.endAmount),
});

/**
 * Keep exactly the Seaport fields, in Seaport's own types, and nothing else.
 *
 * What arrives is a JSON object from a browser. What gets stored is what we will one day
 * hand to an encoder and a buyer's wallet, so it is rebuilt field by field here: no stray
 * keys riding along into the database, no surprise about what `parameters` contains. The
 * values themselves are unchanged — they have to be, since the signature covers them.
 */
function normalizeParameters(p) {
  return {
    offerer: String(p.offerer).toLowerCase(),
    zone: String(p.zone).toLowerCase(),
    offer: p.offer.map(o => item(o)),
    consideration: p.consideration.map(c => ({ ...item(c), recipient: String(c.recipient).toLowerCase() })),
    orderType: Number(p.orderType),
    startTime: String(p.startTime),
    endTime: String(p.endTime),
    zoneHash: String(p.zoneHash).toLowerCase(),
    salt: String(p.salt),
    conduitKey: String(p.conduitKey).toLowerCase(),
    totalOriginalConsiderationItems: Number(p.totalOriginalConsiderationItems),
  };
}

/**
 * Accept only orders our own prepareListing could have produced.
 *
 * This is deliberately tighter than "is it a valid Seaport order". The order arrives from a
 * browser, and the server that built it is the only thing standing between a seller and an
 * order that pays the royalty to someone else, or sells a parcel that isn't theirs, or
 * points at a zone we can't fill. So every field is re-derived here and compared, rather
 * than trusted: same collection, same conduit, no zone, one allowed currency throughout,
 * proceeds to the seller, and a fee schedule that matches the live one to the wei.
 */
function checkShape(p, fees) {
  const offer = Array.isArray(p?.offer) ? p.offer : [];
  const consideration = Array.isArray(p?.consideration) ? p.consideration : [];
  if (offer.length !== 1 || consideration.length < 1) return 'bad_order';
  if (String(offer[0].token || '').toLowerCase() !== LAND_CONTRACT || Number(offer[0].itemType) !== 2) return 'bad_order';
  if (String(offer[0].startAmount) !== '1' || String(offer[0].endAmount) !== '1') return 'bad_order';
  // Zone 0 / orderType 0 is what makes a house order fillable at all. Anything restricted
  // needs a zone signature we have no way to issue, so it would sit here unsellable.
  if (String(p.zone || '').toLowerCase() !== ZERO_ADDR || Number(p.orderType) !== 0) return 'bad_order';
  if (String(p.zoneHash || '').toLowerCase() !== ZERO_HASH) return 'bad_order';
  // The conduit the seller approved. A different one (or none) would need a second approval
  // the sell flow never asked for, so the order would revert on the buyer instead.
  if (String(p.conduitKey || '').toLowerCase() !== CONDUIT_KEY.toLowerCase()) return 'bad_order';
  if (Number(p.totalOriginalConsiderationItems) !== consideration.length) return 'bad_order';

  const cur = landCurrencyByItem(consideration[0]?.itemType, consideration[0]?.token);
  if (!cur) return 'bad_currency';
  if (!consideration.every(c => Number(c.itemType) === cur.itemType
    && String(c.token || '').toLowerCase() === cur.token
    && String(c.startAmount) === String(c.endAmount))) return 'bad_order';

  const offerer = String(p.offerer || '').toLowerCase();
  if (String(consideration[0].recipient || '').toLowerCase() !== offerer) return 'bad_order';

  const price = totalOf(consideration);
  if (price <= 0n || price % 10000n !== 0n) return 'bad_price'; // the rounding every fee split relies on

  // Re-derive the fee items from the live schedule. Order matters (proceeds, then fees in
  // schedule order) because that is how prepareListing lays them out.
  const expected = fees.map(f => ({ amount: (price * BigInt(f.bps)) / 10000n, recipient: f.recipient }));
  if (consideration.length !== expected.length + 1) return 'bad_fees';
  for (let i = 0; i < expected.length; i++) {
    const item = consideration[i + 1];
    if (BigInt(item.startAmount) !== expected[i].amount) return 'bad_fees';
    if (String(item.recipient || '').toLowerCase() !== expected[i].recipient) return 'bad_fees';
  }
  const proceeds = price - expected.reduce((s, e) => s + e.amount, 0n);
  if (BigInt(consideration[0].startAmount) !== proceeds || proceeds <= 0n) return 'bad_fees';

  return null;
}

/**
 * Put a signed listing into the book.
 *
 * Runs the shape guard, proves the signature belongs to the offerer, then asks the chain
 * the three questions that decide whether the order can settle at all (does the seller
 * still own the parcel, is the conduit approved, is the counter current). All of it before
 * a single row is written, because a book full of orders that revert is worse than no book.
 */
async function ingest({ orderParameters: raw, signature, counter: signedCounter }) {
  if (!enabled()) fail('disabled', 503);
  if (!landMarket.sellEnabled()) fail('disabled', 503);
  const sig = String(signature || '');
  if (!/^0x[0-9a-f]{60,2600}$/i.test(sig)) fail('bad_signature', 400);
  if (!raw || !Array.isArray(raw.offer) || !Array.isArray(raw.consideration)) fail('bad_order', 400);

  let p;
  try { p = normalizeParameters(raw); }
  catch { fail('bad_order', 400); }

  const fees = (await landMarket.getFees()).filter(f => !f.required);
  const shapeErr = checkShape(p, fees);
  if (shapeErr) fail(shapeErr, 400);

  const offerer = p.offerer;
  const tokenId = String(p.offer[0].identifierOrCriteria);
  if (stolen.isBlocked({ tokenId, wallet: offerer })) fail('blocked_stolen', 451, 'stolen treasury parcel — refusing to book listing');

  const now = Math.floor(Date.now() / 1000);
  const endTime = Number(p.endTime);
  if (!Number.isFinite(endTime) || endTime <= now) fail('expired', 400);
  // A listing that outlives its own signature's usefulness is just clutter. Our sell flow
  // caps duration at 30 days; allow a day of slack for clock drift and nothing more.
  if (endTime > now + 31 * 86400) fail('bad_order', 400);

  const [owner, approved, chainCounter] = await Promise.all([
    readOwnerOf(tokenId), isApproved(offerer), readCounter(offerer),
  ]);
  if (owner !== offerer) fail('not_owner', 400);
  if (!approved) fail('not_approved', 400);

  // The signed payload is OrderComponents: the same fields, carrying the counter in place of
  // totalOriginalConsiderationItems. The seller's client echoes back the counter it signed
  // under, which needs no trust — get it wrong and the signature simply doesn't verify. It
  // buys a straight answer ("your order is stale") instead of a misleading one about the
  // signature, in the one case that actually happens: a counter bumped mid-flow.
  const { totalOriginalConsiderationItems, ...rest } = p;
  const counter = String(signedCounter ?? chainCounter);
  if (counter !== String(chainCounter)) fail('stale_counter', 409);
  const message = { ...rest, counter };
  const orderHash = eth().TypedDataEncoder.hashStruct('OrderComponents', SEAPORT_TYPES, message).toLowerCase();

  if (!(await signerOwnsOrder(message, sig, offerer))) fail('bad_signature', 400);

  const cur = landCurrencyByItem(p.consideration[0].itemType, p.consideration[0].token);
  const price = totalOf(p.consideration);
  const proceeds = BigInt(p.consideration[0].startAmount);

  // Re-listing the same parcel replaces the seller's earlier price rather than stacking a
  // second offer beside it. That is what "edit price" means to a seller, and leaving both
  // live would let a buyer take the stale one.
  const mine = await db.getLandOrdersByOfferer(offerer);
  for (const old of mine) {
    if (old.token_id === tokenId && old.order_hash !== orderHash) {
      await db.closeLandOrder(old.order_hash, 'cancelled', 'relisted');
    }
  }

  await db.saveLandOrder({
    orderHash, offerer, tokenId, currency: cur.code,
    priceUnits: price.toString(), proceedsUnits: proceeds.toString(),
    startTime: Number(p.startTime), endTime, counter,
    parameters: p,
    signature: sig,
  });
  invalidate();
  return { orderHash, status: 'created', source: 'book' };
}

/**
 * Retire an order, and say so in the trail.
 *
 * This is the one outcome the marketplace genuinely OBSERVES rather than infers. Everywhere
 * else we record intent — we hand out calldata and never see what the wallet does with it —
 * but a close is us reading the chain and finding the order can no longer settle. In
 * particular `owner_changed` on a live listing is, nearly always, the sale itself: the parcel
 * moved while an order to sell it was open.
 *
 * Reasons the member asked for (`seller`, `relisted`) already have their own row from the
 * route that handled the request, so they are not written twice. What lands here is the
 * chain moving under an order on its own.
 */
async function closeOrder(row, status, reason) {
  await db.closeLandOrder(row.order_hash, status, reason);
  if (reason !== 'seller' && reason !== 'relisted') {
    marketAudit.record('book_closed', {
      coll: 'land', book: 'book', wallet: row.offerer, tokenId: String(row.token_id),
      orderHash: row.order_hash, priceUnits: String(row.price_units), currency: row.currency,
      status, reason,
    });
  }
}

// ---------------------------------------------------------------------------------------
// Validity sweep
// ---------------------------------------------------------------------------------------

/**
 * Ask the chain which open orders can still settle, and close the ones that can't.
 *
 * Four things kill a listing and none of them tell us they happened: the parcel moved, the
 * conduit approval was pulled, the seller bumped their Seaport counter (which cancels all
 * their orders at once), or the clock ran out. OpenSea runs this for its own book; for ours
 * it is this function, and without it the grid would advertise parcels that revert on the
 * buyer's gas.
 *
 * Reads are grouped: one ownerOf per parcel, one counter and one approval per seller, not
 * per order. A read that FAILS leaves its order alone — a flaky node is not evidence that a
 * listing is dead, and the buy path checks again before anyone spends anything.
 */
async function sweep() {
  if (!enabled()) return { checked: 0, closed: 0 };
  const rows = await db.getOpenLandOrders();
  if (!rows.length) return { checked: 0, closed: 0 };

  // The two verdicts that need no network call. Settled and written before anything else,
  // so the read that follows a sweep can't still see an order this pass just closed.
  const now = Math.floor(Date.now() / 1000);
  const live = [];
  let closed = 0;
  for (const r of rows) {
    const local = Number(r.end_time) <= now ? 'expired'
      : stolen.isBlocked({ tokenId: r.token_id, wallet: r.offerer }) ? 'blocked'
      : null;
    if (local) { await closeOrder(r, 'invalid', local); closed++; continue; }
    live.push(r);
  }

  const owners = new Map();  // tokenId -> owner | undefined when the read failed
  const sellers = new Map(); // offerer -> { counter, approved } | undefined likewise
  await Promise.all([
    ...[...new Set(live.map(r => r.token_id))].map(async id => {
      const o = await readOwnerOf(id).catch(() => null);
      if (o) owners.set(id, o);
    }),
    ...[...new Set(live.map(r => r.offerer))].map(async addr => {
      try {
        const [counter, approved] = await Promise.all([readCounter(addr), isApproved(addr)]);
        sellers.set(addr, { counter: String(counter), approved });
      } catch { /* leave unknown; the order keeps its last good verdict */ }
    }),
  ]);

  const healthy = [];
  for (const r of live) {
    const owner = owners.get(r.token_id);
    const seller = sellers.get(r.offerer);
    let verdict = null;
    if (owner && owner !== r.offerer) verdict = ['invalid', 'owner_changed'];
    else if (seller && !seller.approved) verdict = ['invalid', 'approval_revoked'];
    else if (seller && seller.counter !== String(r.counter)) verdict = ['cancelled', 'counter_bumped'];
    if (verdict) { await closeOrder(r, verdict[0], verdict[1]); closed++; continue; }
    // Only count it as checked when both reads actually answered.
    if (owner && seller) healthy.push(r.order_hash);
  }
  await db.touchLandOrders(healthy);
  if (closed) invalidate();
  return { checked: live.length, closed };
}

// ---------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------

let cache = { rows: null, at: 0, inFlight: null };
const invalidate = () => { cache = { rows: null, at: 0, inFlight: null }; };

/** One stored row as a browse/listing row, shaped exactly like an OpenSea one. */
function shapeRow(r) {
  const cur = landCurrency(r.currency) || landCurrency('eth');
  const amt = unitsToAmt(r.price_units, cur.decimals);
  return {
    orderHash: r.order_hash,
    protocolAddress: SEAPORT,
    source: 'book',
    tokenId: String(r.token_id),
    seller: r.offerer,
    currency: cur.code,
    priceAmt: amt,
    priceEth: cur.code === 'eth' ? amt : null,   // USDC rows get their ETH-equivalent upstream
    priceUsdc: cur.code === 'usdc' ? amt : null,
    listedAt: Number(r.start_time) > 0 ? Number(r.start_time) * 1000 : 0,
    expiresAt: Number(r.end_time) || null,
    name: `Highrise LAND #${r.token_id}`,
    image: null,
  };
}

/**
 * Every live house listing, cheapest first, one row per parcel.
 *
 * Sweeps first when the cached answer has aged out, so what comes back has been checked
 * against the chain within the last half-minute. A sweep failure is not fatal: the stored
 * rows are still the best answer available, and every one of them was valid when written.
 */
async function openListings() {
  if (!enabled()) return { items: [] };
  if (cache.rows && Date.now() - cache.at < SWEEP_TTL_MS) return { items: cache.rows };
  if (cache.inFlight) return { items: await cache.inFlight };

  cache.inFlight = (async () => {
    await sweep().catch(err => console.error('LAND book sweep failed:', err.message));
    const rows = (await db.getOpenLandOrders()).map(shapeRow);
    // A parcel shows its cheapest order. Same rule as the OpenSea side, including the
    // cross-currency tie-break: prefer ETH so the dedupe needs no exchange rate here.
    const best = new Map();
    for (const it of rows) {
      const prev = best.get(it.tokenId);
      if (!prev) { best.set(it.tokenId, it); continue; }
      const better = it.currency === prev.currency ? it.priceAmt < prev.priceAmt : it.currency === 'eth';
      if (better) best.set(it.tokenId, it);
    }
    const items = [...best.values()];
    await joinMeta(items).catch(() => items); // names and art are a nicety, never a blocker
    items.sort((a, b) => (a.currency === b.currency ? a.priceAmt - b.priceAmt : a.currency === 'eth' ? -1 : 1));
    cache = { rows: items, at: Date.now(), inFlight: null };
    return items;
  })();
  return { items: await cache.inFlight };
}

/** The live house book as Map<tokenId, row>, for merging into the parcel browse. */
async function listingsByToken() {
  const { items } = await openListings();
  return new Map(items.map(it => [String(it.tokenId), it]));
}

/** Is this hash one of ours? The buy and cancel routes ask before choosing a book. */
async function getOrder(orderHash) {
  if (!enabled()) return null;
  return db.getLandOrder(orderHash);
}

/** One seller's live house listings, in the shape "your listings" already renders. */
async function myListings(address) {
  if (!enabled()) return { items: [] };
  const rows = (await db.getLandOrdersByOfferer(address)).map(shapeRow);
  const items = rows.map(r => ({
    ...r,
    listingId: r.orderHash,
    // Free to withdraw here, but "free" means something weaker than it does on an OpenSea
    // offer: this de-indexes the order, it does not revoke the signature. `cancelKind` is
    // what the client reads to say so plainly instead of promising a cancellation we can't
    // enforce. The paid on-chain route is always offered alongside.
    freeCancel: true,
    cancelKind: 'soft',
    priceUsd: r.currency === 'usdc' ? r.priceAmt : null,
    totalAmt: r.priceAmt,
  }));
  await joinMeta(items).catch(() => items);
  return { items };
}

// ---------------------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------------------

/**
 * The unsigned transaction that fills a house order.
 *
 * Unlike the OpenSea path there is no remote endpoint to ask for calldata: the order IS the
 * calldata, and we hold it. Everything the chain will check gets checked here first, and
 * fail-closed this time — a buy is about to spend real money on mainnet, so an RPC that
 * won't answer means "not now", never "probably fine".
 *
 * Nothing binds this transaction to `taker`. A zone-0 Seaport order is fillable by anyone,
 * which is equally true of every LAND listing on OpenSea today; the buyer sends it from
 * their own wallet and receives the parcel. `taker` is used for the currency approval and
 * as the recipient of nothing else.
 */
async function prepareBuy({ orderHash, taker }) {
  if (!enabled()) fail('disabled', 503);
  const row = await db.getLandOrder(orderHash);
  if (!row) fail('not_found', 404);
  if (row.status !== 'open') fail('not_active', 409);
  if (String(row.offerer).toLowerCase() === String(taker).toLowerCase()) fail('own_listing', 400);
  if (stolen.isBlocked({ tokenId: row.token_id, wallet: row.offerer })) fail('blocked_stolen', 451, 'stolen treasury parcel — refusing to broker');

  const now = Math.floor(Date.now() / 1000);
  if (Number(row.end_time) <= now) { await closeOrder(row, 'invalid', 'expired'); invalidate(); fail('not_active', 409); }

  // Fail-closed: any of these throwing means we could not confirm the order is fillable,
  // and the buyer should not learn that from a reverted transaction.
  const [owner, approved, counter] = await Promise.all([
    readOwnerOf(row.token_id), isApproved(row.offerer), readCounter(row.offerer),
  ]);
  const dead = owner !== String(row.offerer).toLowerCase() ? ['invalid', 'owner_changed']
    : !approved ? ['invalid', 'approval_revoked']
    : String(counter) !== String(row.counter) ? ['cancelled', 'counter_bumped']
    : null;
  if (dead) { await closeOrder(row, dead[0], dead[1]); invalidate(); fail('not_active', 409); }

  const p = row.parameters;
  const cur = landCurrencyByItem(p.consideration[0].itemType, p.consideration[0].token);
  if (!cur) fail('bad_order', 409);
  const total = totalOf(p.consideration);

  let data;
  try {
    data = seaportIface().encodeFunctionData('fulfillOrder', [{ parameters: p, signature: row.signature }, CONDUIT_KEY]);
  } catch (err) {
    fail('unavailable', 503, `house fulfillOrder encode failed: ${err.message}`);
  }

  const transactions = [];
  // An ERC-20 price is pulled through the same conduit the OpenSea path uses, so a buyer who
  // has ever bought there already has the approval and sees one transaction, not two.
  if (cur.itemType === 1) {
    const iface = usdcIface();
    let allowance = 0n;
    try {
      const res = await ethCall(cur.token, iface.encodeFunctionData('allowance', [taker, CONDUIT]));
      allowance = BigInt(iface.decodeFunctionResult('allowance', res)[0]);
    } catch { allowance = 0n; } // unreadable → prepend it; a redundant approval is a no-op
    if (allowance < total) {
      transactions.push({ purpose: 'APPROVAL', to: cur.token, data: iface.encodeFunctionData('approve', [CONDUIT, MAX_UINT256]), value: '0x0' });
    }
  }
  transactions.push({
    purpose: 'FULFILL_ORDER',
    to: SEAPORT,
    data,
    value: cur.itemType === 0 ? '0x' + total.toString(16) : '0x0',
  });
  return { transactions, chainId: '0x1', source: 'book' };
}

// ---------------------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------------------

/**
 * How the seller can withdraw a house order.
 *
 * 'soft' costs nothing and takes it off this site at once, which is enough in practice
 * because this site is the only place it was ever published. It is NOT a revocation: the
 * signature stays valid on Seaport, so anyone who kept a copy could still fill it. Sellers
 * are told exactly that, and the on-chain route is always there as the real thing.
 *
 * The same distinction exists on OpenSea's own zone-0 listings — cancelling one there also
 * only de-indexes it (see cancelMode in land-market.js). This is the honest version of it.
 */
async function prepareCancel({ orderHash, maker, mode }) {
  if (!enabled()) fail('disabled', 503);
  const row = await db.getLandOrder(orderHash);
  if (!row) fail('not_found', 404);
  if (String(row.offerer).toLowerCase() !== String(maker).toLowerCase()) fail('not_owner', 400);

  if (mode !== 'onchain') {
    return {
      mode: 'soft',
      source: 'book',
      typedData: {
        types: { EIP712Domain: EIP712_DOMAIN_FIELDS, ...CANCEL_TYPES },
        domain: seaportDomain(), primaryType: 'OrderHash',
        message: { orderHash: row.order_hash },
      },
    };
  }

  const p = row.parameters;
  const orderComponents = {
    offerer: p.offerer, zone: p.zone, offer: p.offer, consideration: p.consideration,
    orderType: p.orderType, startTime: p.startTime, endTime: p.endTime,
    zoneHash: p.zoneHash, salt: p.salt, conduitKey: p.conduitKey, counter: String(row.counter),
  };
  let data;
  try {
    data = seaportIface().encodeFunctionData('cancel', [[orderComponents]]);
  } catch (err) {
    fail('unavailable', 503, `house cancel encode failed: ${err.message}`);
  }
  return { mode: 'onchain', source: 'book', transactions: [{ purpose: 'CANCEL', to: SEAPORT, data, value: '0x0' }], chainId: '0x1' };
}

/** Take a soft-cancelled order out of the book, on the seller's own signature. */
async function submitCancel({ orderHash, maker, signature }) {
  if (!enabled()) fail('disabled', 503);
  const row = await db.getLandOrder(orderHash);
  if (!row) fail('not_found', 404);
  const addr = String(maker).toLowerCase();
  if (String(row.offerer).toLowerCase() !== addr) fail('not_owner', 400);
  if (row.status !== 'open') return { cancelled: true, source: 'book' }; // already gone; nothing to argue about

  const message = { orderHash: row.order_hash };
  const E = eth();
  let ok = false;
  try {
    ok = E.verifyTypedData(seaportDomain(), CANCEL_TYPES, message, signature).toLowerCase() === addr;
  } catch { ok = false; }
  if (!ok && await hasCode(addr)) {
    // Contract wallets again: they can't be recovered from, so ask them.
    try {
      const digest = E.TypedDataEncoder.hash(seaportDomain(), CANCEL_TYPES, message);
      const iface = erc1271Iface();
      const res = await ethCall(addr, iface.encodeFunctionData('isValidSignature', [digest, signature]));
      ok = String(iface.decodeFunctionResult('isValidSignature', res)[0]).toLowerCase() === ERC1271_MAGIC;
    } catch { ok = false; }
  }
  if (!ok) fail('bad_signature', 400);

  await db.closeLandOrder(orderHash, 'cancelled', 'seller');
  invalidate();
  return { cancelled: true, source: 'book' };
}

/**
 * After an on-chain cancel or a fill, stop advertising the order straight away rather than
 * waiting for the next sweep to notice. Ownership is re-checked, so this can't be used to
 * knock someone else's listing out of the book.
 */
async function noteClosed({ orderHash, maker, status }) {
  const row = await db.getLandOrder(orderHash);
  if (!row || String(row.offerer).toLowerCase() !== String(maker).toLowerCase()) return false;
  await db.closeLandOrder(orderHash, status === 'filled' ? 'filled' : 'cancelled', 'reported');
  invalidate();
  return true;
}

// Background sweep. The read path sweeps on demand too, but a book nobody is looking at
// still has to stop advertising parcels that have moved — a stale row is what turns into a
// stranger's wasted gas.
let timer = null;
function startSweeper(everyMs = 2 * 60 * 1000) {
  if (timer || !enabled()) return;
  timer = setInterval(() => { sweep().catch(err => console.error('LAND book sweep failed:', err.message)); }, everyMs);
  if (timer.unref) timer.unref();
}

module.exports = {
  enabled, ingest, sweep, openListings, listingsByToken, getOrder, myListings,
  prepareBuy, prepareCancel, submitCancel, noteClosed, startSweeper,
};
