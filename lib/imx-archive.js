// Pre-migration Creature sales — the Immutable X (StarkEx) years, 2021 to 2025.
//
// Creatures lived on StarkEx until the July 2025 move to Immutable zkEVM, and roughly
// four fifths of every Creature ever sold was sold back there. `api.x.immutable.com` was
// switched off with the rollup, so the official record of those trades is gone; what
// survives is immutascan.io's own archived index, which is what the community already
// uses to look a pre-migration Creature up. This reads the same GraphQL endpoint its site
// reads, with the public client key shipped in its JS bundle.
//
// The archive is CLOSED — StarkEx is sunset, so no thirteen-thousand-and-first trade will
// ever appear. That shapes everything here: one full sweep (~70 pages, under a minute),
// warmed in the background at boot, then held for the life of the process. A failed sweep
// costs the pre-migration half of the sales history and nothing else: the caller merges
// whatever this returns with the live zkEVM feed and carries on.
//
// Token ids survived the migration 1:1, so an archive row joins the Creature catalogue by
// the same id as a zkEVM one — same name, same art, same traits, same rarity rank.

const ARCHIVE_URL = 'https://qbolqfa7fnctxo3ooupoqrslem.appsync-api.us-east-2.amazonaws.com/graphql';
const ARCHIVE_KEY = 'da2-ceptv3udhzfmbpxr3eqisx3coe';
// The Creature collection's StarkEx contract. Its zkEVM successor is 0xCf44b1cB…77cdA.
const STARKEX_CREATURE_CONTRACT = '0xb0e827c9ab5e68d243f707f832b756981987f704';

const PAGE_SIZE = 200;
const MAX_PAGES = 200;              // 13.4k trades = ~68 pages; this is a runaway guard
const METRICS_LIMIT = 5000;         // the daily series is ~1.3k rows and getMetricsAll takes no cursor
const RETRY_MS = 10 * 60 * 1000;    // a failed sweep cools off before anyone triggers another
const REQ_TIMEOUT_MS = 20000;

const TRADES_QUERY = `query($a:String!,$l:Int,$n:String){
  latestTrades(address:$a, limit:$l, nextToken:$n){
    nextToken
    items {
      txn_id
      txn_time
      transfers { from_address to_address token { type quantity usd_rate token_address token_id } }
    }
  }
}`;

// The archive's own daily roll-up of the collection. `type` is the date — one row per day,
// plus a single 'total' row of all-time figures. `floor_price_eth` is a LISTING floor, not
// the day's cheapest sale: on 1.3% of days the day's average sale came in under it, which
// a sale-derived number could never do. Rows only exist for days that saw a trade.
const METRICS_QUERY = `query($a:String!,$l:Int){
  getMetricsAll(address:$a, limit:$l){
    items { type floor_price_eth floor_price_usd owner_count trade_count trade_volume_eth trade_volume_usd }
  }
}`;

async function gql(query, variables) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(ARCHIVE_URL, {
      method: 'POST',
      headers: { 'x-api-key': ARCHIVE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`immutascan ${res.status}`);
    const body = await res.json();
    if (body.errors?.length) throw new Error(`immutascan: ${body.errors[0].message}`);
    return body.data ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One archived trade → the sale row the sales history speaks, or null if it isn't one we
 * can price honestly.
 *
 * Every trade is exactly two transfers: the Creature one way, the money the other. The
 * money leg carries `usd_rate`, the token's USD price AT THE MOMENT OF THE TRADE — better
 * than anything we could reconstruct, since our own daily ETH/USD table only reaches back
 * a year and would value a 2022 sale at this year's rate.
 *
 * A handful of trades (~0.6%) settled in IMX or mainnet USDC instead. Their dollar value
 * is knowable, but their ETH-equivalent — the number the list sorts and the chart plots —
 * would need an ETH/USD rate for a date we don't have one for. A price-discovery tool is
 * better missing eighty sales than quoting eighty wrong ones, so those are dropped.
 */
function shapeArchiveTrade(tr) {
  const at = Number(tr.txn_time);
  if (!Number.isFinite(at) || at <= 0) return null;
  let nft = null, money = null;
  for (const leg of tr.transfers || []) {
    const tok = leg.token || {};
    if (tok.type === 'ERC721') nft = { ...leg, tok };
    else money = { ...leg, tok };
  }
  if (!nft || !money) return null;
  if (String(nft.tok.token_address).toLowerCase() !== STARKEX_CREATURE_CONTRACT) return null;
  if (money.tok.type !== 'ETH') return null;
  const priceEth = Number(money.tok.quantity);
  const tokenId = nft.tok.token_id;
  if (!tokenId || !Number.isFinite(priceEth) || priceEth <= 0) return null;
  const usdRate = Number(money.tok.usd_rate);
  return {
    tokenId: String(tokenId),
    currency: 'eth',
    priceAmt: priceEth,
    priceEth,
    // The rate at trade time, so the shaper values this sale in the dollars it was
    // actually worth rather than clamping to the edge of our 365-day table.
    usdRate: Number.isFinite(usdRate) && usdRate > 0 ? usdRate : null,
    at: new Date(at).toISOString(),
    // StarkEx had no per-trade hash — a rollup transaction id is the whole address of a
    // trade there, and immutascan is where it resolves. `era` sends the client's links
    // to the archive instead of the zkEVM explorer.
    era: 'imx',
    tx: null,
    txnId: tr.txn_id != null ? String(tr.txn_id) : null,
    buyer: (nft.to_address || '').toLowerCase() || null,
    seller: (nft.from_address || '').toLowerCase() || null,
  };
}

async function sweepArchive() {
  const sales = [];
  let cursor = null, pages = 0, skipped = 0;
  do {
    const page = (await gql(TRADES_QUERY, { a: STARKEX_CREATURE_CONTRACT, l: PAGE_SIZE, n: cursor }))?.latestTrades;
    if (!page) break;
    for (const tr of page.items || []) {
      const row = shapeArchiveTrade(tr);
      if (row) sales.push(row); else skipped++;
    }
    cursor = page.nextToken || null;
  } while (cursor && ++pages < MAX_PAGES);
  console.log(`IMX archive: ${sales.length} pre-migration Creature sales (${skipped} unpriceable) in ${pages + 1} pages`);
  return sales;
}

/**
 * One archived daily roll-up → the day the market chart speaks, or null for the 'total'
 * summary row and for days the archive left blank.
 *
 * ETH is kept at full precision — a floor of 0.049 ETH loses too much at four places. The
 * archive's dollar figure comes along for reference, but the chart converts the ETH floor
 * itself: the two floors can come off listings priced in different coins.
 */
function shapeArchiveDay(row) {
  const date = String(row.type || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const num = v => (v != null && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const floorEth = num(row.floor_price_eth);
  const floorUsd = num(row.floor_price_usd);
  if (floorEth == null && floorUsd == null) return null; // a day with no floor is nothing to plot
  return {
    date,
    floorEth: Math.round(floorEth * 1e6) / 1e6,
    floorUsd: floorUsd != null ? Math.round(floorUsd) : null,
    owners: num(row.owner_count),
    trades: num(row.trade_count),
    volEth: num(row.trade_volume_eth),
    volUsd: num(row.trade_volume_usd),
  };
}

async function sweepMetrics() {
  const data = await gql(METRICS_QUERY, { a: STARKEX_CREATURE_CONTRACT, l: METRICS_LIMIT });
  const days = [];
  for (const row of data?.getMetricsAll?.items || []) {
    const day = shapeArchiveDay(row);
    if (day) days.push(day);
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`IMX archive: ${days.length} pre-migration daily floors (${days[0]?.date} → ${days[days.length - 1]?.date})`);
  return days;
}

/**
 * One sweep of a closed archive, memoized. A success is held for the life of the process
 * (nothing new can ever land in it); a failure cools off before the next caller retries,
 * and resolves to [] so the caller carries on with the live feed alone.
 */
function onceEver(label, sweep) {
  const box = { data: null, inFlight: null, failedAt: 0 };
  const get = () => {
    if (box.data) return Promise.resolve(box.data);
    if (!box.inFlight && Date.now() - box.failedAt > RETRY_MS) {
      box.inFlight = sweep()
        .then(rows => { box.data = rows; return rows; })
        .catch(err => {
          box.failedAt = Date.now();
          console.error(`IMX archive ${label} sweep failed:`, err.message);
          return [];
        })
        .finally(() => { box.inFlight = null; });
    }
    return box.inFlight || Promise.resolve([]);
  };
  get.ready = () => box.data != null;
  get.value = () => box.data;
  return get;
}

/**
 * Every pre-migration Creature sale, newest first. Resolves to [] rather than throwing
 * when the archive is unreachable — the sales history is built on the live feed and this
 * only ever extends it backwards.
 */
const getArchiveSales = onceEver('sales', () =>
  sweepArchive().then(rows => rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))));

/**
 * The pre-migration daily floor, oldest first: [{ date, floorEth, floorUsd, owners,
 * trades, volEth, volUsd }]. This is the only surviving record of what a Creature cost
 * to buy on any given day between November 2021 and the July 2025 migration — the
 * StarkEx orderbook went off with the rollup. Only `floorEth`/`floorUsd` are used today;
 * the rest is the archive's row as it stands.
 */
const getArchiveMetrics = onceEver('daily metrics', sweepMetrics);

let ratesByDate = null;

/**
 * The ETH/USD rate on every day the old market traded, as Map('YYYY-MM-DD' -> rate).
 *
 * Each archived trade carries the rate that applied the moment it settled, so the day's
 * median across its trades is a market rate from the same source that priced the trades
 * themselves. (The daily metrics row looks like it could give one too — divide its floor in
 * dollars by its floor in ETH — but it can't: the two floors can come from listings in
 * different currencies, and a fifth of days land more than 10% off the real rate.)
 *
 * SYNCHRONOUS, and empty unless the sales sweep has already landed. It does not start one:
 * the callers are request paths that must not stall for a minute, and by now the rates it
 * would give are written down elsewhere — asking for them is no reason to read a
 * seventy-page archive again. Whoever wants the sweep asks for it directly.
 */
function archiveRates() {
  if (ratesByDate) return ratesByDate;
  const sales = getArchiveSales.value();
  if (!sales) return new Map();
  const byDate = new Map();
  for (const s of sales) {
    if (!s.usdRate) continue;
    const date = s.at.slice(0, 10);
    const seen = byDate.get(date);
    if (seen) seen.push(s.usdRate); else byDate.set(date, [s.usdRate]);
  }
  ratesByDate = new Map();
  for (const [date, rates] of byDate) {
    rates.sort((a, b) => a - b);
    ratesByDate.set(date, rates[Math.floor(rates.length / 2)]); // median shrugs off an odd trade
  }
  return ratesByDate;
}

module.exports = { getArchiveSales, getArchiveMetrics, archiveRates, STARKEX_CREATURE_CONTRACT };
