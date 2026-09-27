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
// Reference pins (optional): `refs` maps an option to Pinterest pin ids, shown in
// a sheet of Pinterest's own embeds. Ids are strings (they overflow a JS number),
// and only digit-only ids reach the page, so the embed URL can't carry markup.
//
// Lifecycle (always derived from the clock, never stored):
//   upcoming → open (opensAt reached) → closed (closesAt reached)
//   opensAt null  → announced but not scheduled yet ("opens soon")
//   closesAt null → open-ended once open (set the env to schedule the close)
//
// A poll can also carry a default schedule in code. The env still overrides it,
// but a same-day poll then goes live with the deploy, not with a variable change.
//
// Results are published ONLY once a poll closes — publishing a running tally
// would invite pile-ons (the same rule the election follows).

function envDate(name, fallback) {
  const t = Date.parse(process.env[name] || fallback || '');
  return Number.isFinite(t) ? t : null;
}

const POLLS = [
  // Halloween 2026 grab theme. Holders pitched themes in creature-chat (25 Sep),
  // the Council's own poll kept three, three more joined on voting day, and every
  // holder picks the winner. The art team builds the grab's lore and items on it.
  // Closes at the end of Sunday 27 Sep, Brasília time (23:59:59 GMT-3).
  {
    id: 'halloween-2026-theme',
    i18nKey: 'halloween26',
    options: ['folklore', 'classic', 'gore', 'creepypasta', 'fairytales', 'retro90s'],
    opensAt: envDate('POLL_HALLOWEEN_OPENS', '2026-09-27T00:00:00Z'),
    closesAt: envDate('POLL_HALLOWEEN_CLOSES', '2026-09-28T02:59:59Z'),
    // Pinterest pin ids per option (picked 27 Sep from public boards, every one
    // checked to embed). Keep the count equal across options so no theme gets a
    // bigger showcase than another.
    refs: {
      folklore:    ['707276316465158611', '707276316465501835', '3377768461328628', '6473993208101877', '707276316467184875'],
      classic:     ['334533078563690211', '334533078563649882', '334533078563527400', '334533078563554944', '334533078563690219'],
      gore:        ['656681189393685105', '105482816263548207', '105482816263548329', '105482816263765497', '656681189393664938'],
      creepypasta: ['655273814553191437', '1129770256517402818', '1129770256516841887', '1129770256516547570', '1129770256516547574'],
      fairytales:  ['474918723192110935', '355291858093917628', '474918723186491283', '564568503262899892', '564568503262900071'],
      retro90s:    ['33988172185729460', '33988172185729474', '286752701268362065', '33988172185729453', '33988172185669588'],
    },
  },
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

const PIN_ID = /^\d{6,25}$/;
const MAX_REFS = 8;

// The reference pins a poll may publish: valid pin ids, only for its own options.
function publicRefs(p) {
  const out = {};
  for (const opt of p.options) {
    const ids = (p.refs?.[opt] || []).map(String).filter(id => PIN_ID.test(id)).slice(0, MAX_REFS);
    if (ids.length) out[opt] = ids;
  }
  return out;
}

module.exports = { POLLS, pollStatus, publicRefs };
