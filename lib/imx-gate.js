// Every request this server makes to Immutable passes through here.
//
// Immutable rate-limits per IP. In production that is not a limit per member — it is one
// limit for the whole club at once, because every request leaves from this one server. A
// single member opening the marketplace already fires a burst: the browse feed, their
// holdings, their listings, the collection offer book, their own offers (four upstream
// reads on its own), and the open token's offers. Nothing coordinated them, so they went
// out together, Immutable refused the overflow with a 429, and the SDK reports a 429 as
// "Generic Error" — which the offers routes then had to serve as 503. Two members doing
// that at the same time made it worse, and nothing in the code got slower or noisier to
// say why.
//
// So: one queue in front of Immutable for the whole process.
//
//   - a token bucket, so we never exceed the documented rate
//   - a ceiling on how many are in flight at once
//   - two lanes, so a background sweep can never delay something a member is waiting on
//   - coalescing, so N identical reads arriving together cost one upstream call
//
// A burst now waits a few hundred milliseconds instead of failing. That is the trade this
// module exists to make: slower is recoverable, a 503 in the offers panel is not.

// Immutable's published ceiling is 5 requests a second per IP. We sit just under it: the
// bucket is not the only thing on this IP (health checks, retries already in flight, a
// second process during a deploy), and the cost of being wrong is the failure above.
const RATE_PER_SEC   = Number(process.env.IMX_RATE_PER_SEC   || 4);
const BURST          = Number(process.env.IMX_BURST          || 4);
const MAX_CONCURRENT = Number(process.env.IMX_MAX_CONCURRENT || 4);

// A request that has waited longer than this has lost its reader: the page has moved on,
// or the browser gave up. Failing it releases the slot for work someone is still waiting
// for, rather than spending the budget on an answer nobody will read.
const MAX_WAIT_MS = Number(process.env.IMX_MAX_WAIT_MS || 20000);

const LANES = { interactive: 0, background: 1 };

let tokens = BURST;
let lastRefill = Date.now();
let inFlight = 0;
let timer = null;
let pausedUntil = 0; // set when Immutable tells us we are out of budget
const queues = [[], []];
const shared = new Map(); // coalescing key -> in-flight promise

const stats = { started: 0, done: 0, failed: 0, coalesced: 0, expired: 0, maxQueue: 0, waitMsTotal: 0, rateLimited: 0 };

/**
 * Immutable answers every REST call with its own view of our budget:
 *
 *   x-ratelimit-limit: 5, 5;w=1      five per one-second window
 *   x-ratelimit-remaining: 4
 *   x-ratelimit-reset: 1             seconds until it refills
 *
 * Believe it over our own arithmetic. Our token bucket is an estimate made from one
 * process; the header is the truth, and it accounts for everything else sharing this IP —
 * a second instance mid-deploy, a health check, a retry we had forgotten about.
 *
 * Two things come from it: stop early when the budget is spent, and — because the whole
 * process queues here — stop for EVERYONE rather than letting the next twenty calls
 * discover the same closed window one 429 at a time.
 */
function noteHeaders(headers) {
  if (!headers) return;
  const remaining = Number(headers.get?.('x-ratelimit-remaining'));
  const reset = Number(headers.get?.('x-ratelimit-reset'));
  if (Number.isFinite(remaining) && remaining <= 0) {
    const waitMs = Math.min(5000, Math.max(250, (Number.isFinite(reset) ? reset : 1) * 1000));
    pausedUntil = Math.max(pausedUntil, Date.now() + waitMs);
    tokens = 0;
  }
}

/** A 429 got through anyway. Hold the whole queue, not just the caller that found out. */
function noteRateLimited(retryAfterSec) {
  stats.rateLimited++;
  const waitMs = Math.min(10000, Math.max(1000, (Number(retryAfterSec) || 1) * 1000));
  pausedUntil = Math.max(pausedUntil, Date.now() + waitMs);
  tokens = 0;
  // Worth saying out loud: with the gate in front of every call this should not happen, so
  // when it does the pacing needs looking at (IMX_RATE_PER_SEC) or something else is on
  // this IP. Silence here is what made the original 503s so hard to place.
  console.warn(`imx gate: rate limited by Immutable — holding all requests for ${waitMs}ms (${stats.rateLimited} so far, ${queued()} queued)`);
}

function refill() {
  const now = Date.now();
  if (now > lastRefill) {
    tokens = Math.min(BURST, tokens + ((now - lastRefill) / 1000) * RATE_PER_SEC);
    lastRefill = now;
  }
}

function queued() { return queues[0].length + queues[1].length; }

// How long a background job may be overtaken before it stops yielding. Without this the
// background lane starves outright: four members loading the marketplace at once produce a
// continuous stream of interactive reads, and the whole-book bid sweep sat behind them until
// it was dropped for waiting too long — so the dashboard's offer book never filled in. The
// lanes are meant to order work, not to decide that some of it never runs.
const PROMOTE_AFTER_MS = Number(process.env.IMX_PROMOTE_AFTER_MS || 3000);

/**
 * The next job: interactive first, because that lane is someone watching a spinner — unless
 * a background job has been passed over for long enough, in which case it goes now.
 */
function takeNext() {
  const bg = queues[1][0];
  if (bg && Date.now() - bg.queuedAt >= PROMOTE_AFTER_MS) return queues[1].shift();
  for (const q of queues) if (q.length) return q.shift();
  return null;
}

function pump() {
  refill();
  // Held back by Immutable's own accounting — wake when the window it named has passed.
  if (Date.now() < pausedUntil) {
    if (queued() && !timer) {
      timer = setTimeout(() => { timer = null; pump(); }, Math.max(15, pausedUntil - Date.now()));
      if (timer.unref) timer.unref();
    }
    return;
  }
  while (inFlight < MAX_CONCURRENT && tokens >= 1 && queued()) {
    const job = takeNext();
    // Drop anything nobody is waiting for any more before spending a token on it.
    if (Date.now() - job.queuedAt > MAX_WAIT_MS) {
      stats.expired++;
      console.warn(`imx gate: dropped a request after ${MAX_WAIT_MS}ms in the queue (${queued()} still waiting)`);
      job.reject(Object.assign(new Error('imx gate: timed out waiting for a slot'), { code: 'rate_limited', statusCode: 503 }));
      continue;
    }
    tokens -= 1;
    inFlight++;
    stats.started++;
    stats.waitMsTotal += Date.now() - job.queuedAt;
    Promise.resolve()
      .then(job.fn)
      .then(v => { stats.done++; job.resolve(v); }, e => { stats.failed++; job.reject(e); })
      .finally(() => { inFlight--; pump(); });
  }
  // Nothing runnable but work waiting: wake up when the next token lands. One timer for
  // the whole queue, so a hundred queued jobs don't become a hundred timers.
  if (queued() && !timer) {
    const needed = Math.max(0, 1 - tokens);
    const waitMs = Math.max(15, Math.ceil((needed / RATE_PER_SEC) * 1000));
    timer = setTimeout(() => { timer = null; pump(); }, waitMs);
    if (timer.unref) timer.unref(); // never hold the process open
  }
}

/**
 * Run one Immutable call under the gate.
 *
 * `fn` must be a LEAF call — a single request. Never wrap something that itself calls the
 * gate: the inner call would queue behind a slot the outer one is holding, and with the
 * concurrency ceiling full that is a deadlock.
 *
 * @param {() => Promise<any>} fn      the request to make
 * @param {object}  [opts]
 * @param {'interactive'|'background'} [opts.lane]  background yields to anything a member
 *        is waiting on (the whole-book bid sweep, warm-up jobs, archive backfills)
 */
function run(fn, opts = {}) {
  const lane = LANES[opts.lane] ?? LANES.interactive;
  return new Promise((resolve, reject) => {
    queues[lane].push({ fn, resolve, reject, queuedAt: Date.now() });
    stats.maxQueue = Math.max(stats.maxQueue, queued());
    pump();
  });
}

/**
 * Run under the gate, sharing one call between every caller that asks for the same `key`
 * while it is in flight. The marketplace asks the same questions from several places at
 * once — two panels wanting the collection offer book, a repaint racing its own load — and
 * without this each one spends budget on an identical answer.
 *
 * Only for reads. The result is shared, so a caller must not mutate it.
 */
function runShared(key, fn, opts = {}) {
  const hit = shared.get(key);
  if (hit) { stats.coalesced++; return hit; }
  const p = run(fn, opts).finally(() => { shared.delete(key); });
  shared.set(key, p);
  return p;
}

/** Counters for the health/debug surface. Cheap, and the only way to see the queue working. */
function snapshot() {
  return {
    ...stats,
    inFlight,
    queued: queued(),
    queuedInteractive: queues[0].length,
    queuedBackground: queues[1].length,
    tokens: Math.round(tokens * 100) / 100,
    pausedForMs: Math.max(0, pausedUntil - Date.now()),
    ratePerSec: RATE_PER_SEC,
    maxConcurrent: MAX_CONCURRENT,
    avgWaitMs: stats.started ? Math.round(stats.waitMsTotal / stats.started) : 0,
  };
}

module.exports = { run, runShared, snapshot, noteHeaders, noteRateLimited, RATE_PER_SEC, MAX_CONCURRENT };
