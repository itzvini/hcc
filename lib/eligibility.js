'use strict';

// Council eligibility rules, derived from the public Council page.
//
//  • Membership: any HCC holder — Creature or LAND.
//  • Voting: hold ≥1 HCC asset continuously for 3 months. Continuous-holding
//    cannot be proven from a single on-chain snapshot, so we report the current
//    holding and flag the 3-month requirement as verified separately at the
//    snapshot. `holdsNow` is the part we can confirm here.
//  • Running (self-nomination) is gated by holding bracket at the snapshot:
//      - 1 asset      → 2 seats   (open to any holder)
//      - 2–4 assets   → 1 seat
//      - 5+ assets    → 1 seat
//    Brackets gate running, not voting — every eligible holder votes on all 4 races.

const BRACKETS = [
  { id: 'whale',  min: 5,   max: Infinity, seats: 1 },
  { id: 'mid',    min: 2,   max: 4,        seats: 1 },
  { id: 'single', min: 1,   max: 1,        seats: 2 },
];

// Returns the running bracket for a given combined asset count, or null if the
// holder owns nothing.
function bracketFor(totalCount) {
  return BRACKETS.find(b => totalCount >= b.min && totalCount <= b.max) || null;
}

function computeEligibility({ creatureCount = 0, landCount = 0 }) {
  const totalCount = creatureCount + landCount;
  const holdsNow = totalCount > 0;
  const bracket = bracketFor(totalCount);

  return {
    creatureCount,
    landCount,
    totalCount,
    isMember: holdsNow,
    // Confirmed from the live snapshot; the continuous-3-month rule is enforced
    // separately against the candidacy-window snapshot.
    holdsNow,
    canVotePendingHoldTime: holdsNow,
    canRun: !!bracket,
    bracket: bracket ? bracket.id : null,
    bracketSeats: bracket ? bracket.seats : 0,
  };
}

module.exports = { BRACKETS, bracketFor, computeEligibility };
