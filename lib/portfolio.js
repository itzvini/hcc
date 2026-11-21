// What a wallet's collection has been worth, day by day.
//
// A holder asked for it on Discord: "a full on dashboard for your HCC collection... show
// the value of the wallet over time." The value of what a wallet holds TODAY is one sum over
// the price guide. The value over time is the harder half, because it has two moving parts:
// what the market was doing each day, and what the wallet actually held that day. Pricing
// today's holdings at last March's market would draw a year of wealth for someone who bought
// last week.
//
// So this works backward. Start from what the wallet holds now, which the chain states
// outright, and undo each arrival and departure in turn: a Creature bought on the 3rd was
// not in the wallet on the 2nd; one sold on the 9th was. Nothing here reads a network. It
// is given the holdings, the moves and the market, and it does arithmetic, which is what
// lets it be tested without a wallet.

const DAY_MS = 86400000;

/**
 * The wallet's holdings on each day of a window, oldest first.
 *
 *   held      token ids in the wallet now
 *   moves     [{ ts, tokenId, dir }] with dir 'in' (arrived) or 'out' (left)
 *   weightOf  tokenId -> what that asset is worth as a multiple of the market's level, or
 *             null when it cannot be priced
 *   from, to  the window, in ms; one point a day, the last one at `to`
 *
 * Each day carries `weight` (the sum of the priced assets' multiples, so that day's value
 * is weight x the market's level that day) and `n` (how many assets were held).
 *
 * `conflicts` counts moves that contradict the holdings they were applied to: an arrival
 * of something the wallet does not hold afterwards, or a departure of something it still
 * has. A complete history produces none. Any at all means a move is missing from the list,
 * and the caller should stop calling the result exact.
 */
function holdingsByDay({ held, moves, weightOf, from, to }) {
  const state = new Set([...held].map(String));
  const weights = new Map();
  const w = id => {
    if (!weights.has(id)) {
      const v = weightOf(id);
      weights.set(id, Number.isFinite(v) && v > 0 ? v : 0);
    }
    return weights.get(id);
  };
  let weight = 0;
  for (const id of state) weight += w(id);

  // Newest first: the walk runs from today into the past.
  const sorted = moves
    .filter(m => m && Number.isFinite(m.ts) && m.ts <= to && m.tokenId != null)
    .map(m => ({ ts: m.ts, id: String(m.tokenId), dir: m.dir }))
    .sort((a, b) => b.ts - a.ts);

  let conflicts = 0, i = 0;
  const days = [];
  for (let t = to; t >= from; t -= DAY_MS) {
    // Undo everything that happened after this moment.
    while (i < sorted.length && sorted[i].ts > t) {
      // Two moves of one token in the same second (in and straight out again) arrive in no
      // order we can trust. Take first whichever of the pair the holdings allow.
      const next = sorted[i + 1];
      if (next && next.ts === sorted[i].ts && next.id === sorted[i].id && next.dir !== sorted[i].dir
          && state.has(sorted[i].id) !== (sorted[i].dir === 'in')) {
        sorted[i + 1] = sorted[i]; sorted[i] = next;
      }
      const m = sorted[i++];
      if (m.dir === 'in') {
        if (state.delete(m.id)) weight -= w(m.id); else conflicts++;
      } else if (m.dir === 'out') {
        if (state.has(m.id)) conflicts++; else { state.add(m.id); weight += w(m.id); }
      }
    }
    // Sums of floats drift; a wallet that held nothing must read as exactly nothing.
    days.push({ t, weight: state.size ? Math.max(0, weight) : 0, n: state.size });
  }
  days.reverse();
  return { days, conflicts };
}

/**
 * The market's level at a moment, read off a short list of dated readings.
 * Linear between two readings, flat beyond either end, and null only when there are none.
 * `levels` is [{ t, v }] oldest first; a reading with no value is skipped.
 */
function levelAt(levels, t) {
  let prev = null;
  for (const p of levels) {
    if (!(p.v > 0)) continue;
    if (p.t >= t) {
      if (!prev || p.t === t) return p.v;
      return prev.v + (p.v - prev.v) * ((t - prev.t) / (p.t - prev.t));
    }
    prev = p;
  }
  return prev ? prev.v : null;
}

/**
 * How far back a list of moves can be trusted. A feed read to its end covers everything.
 * One cut short by a page cap covers only as far as its oldest row, and a chart drawn past
 * that point would show holdings from before moves nobody read.
 */
function reliableSince(moves, truncated) {
  if (!truncated) return 0;
  let oldest = Infinity;
  for (const m of moves) if (Number.isFinite(m.ts) && m.ts < oldest) oldest = m.ts;
  return Number.isFinite(oldest) ? oldest : Infinity;
}

module.exports = { holdingsByDay, levelAt, reliableSince, DAY_MS };
