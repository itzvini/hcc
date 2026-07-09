'use strict';

// Official community polls — club-wide votes the Player Council sends to every
// holder when a call is too big for seven seats (e.g. the Gen 2 ship order).
//
// Definitions are checked into the repo so every poll is reviewable in git
// history; open/close moments are env-driven so a poll can be scheduled or
// closed on announcement day without a redeploy (same ops pattern as the
// election's APPLICATIONS_OPEN / VOTING_OPEN flags).
//
// Copy (title, description, option labels) lives in the locales under
// `polls.p.<i18nKey>.*` — the API sends only ids and keys, never display text,
// so every language renders from its own dictionary.
//
// Lifecycle (always derived from the clock, never stored):
//   upcoming → open (opensAt reached) → closed (closesAt reached)
//   opensAt null  → announced but not scheduled yet ("opens soon")
//   closesAt null → open-ended once open (set the env to schedule the close)
//
// Results are published ONLY once a poll closes — publishing a running tally
// would invite pile-ons (the same rule the election follows).

function envDate(name) {
  const t = Date.parse(process.env[name] || '');
  return Number.isFinite(t) ? t : null;
}

const POLLS = [
  // Gen 2 ship order — commissioned by the Player Council at its first sitting
  // (July 2026). The Council declined to pick the order itself and sent it to an
  // official HCC-wide vote: pets first, creatures first, or everything together.
  {
    id: 'gen2-ship-order',
    i18nKey: 'gen2order',
    options: ['pets', 'creatures', 'together'],
    opensAt: envDate('POLL_GEN2_OPENS'),
    closesAt: envDate('POLL_GEN2_CLOSES'),
  },
];

function pollStatus(p, now = Date.now()) {
  if (!p.opensAt || now < p.opensAt) return 'upcoming';
  if (p.closesAt && now >= p.closesAt) return 'closed';
  return 'open';
}

module.exports = { POLLS, pollStatus };
