// LAND market via OpenSea — server-side only (the API key never reaches a browser,
// CSP stays connect-src 'self'). LAND is the OTHER half of the marketplace's world:
// it lives on Ethereum mainnet and trades on OpenSea's Seaport, so nothing from the
// Immutable orderbook stack applies. Same trust model though: this module only READS
// public data and PREPARES unsigned transactions; the user's wallet signs everything.
//
// Verified empirically (2026-06-10) before this was written:
// - /listings/collection/{slug}/all returns live Seaport orders (paginated).
// - /listings/fulfillment_data returns the unsigned fulfillAdvancedOrder call for a
//   SPECIFIC fulfiller (OpenSea's signed zone binds the tx to that address — calldata
//   sent from anyone else reverts, so prepared buys can't be hijacked).
// - input_data arrives as named structs; encoding requires a NAMED Seaport ABI
//   (canonical unnamed signatures fail in ethers) — validated via eth_estimateGas
//   from the bound fulfiller (~223k gas on a real listing).

const LAND_CONTRACT = '0x8bf3a40ea2337e6e4f6e540680ea6390cb3b4e11';
const LAND_SLUG = 'highrise-land';
const OS_BASE = 'https://api.opensea.io/api/v2';
const OS_KEY = (process.env.OPENSEA_API_KEY || '').trim();

let Interface = null;
try { ({ Interface } = require('ethers')); } catch { /* transitive dep — present in practice */ }

const configured = () => Boolean(OS_KEY && Interface);

// Named Seaport fragments — names are REQUIRED so ethers can map OpenSea's structured
// input_data objects; the canonical (unnamed) signature cannot encode them.
const OFFER_ITEM = '(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)';
const CONSIDERATION_ITEM = '(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)';
const ORDER_PARAMETERS = `(address offerer, address zone, ${OFFER_ITEM}[] offer, ${CONSIDERATION_ITEM}[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems)`;
const ADVANCED_ORDER = `(${ORDER_PARAMETERS} parameters, uint120 numerator, uint120 denominator, bytes signature, bytes extraData)`;
const CRITERIA_RESOLVER = '(uint256 orderIndex, uint8 side, uint256 index, uint256 identifier, bytes32[] criteriaProof)';
const FULFILLMENT_COMPONENT = '(uint256 orderIndex, uint256 itemIndex)';
const seaportIface = () => new Interface([
  `function fulfillAdvancedOrder(${ADVANCED_ORDER} advancedOrder, ${CRITERIA_RESOLVER}[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool fulfilled)`,
  `function fulfillAvailableAdvancedOrders(${ADVANCED_ORDER}[] advancedOrders, ${CRITERIA_RESOLVER}[] criteriaResolvers, ${FULFILLMENT_COMPONENT}[][] offerFulfillments, ${FULFILLMENT_COMPONENT}[][] considerationFulfillments, bytes32 fulfillerConduitKey, address recipient, uint256 maximumFulfilled) payable returns (bool[] availableOrders, ((uint256 amount, address token, uint8 itemType, uint256 identifier, address recipient) item, address offerer, bytes32 conduitKey)[] executions)`,
]);

const fail = (code, statusCode, logMsg) => {
  if (logMsg) console.error(`LAND market [${code}]:`, logMsg);
  throw Object.assign(new Error(code), { code, statusCode });
};

async function osFetch(path, init = {}) {
  if (!configured()) fail('not_configured', 503);
  const res = await fetch(`${OS_BASE}${path}`, {
    ...init,
    headers: { Accept: 'application/json', 'X-API-KEY': OS_KEY, ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429) fail('rate_limited', 429, `OpenSea 429 for ${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // OpenSea reports compliance-blocked accounts with this phrasing.
    if (/can not perform trading/i.test(body)) fail('blocked_account', 400);
    if (res.status === 404 || /not found/i.test(body)) fail('not_found', 404, `OpenSea 404 for ${path}`);
    fail('unavailable', 503, `OpenSea ${res.status} for ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

const wei2eth = w => Math.round(Number(BigInt(w)) / 1e14) / 1e4;

// Parcel coordinates drive the slime-pet render (lib/land-pets.js): prefer the
// "Land X"/"Land Y" traits, fall back to the "LAND (x, y)" name OpenSea mints.
function landCoords(name, traits) {
  const find = key => traits?.find(t => t.trait === key)?.value;
  let x = Number(find('Land X')), y = Number(find('Land Y'));
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    const m = /\((-?\d{1,4}),\s*(-?\d{1,4})\)/.exec(name || '');
    if (!m) return null;
    x = Number(m[1]); y = Number(m[2]);
  }
  return { x, y };
}

// LAND art barely changes — cache metadata forever (bounded).
const metaCache = new Map(); // tokenId -> {name, image, traits, coords}
function cacheMeta(tokenId, meta) {
  if (metaCache.size > 5000) metaCache.clear();
  metaCache.set(String(tokenId), meta);
  return meta;
}

async function fetchLandMeta(tokenId) {
  const hit = metaCache.get(String(tokenId));
  if (hit) return hit;
  try {
    const { nft } = await osFetch(`/chain/ethereum/contract/${LAND_CONTRACT}/nfts/${tokenId}`);
    const name = nft?.name || `Highrise LAND #${tokenId}`;
    const traits = Array.isArray(nft?.traits)
      ? nft.traits.map(t => ({ trait: t.trait_type, value: t.value })).filter(t => t.trait && t.value != null)
      : [];
    return cacheMeta(tokenId, {
      name,
      image: nft?.display_image_url || nft?.image_url || null,
      traits,
      coords: landCoords(name, traits),
    });
  } catch { return null; } // one bad token must not sink a page
}

// Limited-concurrency metadata join — OpenSea rate-limits bursts on one key.
async function joinMeta(items) {
  const queue = [...items];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const it = queue.shift();
      const meta = await fetchLandMeta(it.tokenId);
      if (meta) { it.name = meta.name; it.image = meta.image; it.coords = meta.coords; }
    }
  });
  await Promise.all(workers);
  return items;
}

// A page of active LAND listings, cheapest data OpenSea returns (their /all endpoint
// is creation-ordered; we sort the page by price for a sane default view).
async function listListings(cursor) {
  const qs = new URLSearchParams({ limit: '24' });
  if (cursor) qs.set('next', cursor);
  const body = await osFetch(`/listings/collection/${LAND_SLUG}/all?${qs}`);
  const items = (body.listings || []).map(l => {
    const p = l.protocol_data?.parameters;
    const tokenId = p?.offer?.[0]?.identifierOrCriteria;
    const priceWei = l.price?.current?.value;
    if (!tokenId || !priceWei || l.price?.current?.currency !== 'ETH') return null;
    return {
      orderHash: l.order_hash,
      protocolAddress: l.protocol_address,
      tokenId: String(tokenId),
      seller: (p?.offerer || '').toLowerCase() || null,
      priceEth: wei2eth(priceWei), // OpenSea's current.value is the all-in buyer price
      name: `Highrise LAND #${tokenId}`,
      image: null,
    };
  }).filter(Boolean);
  // A token can carry several active listings — show only its cheapest.
  const bestByToken = new Map();
  for (const it of items) {
    const prev = bestByToken.get(it.tokenId);
    if (!prev || it.priceEth < prev.priceEth) bestByToken.set(it.tokenId, it);
  }
  const deduped = [...bestByToken.values()];
  await joinMeta(deduped);
  deduped.sort((a, b) => a.priceEth - b.priceEth);
  return { items: deduped, nextCursor: body.next || null };
}

async function getToken(tokenId) {
  const meta = await fetchLandMeta(tokenId);
  if (!meta) fail('not_found', 404);
  return { tokenId: String(tokenId), ...meta };
}

// LAND owned by one wallet. Estate-locked parcels are owned by the estate contract
// on-chain, so they are naturally absent here — exactly right for trading surfaces.
async function ownedLand(address) {
  const items = [];
  let next = null, pages = 0;
  do {
    const qs = new URLSearchParams({ collection: LAND_SLUG, limit: '50' });
    if (next) qs.set('next', next);
    const body = await osFetch(`/chain/ethereum/account/${address}/nfts?${qs}`);
    for (const n of (body.nfts || [])) {
      const name = n.name || `Highrise LAND #${n.identifier}`;
      items.push({
        tokenId: String(n.identifier),
        name,
        image: n.display_image_url || n.image_url || null,
        coords: landCoords(name, null), // account listings carry no traits — name only
      });
    }
    next = body.next || null;
    pages++;
  } while (next && pages < 4);
  return { items, truncated: Boolean(next) };
}

// Unsigned buy transaction for a listing, bound by OpenSea's signed zone to `taker`
// (sent from any other address it reverts — verified). Native ETH: value carries the
// full price, no approval transaction exists on this path.
async function prepareBuy({ orderHash, protocolAddress, taker }) {
  const body = await osFetch('/listings/fulfillment_data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      listing: { hash: orderHash, chain: 'ethereum', protocol_address: protocolAddress },
      fulfiller: { address: taker },
    }),
  });
  const tx = body.fulfillment_data?.transaction;
  if (!tx?.function || !tx.input_data) fail('not_active', 409, 'no fulfillment transaction in response');
  const fnName = tx.function.slice(0, tx.function.indexOf('('));
  let data;
  try {
    data = seaportIface().encodeFunctionData(fnName, Object.values(tx.input_data));
  } catch (err) {
    fail('unavailable', 503, `encode failed for ${fnName}: ${err.message}`);
  }
  return {
    transactions: [{
      purpose: 'FULFILL_ORDER',
      to: tx.to,
      data,
      value: '0x' + BigInt(tx.value || 0).toString(16),
    }],
    chainId: '0x1', // Ethereum mainnet — the client must switch networks for LAND
  };
}

module.exports = { configured, listListings, getToken, ownedLand, prepareBuy, LAND_CONTRACT };
