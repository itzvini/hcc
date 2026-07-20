'use strict';

// Storage layer for the Council application.
//
// Uses Postgres when DATABASE_URL is set (Railway injects this automatically when
// a Postgres plugin is attached). Otherwise falls back to an in-memory store so
// `npm start` works locally with zero setup — note that in-memory data is lost on
// restart, so the fallback is for local dev only, never production.

const crypto = require('node:crypto');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Railway injects DATABASE_URL (internal host) in production. For local dev, the
// internal host isn't reachable, so fall back to DATABASE_PUBLIC_URL (the public
// proxy) when only that is set.
const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || '';
const usePg = !!connectionString;
let pool = null;

// --- in-memory fallback ---
const mem = {
  sessions: new Map(),       // id -> { id, discord_id, profile, eligibility, expires_at }
  applicants: new Map(),     // discord_id -> applicant row
  applications: new Map(),   // discord_id -> candidate application row
  ballots: new Map(),        // `${discord_id}|${bracket}|${round}` -> ballot row
  pollVotes: new Map(),      // `${poll_id}|${discord_id}` -> poll vote row
  voterSnapshots: new Map(), // label -> Map(wallet -> { creature_count, land_count, captured_at })
  floorSnapshots: new Map(), // `${day}|${collection}` -> { date, collection, eth_floor, usd_floor }
  announcements: new Map(),  // message_id -> announcement row (mirrored from the Discord bot)
  holderProfiles: new Map(), // discord_id -> public holder profile row (opt-in showcase)
  linkedWallets: new Map(),  // `${discord_id}|${wallet}` -> { discord_id, wallet, source, label, verified_at }
  auditLog: [],              // append-only event trail (bounded here; persisted in Postgres in prod)
};

function memSweep() {
  const now = Date.now();
  for (const [id, s] of mem.sessions) {
    if (s.expires_at <= now) mem.sessions.delete(id);
  }
}

// Railway's public Postgres URLs need TLS but present a self-signed cert; the
// internal (*.railway.internal) host doesn't use TLS at all. Enable a relaxed
// TLS only when the URL asks for it, so both work.
function pgSsl(url) {
  if (/sslmode=require/i.test(url) || /[.]proxy[.]rlwy[.]net/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return false;
}

async function init() {
  if (!usePg) {
    console.warn('[db] DATABASE_URL not set — using in-memory store (data lost on restart).');
    return;
  }
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString,
    ssl: pgSsl(connectionString),
    max: 5,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      discord_id  TEXT NOT NULL,
      profile     JSONB NOT NULL,
      eligibility JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS applicants (
      discord_id       TEXT PRIMARY KEY,
      discord_username TEXT,
      eth_wallet       TEXT,
      creature_count   INTEGER NOT NULL DEFAULT 0,
      land_count       INTEGER NOT NULL DEFAULT 0,
      total_count      INTEGER NOT NULL DEFAULT 0,
      bracket          TEXT,
      can_run          BOOLEAN NOT NULL DEFAULT false,
      first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      checked_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      discord_id       TEXT PRIMARY KEY,
      discord_username TEXT,
      eth_wallet       TEXT,
      bracket          TEXT,
      display_name     TEXT,
      pitch            TEXT,
      answers          JSONB NOT NULL DEFAULT '{}'::jsonb,
      status           TEXT NOT NULL DEFAULT 'draft',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      submitted_at     TIMESTAMPTZ
    );
  `);
  // VAA positions (per-proposition stance + rationale). Added after the table existed,
  // so use ADD COLUMN IF NOT EXISTS rather than relying on the CREATE above.
  await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS positions JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  // Candidate's Highrise avatar URL (server-derived from the session profile, never
  // client-supplied) — shown on candidate cards once names go public.
  await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS avatar TEXT;`);

  // Official election ballots — one row per PICK. A race elects `seats` seats and a
  // voter may cast up to that many distinct picks in it (one per seat): the Member
  // race elects 2, so up to 2 rows per voter; single-seat and confirmation races cap
  // at 1. `choice` is the chosen candidate's discord_id, or in a confirmation race the
  // token '__seat__' / '__reopen__'. Each pick is FINAL once cast (the public rule) —
  // rows are insert-only, no UPDATE path; a voter can ADD their remaining picks but
  // never change a cast one. The voter↔choice link exists only to enforce the per-race
  // cap + de-dupe; it never leaves the server (API returns the caller's own picks and
  // aggregate tallies only).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ballots (
      discord_id TEXT NOT NULL,
      bracket    TEXT NOT NULL,
      round      INTEGER NOT NULL DEFAULT 1,
      choice     TEXT NOT NULL,
      receipt    TEXT NOT NULL,
      cast_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (discord_id, bracket, round, choice)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ballots_bracket_round_idx ON ballots (bracket, round);`);
  // Multi-seat support: the PK must include `choice` so a voter can hold more than one
  // pick per race. Older deploys created it as (discord_id,bracket,round) — widen it in
  // place. No data loss: existing single-pick rows stay unique under the wider key.
  const ballotPk = await pool.query(`
    SELECT a.attname FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'ballots'::regclass AND i.indisprimary`);
  if (ballotPk.rows.length && !ballotPk.rows.some(r => r.attname === 'choice')) {
    await pool.query('ALTER TABLE ballots DROP CONSTRAINT ballots_pkey');
    await pool.query('ALTER TABLE ballots ADD PRIMARY KEY (discord_id, bracket, round, choice)');
    console.log('[db] widened ballots PK to include choice (multi-seat voting)');
  }

  // Official community-poll votes — one row per voter per poll. `choice` is one of
  // the poll definition's option ids (lib/polls.js). One holder, one vote, enforced
  // TWICE: per Discord account (the PK) and per linked wallet (the unique index), so
  // re-linking the same wallet to a second Discord account can't double-vote. Rows
  // are insert-only — a cast vote is FINAL (the published rule), no UPDATE path.
  // The voter↔choice link exists only to enforce that; the API publishes aggregate
  // tallies (after close) and the caller's own vote, never anyone else's.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id    TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      wallet     TEXT NOT NULL,
      choice     TEXT NOT NULL,
      receipt    TEXT NOT NULL,
      cast_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (poll_id, discord_id)
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS poll_votes_wallet_idx ON poll_votes (poll_id, wallet);`);

  // Official voter snapshot — the holder set frozen when the election is announced
  // (one row per wallet per snapshot label). Voting requires being in the snapshot
  // AND holding at vote time, which is how the continuous-holding rule is enforced
  // for the election: assets bought after the announcement can't vote.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voter_snapshots (
      label          TEXT NOT NULL,
      wallet         TEXT NOT NULL,
      creature_count INTEGER NOT NULL DEFAULT 0,
      land_count     INTEGER NOT NULL DEFAULT 0,
      captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (label, wallet)
    );
  `);

  // Daily market floor snapshots — one row per collection per day. The lowest
  // active listing can only be read for *today*, so we sample it daily and
  // accumulate the history here (the chart fills the pre-launch tail from sales).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS floor_snapshots (
      captured_on DATE NOT NULL,
      collection  TEXT NOT NULL,
      eth_floor   NUMERIC,
      usd_floor   NUMERIC,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (captured_on, collection)
    );
  `);

  // Append-only audit trail of every important event (logins, eligibility outcomes,
  // application drafts/submissions, auth failures). Lets us reconstruct exactly what
  // happened and when, and trace back any disputed or failed action. `ok` flags
  // failures so problems are a one-column filter; `detail` carries structured context.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          BIGSERIAL PRIMARY KEY,
      at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      event       TEXT NOT NULL,
      discord_id  TEXT,
      ok          BOOLEAN NOT NULL DEFAULT true,
      detail      JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS audit_log_event_idx ON audit_log (event);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS audit_log_discord_idx ON audit_log (discord_id);`);

  // Public Discord announcements mirrored here by the bot (see /api/announcements/ingest).
  // Keyed on the Discord message id so re-sends, edits and backfills are idempotent — an
  // edit UPDATEs the same row (never a second card) and a delete flips `deleted_at` (the
  // read path hides it) rather than dropping the audit trail. Only the announcements
  // channel's top-level messages ever land here; thread replies are rejected at ingest.
  // Snowflake ids are stored as TEXT so JS/JSON never loses their 64-bit precision.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      message_id     TEXT PRIMARY KEY,
      channel_id     TEXT NOT NULL,
      author_id      TEXT,
      author_name    TEXT,
      author_display TEXT,
      author_avatar  TEXT,
      content        TEXT NOT NULL DEFAULT '',
      attachments    JSONB NOT NULL DEFAULT '[]'::jsonb,
      embeds         JSONB NOT NULL DEFAULT '[]'::jsonb,
      posted_at      TIMESTAMPTZ NOT NULL,
      edited_at      TIMESTAMPTZ,
      deleted_at     TIMESTAMPTZ,
      ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS announcements_feed_idx ON announcements (posted_at DESC) WHERE deleted_at IS NULL;`);
  // Resolved mention names ({ "<id>": { type: 'role'|'user'|'channel', name } }) so the
  // client can render "@RealName" / "#channel" instead of opaque <@id> tags. Added after
  // the table shipped, so ADD COLUMN IF NOT EXISTS rather than relying on the CREATE.
  await pool.query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '{}'::jsonb;`);

  // Public holder profiles — the OPT-IN wallet↔identity mapping behind /profile/{slug}.
  // A row existing IS the consent: enabling inserts it, disabling DELETEs it outright
  // (no soft-off flag), so the table always equals the exact set of public profiles
  // and a disabled profile leaves nothing behind to leak. Identity fields are
  // server-derived from the session at enable/login time, never client-supplied.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS holder_profiles (
      discord_id   TEXT PRIMARY KEY,
      slug         TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar       TEXT,
      eth_wallet   TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Wallets a member has linked to their public profile. The Highrise wallet is added
  // automatically (source='highrise') as the identity anchor; extra wallets are added
  // only after a signature proves control (source='connected'). UNIQUE(wallet) means one
  // wallet can back at most one profile, so nobody can showcase a wallet another member
  // already proved. SHOWCASE-ONLY: Council eligibility/voting never read this table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS linked_wallets (
      discord_id  TEXT NOT NULL,
      wallet      TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'connected',
      label       TEXT,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (discord_id, wallet)
    );
  `);
  // Two independent truths per wallet: `highrise_linked` = the wallet the member's Highrise
  // account points at (association); `verified` = a MetaMask signature proved key control
  // (true ownership). Added after the enum `source` shipped — backfill once, then use the flags.
  await pool.query(`ALTER TABLE linked_wallets ADD COLUMN IF NOT EXISTS highrise_linked BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE linked_wallets ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`UPDATE linked_wallets SET highrise_linked = true WHERE source = 'highrise' AND highrise_linked = false AND verified = false;`);
  await pool.query(`UPDATE linked_wallets SET verified = true WHERE source = 'connected' AND verified = false AND highrise_linked = false;`);
  // Only ONE profile may VERIFY a wallet (signature = exclusive true ownership), but an
  // unverified Highrise-link may coexist across profiles — that's what surfaces renters /
  // impersonators. So drop the old global unique and make it a partial unique on verified rows.
  await pool.query(`DROP INDEX IF EXISTS linked_wallets_wallet_idx;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS linked_wallets_verified_idx ON linked_wallets (wallet) WHERE verified;`);

  console.log('[db] Connected to Postgres.');
}

// --- sessions ---

async function createSession(discordId, profile, eligibility) {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  if (usePg) {
    await pool.query(
      `INSERT INTO sessions (id, discord_id, profile, eligibility, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, discordId, profile, eligibility ?? null, expiresAt],
    );
  } else {
    mem.sessions.set(id, {
      id, discord_id: discordId, profile, eligibility: eligibility ?? null,
      expires_at: expiresAt.getTime(),
    });
  }
  return id;
}

async function getSession(id) {
  if (!id) return null;
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT id, discord_id, profile, eligibility, expires_at
       FROM sessions WHERE id = $1 AND expires_at > now()`,
      [id],
    );
    return rows[0] || null;
  }
  memSweep();
  return mem.sessions.get(id) || null;
}

async function deleteSession(id) {
  if (!id) return;
  if (usePg) await pool.query(`DELETE FROM sessions WHERE id = $1`, [id]);
  else mem.sessions.delete(id);
}

// Replace a session's stored eligibility snapshot — keeps the login-time copy in sync
// when eligibility is recomputed live against the current holder data.
async function updateSessionEligibility(id, eligibility) {
  if (!id) return;
  if (usePg) {
    await pool.query(`UPDATE sessions SET eligibility = $2 WHERE id = $1`, [id, eligibility ?? null]);
  } else {
    const s = mem.sessions.get(id);
    if (s) s.eligibility = eligibility ?? null;
  }
}

// --- applicants (eligibility snapshot per Discord user) ---

async function upsertApplicant(row) {
  const { discordId, discordUsername, ethWallet, creatureCount, landCount, totalCount, bracket, canRun } = row;
  if (usePg) {
    await pool.query(
      `INSERT INTO applicants
         (discord_id, discord_username, eth_wallet, creature_count, land_count, total_count, bracket, can_run, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (discord_id) DO UPDATE SET
         discord_username = EXCLUDED.discord_username,
         eth_wallet       = EXCLUDED.eth_wallet,
         creature_count   = EXCLUDED.creature_count,
         land_count       = EXCLUDED.land_count,
         total_count      = EXCLUDED.total_count,
         bracket          = EXCLUDED.bracket,
         can_run          = EXCLUDED.can_run,
         checked_at       = now()`,
      [discordId, discordUsername, ethWallet, creatureCount, landCount, totalCount, bracket, canRun],
    );
  } else {
    const existing = mem.applicants.get(discordId);
    mem.applicants.set(discordId, {
      discord_id: discordId,
      discord_username: discordUsername,
      eth_wallet: ethWallet,
      creature_count: creatureCount,
      land_count: landCount,
      total_count: totalCount,
      bracket,
      can_run: canRun,
      first_seen_at: existing?.first_seen_at ?? Date.now(),
      checked_at: Date.now(),
    });
  }
}

// Wallets of signed-in holders verified authoritatively during eligibility checks.
// Unioned into the voter snapshot at capture so a holder the bulk chain snapshot
// missed (indexing gaps) isn't wrongly disenfranchised. Wallet + counts only.
async function getApplicantWallets() {
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT eth_wallet AS wallet, creature_count, land_count
       FROM applicants
       WHERE eth_wallet IS NOT NULL AND total_count > 0`);
    return rows;
  }
  return [...mem.applicants.values()]
    .filter(a => a.eth_wallet && (a.total_count || 0) > 0)
    .map(a => ({ wallet: a.eth_wallet, creature_count: a.creature_count, land_count: a.land_count }));
}

// --- candidate applications (one per Discord user) ---

async function getApplication(discordId) {
  if (!discordId) return null;
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT discord_id, display_name, pitch, answers, positions, bracket, status, submitted_at, updated_at
       FROM applications WHERE discord_id = $1`,
      [discordId],
    );
    return rows[0] || null;
  }
  return mem.applications.get(discordId) || null;
}

// Count of SUBMITTED candidacies per bracket — powers the public election-status
// board. Drafts don't count (they aren't in the race yet). Returns a fixed-shape map
// so the caller never has to guard missing brackets.
async function getCandidateCounts() {
  const counts = { single: 0, mid: 0, whale: 0 };
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT bracket, COUNT(*)::int AS n
       FROM applications
       WHERE status = 'submitted' AND bracket IS NOT NULL
       GROUP BY bracket`,
    );
    for (const r of rows) if (r.bracket in counts) counts[r.bracket] = r.n;
  } else {
    for (const a of mem.applications.values()) {
      if (a.status === 'submitted' && a.bracket in counts) counts[a.bracket]++;
    }
  }
  return counts;
}

// Submitted candidates for the voter match tool + candidate profiles. `discord_id` is
// returned so the server can derive an OPAQUE per-candidate id (a hash) — it is never
// sent to the client. `answers`/`positions`/`pitch`/`display_name` are the candidate's
// consented-public submission; the server decides which fields reach the client (e.g.
// names are withheld until voting opens). Never returns wallet or discord_username. Read-only.
async function getCandidates() {
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT discord_id, display_name, bracket, pitch, positions, answers, avatar
       FROM applications
       WHERE status = 'submitted'
       ORDER BY submitted_at ASC NULLS LAST`,
    );
    return rows;
  }
  return [...mem.applications.values()]
    .filter(a => a.status === 'submitted')
    .map(a => ({ discord_id: a.discord_id, display_name: a.display_name, bracket: a.bracket, pitch: a.pitch, positions: a.positions || {}, answers: a.answers || {}, avatar: a.avatar || null }));
}

// Create or update the user's application. `status` is 'draft' or 'submitted'.
async function saveApplication(row) {
  const { discordId, discordUsername, ethWallet, bracket, displayName, pitch, answers, positions, status, avatar } = row;
  const submitted = status === 'submitted';
  if (usePg) {
    const { rows } = await pool.query(
      `INSERT INTO applications
         (discord_id, discord_username, eth_wallet, bracket, display_name, pitch, answers, positions, status, avatar, updated_at, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), ${submitted ? 'now()' : 'NULL'})
       ON CONFLICT (discord_id) DO UPDATE SET
         discord_username = EXCLUDED.discord_username,
         eth_wallet       = EXCLUDED.eth_wallet,
         bracket          = EXCLUDED.bracket,
         display_name     = EXCLUDED.display_name,
         pitch            = EXCLUDED.pitch,
         answers          = EXCLUDED.answers,
         positions        = EXCLUDED.positions,
         status           = EXCLUDED.status,
         avatar           = COALESCE(EXCLUDED.avatar, applications.avatar),
         updated_at       = now(),
         submitted_at     = ${submitted ? 'COALESCE(applications.submitted_at, now())' : 'applications.submitted_at'}
       RETURNING discord_id, display_name, pitch, answers, positions, bracket, status, submitted_at, updated_at`,
      [discordId, discordUsername, ethWallet, bracket, displayName, pitch, JSON.stringify(answers || {}), JSON.stringify(positions || {}), status, avatar || null],
    );
    return rows[0];
  }
  const existing = mem.applications.get(discordId);
  const saved = {
    discord_id: discordId,
    discord_username: discordUsername,
    eth_wallet: ethWallet,
    bracket,
    display_name: displayName,
    pitch,
    answers: answers || {},
    positions: positions || {},
    status,
    avatar: avatar || existing?.avatar || null,
    created_at: existing?.created_at ?? Date.now(),
    updated_at: Date.now(),
    submitted_at: submitted ? (existing?.submitted_at ?? Date.now()) : (existing?.submitted_at ?? null),
  };
  mem.applications.set(discordId, saved);
  return saved;
}

// Refresh a candidate's stored avatar from their latest login — no-op when they have
// no application row or the new value is empty. Best-effort: never throws.
async function updateApplicationAvatar(discordId, avatar) {
  if (!discordId || !avatar) return;
  try {
    if (usePg) {
      await pool.query(`UPDATE applications SET avatar = $2 WHERE discord_id = $1`, [discordId, avatar]);
    } else {
      const a = mem.applications.get(discordId);
      if (a) a.avatar = avatar;
    }
  } catch (err) {
    console.error('[db] avatar refresh failed:', err.message);
  }
}

// --- public holder profiles (opt-in showcase pages) ---

// Enable (or refresh) a holder's public profile. Row presence = consent, so this is
// the single write path for both first enable and the identity self-heal on login.
async function upsertHolderProfile({ discordId, slug, displayName, avatar, ethWallet }) {
  if (usePg) {
    await pool.query(
      `INSERT INTO holder_profiles (discord_id, slug, display_name, avatar, eth_wallet)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (discord_id) DO UPDATE SET
         slug         = EXCLUDED.slug,
         display_name = EXCLUDED.display_name,
         avatar       = EXCLUDED.avatar,
         eth_wallet   = EXCLUDED.eth_wallet,
         updated_at   = now()`,
      [discordId, slug, displayName, avatar, ethWallet],
    );
  } else {
    const existing = mem.holderProfiles.get(discordId);
    mem.holderProfiles.set(discordId, {
      discord_id: discordId, slug, display_name: displayName, avatar, eth_wallet: ethWallet,
      created_at: existing?.created_at ?? Date.now(), updated_at: Date.now(),
    });
  }
}

// Disable = hard delete. Nothing remains server-side once the holder opts out.
async function deleteHolderProfile(discordId) {
  if (usePg) {
    await pool.query(`DELETE FROM holder_profiles WHERE discord_id = $1`, [discordId]);
  } else {
    mem.holderProfiles.delete(discordId);
  }
}

async function getHolderProfileByDiscord(discordId) {
  if (usePg) {
    const { rows } = await pool.query(`SELECT * FROM holder_profiles WHERE discord_id = $1`, [discordId]);
    return rows[0] || null;
  }
  return mem.holderProfiles.get(discordId) || null;
}

async function getHolderProfileBySlug(slug) {
  if (usePg) {
    const { rows } = await pool.query(`SELECT * FROM holder_profiles WHERE slug = $1`, [slug]);
    return rows[0] || null;
  }
  return [...mem.holderProfiles.values()].find(p => p.slug === slug) || null;
}

// All profiles, for the hourly avatar refresh loop (same staleness problem as
// candidate avatars — Highrise icon URLs are versioned and 404 after a restyle).
async function getHolderProfiles() {
  if (usePg) {
    const { rows } = await pool.query(`SELECT discord_id, slug, avatar FROM holder_profiles`);
    return rows;
  }
  return [...mem.holderProfiles.values()].map(p => ({ discord_id: p.discord_id, slug: p.slug, avatar: p.avatar }));
}

async function updateHolderProfileAvatar(discordId, avatar) {
  if (!discordId || !avatar) return;
  try {
    if (usePg) {
      await pool.query(`UPDATE holder_profiles SET avatar = $2, updated_at = now() WHERE discord_id = $1`, [discordId, avatar]);
    } else {
      const p = mem.holderProfiles.get(discordId);
      if (p) p.avatar = avatar;
    }
  } catch (err) {
    console.error('[db] holder profile avatar refresh failed:', err.message);
  }
}

// --- linked wallets (a profile's showcase wallets — SHOWCASE-ONLY, never eligibility) ---
//
// Two independent truths per wallet:
//   highriseLinked — the wallet the member's Highrise account points at (an association).
//   verified       — a MetaMask signature proved key control (true ownership; exclusive).
// A wallet can be both (the Highrise wallet, signed) or either alone.

// mem-row → the flag shape, tolerating any legacy `source`-only rows.
function memWalletFlags(r) {
  return {
    highriseLinked: r.highrise_linked ?? (r.source === 'highrise'),
    verified: r.verified ?? (r.source === 'connected'),
  };
}

// A member's showcase wallets, Highrise anchor first, deduped by address. Pass `anchorWallet`
// (the profile's eth_wallet) so it's guaranteed present exactly once and flagged highriseLinked —
// this is what stops a wallet that is both the anchor and signed from appearing (and duplicating) twice.
async function getLinkedWallets(discordId, anchorWallet = null) {
  let rows;
  if (usePg) {
    const res = await pool.query(
      `SELECT wallet, highrise_linked AS "highriseLinked", verified FROM linked_wallets
       WHERE discord_id = $1 ORDER BY highrise_linked DESC, verified_at ASC`, [discordId]);
    rows = res.rows;
  } else {
    rows = [...mem.linkedWallets.values()]
      .filter(w => w.discord_id === discordId)
      .map(w => ({ wallet: w.wallet, ...memWalletFlags(w), verified_at: w.verified_at }))
      .sort((a, b) => (b.highriseLinked - a.highriseLinked) || (a.verified_at - b.verified_at))
      .map(({ verified_at, ...w }) => w);
  }
  const anchor = (anchorWallet || '').toLowerCase();
  const seen = new Set();
  const out = [];
  for (const w of rows) {
    const a = String(w.wallet).toLowerCase();
    if (seen.has(a)) continue;
    seen.add(a);
    out.push({ wallet: a, highriseLinked: a === anchor ? true : !!w.highriseLinked, verified: !!w.verified });
  }
  if (anchor && !seen.has(anchor)) out.unshift({ wallet: anchor, highriseLinked: true, verified: false });
  out.sort((x, y) => (y.highriseLinked - x.highriseLinked));
  return out;
}

// Mark `wallet` as the member's current Highrise anchor. Also demotes any previous anchor of
// this member and drops rows that end up neither linked nor verified — so when a member's
// Highrise account switches wallets, the stale anchor doesn't linger on their profile.
async function setHighriseAnchor(discordId, wallet) {
  const w = String(wallet).toLowerCase();
  if (usePg) {
    await pool.query(`UPDATE linked_wallets SET highrise_linked = false WHERE discord_id = $1 AND wallet <> $2 AND highrise_linked = true`, [discordId, w]);
    await pool.query(`DELETE FROM linked_wallets WHERE discord_id = $1 AND wallet <> $2 AND highrise_linked = false AND verified = false`, [discordId, w]);
    await pool.query(
      `INSERT INTO linked_wallets (discord_id, wallet, source, highrise_linked, verified)
       VALUES ($1,$2,'highrise',true,false)
       ON CONFLICT (discord_id, wallet) DO UPDATE SET highrise_linked = true`,
      [discordId, w]);
    return;
  }
  for (const [k, r] of mem.linkedWallets) {
    if (r.discord_id !== discordId || r.wallet === w) continue;
    r.highrise_linked = false;
    if (!r.verified) mem.linkedWallets.delete(k);
  }
  const cur = mem.linkedWallets.get(`${discordId}|${w}`);
  mem.linkedWallets.set(`${discordId}|${w}`, {
    discord_id: discordId, wallet: w, highrise_linked: true, verified: !!cur?.verified,
    label: cur?.label ?? null, verified_at: cur?.verified_at ?? Date.now(),
  });
}

// Prove key control of `wallet` (a MetaMask signature already verified upstream). Sets verified.
// Exclusive, latest-proof-wins: at most ONE member holds a wallet's verification, but a fresh
// signature always TRANSFERS it — only the key holder can ever sign, so whoever proves control
// now IS the current owner. First-claim-forever would let a phished signature squat a wallet
// with no recovery; with transfer, the true owner reclaims in one sign and the squatter's badge
// silently drops. Returns { ok:true, reclaimedFrom? } — reclaimedFrom is the previous holder's
// discord_id when a transfer happened (callers event-log it as an audit trail).
async function verifyWallet(discordId, wallet) {
  const w = String(wallet).toLowerCase();
  if (usePg) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize per-wallet so two simultaneous verifies can't both pass the demote step.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`vw:${w}`]);
      const { rows } = await client.query(
        `SELECT discord_id FROM linked_wallets WHERE wallet = $1 AND verified = true`, [w]);
      const prev = rows[0] && rows[0].discord_id !== discordId ? rows[0].discord_id : null;
      if (prev) {
        // Demote the previous holder BEFORE our insert (the partial unique index on
        // (wallet) WHERE verified allows only one). A row left neither Highrise-linked
        // nor verified says nothing anymore — drop it.
        await client.query(
          `UPDATE linked_wallets SET verified = false WHERE wallet = $1 AND discord_id = $2`, [w, prev]);
        await client.query(
          `DELETE FROM linked_wallets WHERE wallet = $1 AND discord_id = $2 AND highrise_linked = false AND verified = false`,
          [w, prev]);
      }
      await client.query(
        `INSERT INTO linked_wallets (discord_id, wallet, source, highrise_linked, verified)
         VALUES ($1,$2,'connected',false,true)
         ON CONFLICT (discord_id, wallet) DO UPDATE SET verified = true`,
        [discordId, w]);
      await client.query('COMMIT');
      return { ok: true, ...(prev ? { reclaimedFrom: prev } : {}) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') return { ok: false, reason: 'conflict' }; // partial-unique backstop
      throw err;
    } finally {
      client.release();
    }
  }
  let prev = null;
  for (const [k, r] of mem.linkedWallets) {
    if (r.wallet !== w || !r.verified || r.discord_id === discordId) continue;
    prev = r.discord_id;
    r.verified = false;
    if (!r.highrise_linked) mem.linkedWallets.delete(k);
  }
  const cur = mem.linkedWallets.get(`${discordId}|${w}`);
  mem.linkedWallets.set(`${discordId}|${w}`, {
    discord_id: discordId, wallet: w, highrise_linked: !!cur?.highrise_linked, verified: true,
    label: cur?.label ?? null, verified_at: cur?.verified_at ?? Date.now(),
  });
  return { ok: true, ...(prev ? { reclaimedFrom: prev } : {}) };
}

// Remove a showcase wallet. The Highrise anchor (highrise_linked) is protected — only a
// standalone verified/connected wallet can be removed.
async function unlinkWallet(discordId, wallet) {
  const w = String(wallet).toLowerCase();
  if (usePg) {
    await pool.query(`DELETE FROM linked_wallets WHERE discord_id = $1 AND wallet = $2 AND highrise_linked = false`, [discordId, w]);
  } else {
    const r = mem.linkedWallets.get(`${discordId}|${w}`);
    if (r && !r.highrise_linked) mem.linkedWallets.delete(`${discordId}|${w}`);
  }
}

// The enabled profile (if any) that has signature-VERIFIED this wallet — the true owner.
// Returns { discordId, slug, name } or null. Used to flag a wallet as owned elsewhere.
async function getVerifiedOwnerProfile(wallet) {
  const w = String(wallet).toLowerCase();
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT lw.discord_id, hp.slug, hp.display_name AS name
       FROM linked_wallets lw JOIN holder_profiles hp ON hp.discord_id = lw.discord_id
       WHERE lw.wallet = $1 AND lw.verified = true LIMIT 1`, [w]);
    return rows[0] ? { discordId: rows[0].discord_id, slug: rows[0].slug, name: rows[0].name } : null;
  }
  const r = [...mem.linkedWallets.values()].find(x => x.wallet === w && x.verified);
  if (!r) return null;
  const hp = mem.holderProfiles.get(r.discord_id);
  return hp ? { discordId: r.discord_id, slug: hp.slug, name: hp.display_name } : null;
}

// The showcase wallets behind a public profile slug (only if the profile is enabled). Each
// wallet carries `verifiedElsewhere` = the profile that owns it, when that's a DIFFERENT member.
async function getProfileWalletsBySlug(slug) {
  const profile = await getHolderProfileBySlug(slug);
  if (!profile) return null;
  const wallets = await getLinkedWallets(profile.discord_id, profile.eth_wallet);
  for (const w of wallets) {
    if (w.verified) { w.verifiedElsewhere = null; continue; } // this profile is the owner
    const owner = await getVerifiedOwnerProfile(w.wallet);
    w.verifiedElsewhere = owner && owner.discordId !== profile.discord_id ? { slug: owner.slug, name: owner.name } : null;
  }
  return { profile, wallets };
}

// Resolve a marketplace search term to an enabled profile by slug or display name
// (case-insensitive). Returns { profile, wallets } or null.
async function findEnabledProfileByQuery(q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return null;
  let profile = null;
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT * FROM holder_profiles WHERE slug = $1 OR lower(display_name) = $1 LIMIT 1`, [needle]);
    profile = rows[0] || null;
  } else {
    profile = [...mem.holderProfiles.values()]
      .find(p => p.slug === needle || String(p.display_name || '').toLowerCase() === needle) || null;
  }
  if (!profile) return null;
  return getProfileWalletsBySlug(profile.slug);
}

// --- official ballots (one per voter per race per round, insert-only) ---

// Cast one pick. A voter may hold up to `maxPicks` distinct picks per race (= the
// race's seat count); each pick is insert-only, so a cast pick can never be changed —
// only the unused remaining picks can still be added. Returns:
//   { row, count }            on success (count = total picks the voter now holds here)
//   { row: null, reason }     on rejection — 'duplicate' (already picked this choice)
//                             or 'cap' (already used all maxPicks).
// The pg path serializes concurrent casts for the same voter+race with an advisory
// lock so two simultaneous submits can't slip past the cap.
async function castBallot({ discordId, bracket, round, choice, receipt, maxPicks = 1 }) {
  if (usePg) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`${discordId}|${bracket}|${round}`]);
      const { rows: existing } = await client.query(
        `SELECT choice FROM ballots WHERE discord_id=$1 AND bracket=$2 AND round=$3`,
        [discordId, bracket, round]);
      if (existing.some(r => r.choice === choice)) { await client.query('ROLLBACK'); return { row: null, reason: 'duplicate' }; }
      if (existing.length >= maxPicks)             { await client.query('ROLLBACK'); return { row: null, reason: 'cap' }; }
      const { rows } = await client.query(
        `INSERT INTO ballots (discord_id, bracket, round, choice, receipt)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING discord_id, bracket, round, choice, receipt, cast_at`,
        [discordId, bracket, round, choice, receipt]);
      await client.query('COMMIT');
      return { row: rows[0], count: existing.length + 1 };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  const existing = [...mem.ballots.values()].filter(b => b.discord_id === discordId && b.bracket === bracket && Number(b.round) === Number(round));
  if (existing.some(r => r.choice === choice)) return { row: null, reason: 'duplicate' };
  if (existing.length >= maxPicks) return { row: null, reason: 'cap' };
  const row = { discord_id: discordId, bracket, round, choice, receipt, cast_at: Date.now() };
  mem.ballots.set(`${discordId}|${bracket}|${round}|${choice}`, row);
  return { row, count: existing.length + 1 };
}

// The caller's OWN ballots (all rounds) — to render "you've voted" + the receipt.
// Own-data exception: never call this for anyone but the session user.
async function getBallotsFor(discordId) {
  if (!discordId) return [];
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT bracket, round, choice, receipt, cast_at
       FROM ballots WHERE discord_id = $1`,
      [discordId],
    );
    return rows;
  }
  return [...mem.ballots.values()]
    .filter(b => b.discord_id === discordId)
    .map(({ discord_id, ...rest }) => rest);
}

// All receipt codes — [{ bracket, round, receipt }], sorted by code so the published
// list's order reveals nothing about when each ballot was cast (insertion order would
// correlate with the timestamped audit trail). Codes are random and carry no link to
// voter or choice, so publishing them is safe; voters verify inclusion by finding
// their own code, and the list's length must equal the published turnout.
async function getBallotReceipts() {
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT bracket, round, receipt FROM ballots ORDER BY receipt ASC`,
    );
    return rows;
  }
  return [...mem.ballots.values()]
    .map(b => ({ bracket: b.bracket, round: b.round, receipt: b.receipt }))
    .sort((a, b) => a.receipt.localeCompare(b.receipt));
}

// Aggregate tallies — [{ bracket, round, choice, n }]. No voter identities; this is
// the ONLY read path the results computation uses.
async function getBallotTallies() {
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT bracket, round, choice, COUNT(*)::int AS n
       FROM ballots GROUP BY bracket, round, choice`,
    );
    return rows;
  }
  const agg = new Map();
  for (const b of mem.ballots.values()) {
    const key = `${b.bracket}|${b.round}|${b.choice}`;
    agg.set(key, (agg.get(key) || 0) + 1);
  }
  return [...agg.entries()].map(([key, n]) => {
    const [bracket, round, choice] = key.split('|');
    return { bracket, round: Number(round), choice, n };
  });
}

// --- community-poll votes (one per voter per poll, insert-only) ---

// Cast one poll vote. Insert-only — a cast vote can never be changed. Returns
//   { row }                     on success
//   { row: null, reason }       on rejection — 'already' (this account voted) or
//                               'wallet' (this wallet voted from another account).
// The pg path serializes concurrent casts for the same voter/wallet with advisory
// locks so two simultaneous submits can't slip past the one-vote rule.
async function castPollVote({ pollId, discordId, wallet, choice, receipt }) {
  const w = String(wallet || '').trim().toLowerCase();
  if (usePg) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`poll|${pollId}|${discordId}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`poll|${pollId}|${w}`]);
      const { rows: dupe } = await client.query(
        `SELECT discord_id FROM poll_votes WHERE poll_id = $1 AND (discord_id = $2 OR wallet = $3)`,
        [pollId, discordId, w]);
      if (dupe.length) {
        await client.query('ROLLBACK');
        return { row: null, reason: dupe.some(r => r.discord_id === discordId) ? 'already' : 'wallet' };
      }
      const { rows } = await client.query(
        `INSERT INTO poll_votes (poll_id, discord_id, wallet, choice, receipt)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING poll_id, choice, receipt, cast_at`,
        [pollId, discordId, w, choice, receipt]);
      await client.query('COMMIT');
      return { row: rows[0] };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  if (mem.pollVotes.has(`${pollId}|${discordId}`)) return { row: null, reason: 'already' };
  for (const v of mem.pollVotes.values()) {
    if (v.poll_id === pollId && v.wallet === w) return { row: null, reason: 'wallet' };
  }
  const row = { poll_id: pollId, discord_id: discordId, wallet: w, choice, receipt, cast_at: Date.now() };
  mem.pollVotes.set(`${pollId}|${discordId}`, row);
  return { row };
}

// The caller's OWN poll votes — to render "you voted" + the receipt. Own-data
// exception: never call this for anyone but the session user.
async function getPollVotesFor(discordId) {
  if (!discordId) return [];
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT poll_id, choice, receipt, cast_at FROM poll_votes WHERE discord_id = $1`,
      [discordId],
    );
    return rows;
  }
  return [...mem.pollVotes.values()]
    .filter(v => v.discord_id === discordId)
    .map(({ discord_id, wallet, ...rest }) => rest);
}

// Aggregate tallies — [{ poll_id, choice, n }]. No voter identities; this is the
// only read path the published results use (turnout is derived from it too).
async function getPollTallies() {
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT poll_id, choice, COUNT(*)::int AS n FROM poll_votes GROUP BY poll_id, choice`,
    );
    return rows;
  }
  const agg = new Map();
  for (const v of mem.pollVotes.values()) {
    const key = `${v.poll_id}|${v.choice}`;
    agg.set(key, (agg.get(key) || 0) + 1);
  }
  return [...agg.entries()].map(([key, n]) => {
    const [poll_id, choice] = key.split('|');
    return { poll_id, choice, n };
  });
}

// A poll's receipt codes, sorted by code so the published list's order reveals
// nothing about when each vote was cast. Codes are random and linked to neither
// voter nor choice; voters verify inclusion by finding their own code, and the
// list's length must equal the published turnout.
async function getPollReceipts(pollId) {
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT receipt FROM poll_votes WHERE poll_id = $1 ORDER BY receipt ASC`, [pollId]);
    return rows.map(r => r.receipt);
  }
  return [...mem.pollVotes.values()]
    .filter(v => v.poll_id === pollId)
    .map(v => v.receipt)
    .sort((a, b) => a.localeCompare(b));
}

// --- voter snapshot (the frozen holder set that may vote) ---

// Bulk-save a snapshot's wallets. Insert-only and idempotent: re-running a capture
// never overwrites or removes rows, so a snapshot can only ever grow by union —
// in practice the caller captures once and re-runs are no-ops.
async function saveVoterSnapshot(label, rows) {
  if (!label || !rows?.length) return 0;
  if (usePg) {
    let saved = 0;
    // Chunked multi-row inserts — the holder set is a few thousand rows at most.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const values = [];
      const params = [label];
      chunk.forEach(r => {
        params.push(r.wallet.toLowerCase(), r.creatureCount | 0, r.landCount | 0);
        const b = params.length;
        values.push(`($1, $${b - 2}, $${b - 1}, $${b})`);
      });
      const res = await pool.query(
        `INSERT INTO voter_snapshots (label, wallet, creature_count, land_count)
         VALUES ${values.join(',')} ON CONFLICT (label, wallet) DO NOTHING`,
        params,
      );
      saved += res.rowCount;
    }
    return saved;
  }
  const snap = mem.voterSnapshots.get(label) || new Map();
  let saved = 0;
  for (const r of rows) {
    const w = r.wallet.toLowerCase();
    if (!snap.has(w)) {
      snap.set(w, { creature_count: r.creatureCount | 0, land_count: r.landCount | 0, captured_at: Date.now() });
      saved++;
    }
  }
  mem.voterSnapshots.set(label, snap);
  return saved;
}

// Size + capture time of a snapshot — null when it doesn't exist yet.
async function getVoterSnapshotInfo(label) {
  if (!label) return null;
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS wallets, MIN(captured_at) AS captured_at
       FROM voter_snapshots WHERE label = $1`, [label]);
    return rows[0]?.wallets ? { wallets: rows[0].wallets, capturedAt: rows[0].captured_at } : null;
  }
  const snap = mem.voterSnapshots.get(label);
  if (!snap?.size) return null;
  return { wallets: snap.size, capturedAt: new Date(Math.min(...[...snap.values()].map(r => r.captured_at))) };
}

// Is this wallet in the snapshot? The voting gate's membership test. Case-insensitive
// on the stored value: saveVoterSnapshot already lowercases on insert, but a wallet
// added out-of-band (a manual SQL insert from a block explorer's checksummed address)
// would otherwise never match the lowercased lookup and silently lock that voter out.
async function isInVoterSnapshot(label, wallet) {
  const w = (wallet || '').trim().toLowerCase();
  if (!label || !w) return false;
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT 1 FROM voter_snapshots WHERE label = $1 AND lower(btrim(wallet)) = $2`, [label, w]);
    return !!rows.length;
  }
  return !!mem.voterSnapshots.get(label)?.has(w);
}

// --- market floor snapshots (lowest active listing, one row per collection per day) ---

// Record (or refresh) a day's floor for a collection. `day` is a 'YYYY-MM-DD'
// string; repeated calls on the same day overwrite, so the latest read wins.
async function recordFloorSnapshot({ day, collection, ethFloor, usdFloor }) {
  if (!day || !collection) return;
  if (usePg) {
    await pool.query(
      `INSERT INTO floor_snapshots (captured_on, collection, eth_floor, usd_floor, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (captured_on, collection) DO UPDATE SET
         eth_floor  = EXCLUDED.eth_floor,
         usd_floor  = EXCLUDED.usd_floor,
         updated_at = now()`,
      [day, collection, ethFloor, usdFloor],
    );
  } else {
    mem.floorSnapshots.set(`${day}|${collection}`, {
      date: day, collection, eth_floor: ethFloor, usd_floor: usdFloor,
    });
  }
}

// Daily floor rows for the last `sinceDays` days, oldest first, both collections.
async function getFloorHistory(sinceDays = 730) {
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT to_char(captured_on, 'YYYY-MM-DD') AS date, collection, eth_floor, usd_floor
       FROM floor_snapshots
       WHERE captured_on >= (CURRENT_DATE - $1::int)
       ORDER BY captured_on ASC`,
      [sinceDays],
    );
    return rows;
  }
  const cutoff = Date.now() - sinceDays * 86400000;
  return [...mem.floorSnapshots.values()]
    .filter(r => new Date(`${r.date}T00:00:00Z`).getTime() >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// --- announcements (public Discord feed mirrored by the bot) ---

// Create or update one announcement, keyed on its Discord message id. Idempotent by
// design: a re-send or an edit UPDATEs the same row (so an edited message can never
// appear twice), preserving the original `posted_at`, the soft-delete flag, and the
// first-seen `ingested_at`. `editedAt` is set from the Discord edit timestamp when the
// content changed. Returns nothing — callers treat it as fire-and-forget ingest.
async function upsertAnnouncement(row) {
  const {
    messageId, channelId, authorId = null, authorName = null, authorDisplay = null,
    authorAvatar = null, content = '', attachments = [], embeds = [], mentions = {}, postedAt, editedAt = null,
  } = row;
  if (!messageId || !channelId || !postedAt) return;
  if (usePg) {
    await pool.query(
      `INSERT INTO announcements
         (message_id, channel_id, author_id, author_name, author_display, author_avatar,
          content, attachments, embeds, mentions, posted_at, edited_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (message_id) DO UPDATE SET
         author_name    = EXCLUDED.author_name,
         author_display = EXCLUDED.author_display,
         author_avatar  = EXCLUDED.author_avatar,
         content        = EXCLUDED.content,
         attachments    = EXCLUDED.attachments,
         embeds         = EXCLUDED.embeds,
         mentions       = EXCLUDED.mentions,
         edited_at      = EXCLUDED.edited_at,
         updated_at     = now()`,
      [String(messageId), String(channelId), authorId, authorName, authorDisplay, authorAvatar,
       content, JSON.stringify(attachments || []), JSON.stringify(embeds || []), JSON.stringify(mentions || {}),
       new Date(postedAt), editedAt ? new Date(editedAt) : null],
    );
    return;
  }
  const existing = mem.announcements.get(String(messageId));
  mem.announcements.set(String(messageId), {
    message_id: String(messageId),
    channel_id: String(channelId),
    author_id: authorId,
    author_name: authorName,
    author_display: authorDisplay,
    author_avatar: authorAvatar,
    content: content || '',
    attachments: attachments || [],
    embeds: embeds || [],
    mentions: mentions || {},
    posted_at: new Date(postedAt),
    edited_at: editedAt ? new Date(editedAt) : null,
    deleted_at: existing?.deleted_at ?? null, // an edit never resurrects a deleted post
    ingested_at: existing?.ingested_at ?? new Date(),
    updated_at: new Date(),
  });
}

// Soft-delete an announcement (mirrors a Discord delete): the row stays for the audit
// trail but the read path hides it. Idempotent — a second delete is a no-op.
async function deleteAnnouncement(messageId) {
  if (!messageId) return;
  if (usePg) {
    await pool.query(
      `UPDATE announcements SET deleted_at = now(), updated_at = now()
       WHERE message_id = $1 AND deleted_at IS NULL`,
      [String(messageId)]);
    return;
  }
  const row = mem.announcements.get(String(messageId));
  if (row && !row.deleted_at) { row.deleted_at = new Date(); row.updated_at = new Date(); }
}

// The public feed: live (non-deleted) announcements, newest first. `limit` is clamped.
// Deleted rows are never returned, so a removed Discord post drops off the site.
async function getAnnouncements({ limit = 50 } = {}) {
  const lim = Math.min(200, Math.max(1, limit | 0));
  if (usePg) {
    const { rows } = await pool.query(
      `SELECT message_id, channel_id, author_id, author_name, author_display, author_avatar,
              content, attachments, embeds, mentions, posted_at, edited_at
       FROM announcements
       WHERE deleted_at IS NULL
       ORDER BY posted_at DESC
       LIMIT $1`, [lim]);
    return rows;
  }
  return [...mem.announcements.values()]
    .filter(a => !a.deleted_at)
    .sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at))
    .slice(0, lim);
}

// --- audit log (append-only event trail for traceability) ---

// Record one event. Best-effort and NEVER throws: an audit-logging failure must not
// break the request it's recording. `detail` is any JSON-serialisable context object.
async function recordEvent({ event, discordId = null, ok = true, detail = {} } = {}) {
  if (!event) return;
  try {
    if (usePg) {
      await pool.query(
        `INSERT INTO audit_log (event, discord_id, ok, detail) VALUES ($1, $2, $3, $4)`,
        [event, discordId, ok, JSON.stringify(detail ?? {})],
      );
    } else {
      mem.auditLog.push({ id: mem.auditLog.length + 1, at: Date.now(), event, discord_id: discordId, ok, detail: detail ?? {} });
      if (mem.auditLog.length > 5000) mem.auditLog.shift(); // bound dev memory
    }
  } catch (err) {
    console.error(`[audit] failed to record "${event}":`, err.message);
  }
}

// Read recent events (newest first) for ops/traceback. Not exposed over HTTP — query
// from a trusted context (psql / a future authenticated admin view) only.
async function getEvents({ limit = 200, event = null, discordId = null } = {}) {
  const lim = Math.min(1000, Math.max(1, limit | 0));
  if (usePg) {
    const where = [], params = [];
    if (event)     { params.push(event);     where.push(`event = $${params.length}`); }
    if (discordId) { params.push(discordId); where.push(`discord_id = $${params.length}`); }
    params.push(lim);
    const { rows } = await pool.query(
      `SELECT id, at, event, discord_id, ok, detail FROM audit_log
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  }
  let rows = [...mem.auditLog].reverse();
  if (event)     rows = rows.filter(r => r.event === event);
  if (discordId) rows = rows.filter(r => r.discord_id === discordId);
  return rows.slice(0, lim);
}

module.exports = {
  get usingPostgres() { return usePg; },
  init,
  createSession,
  getSession,
  deleteSession,
  updateSessionEligibility,
  upsertApplicant,
  getApplicantWallets,
  getApplication,
  getCandidateCounts,
  getCandidates,
  saveApplication,
  updateApplicationAvatar,
  upsertHolderProfile,
  deleteHolderProfile,
  getHolderProfileByDiscord,
  getHolderProfileBySlug,
  getHolderProfiles,
  updateHolderProfileAvatar,
  getLinkedWallets,
  setHighriseAnchor,
  verifyWallet,
  unlinkWallet,
  getVerifiedOwnerProfile,
  getProfileWalletsBySlug,
  findEnabledProfileByQuery,
  castBallot,
  getBallotsFor,
  getBallotTallies,
  getBallotReceipts,
  castPollVote,
  getPollVotesFor,
  getPollTallies,
  getPollReceipts,
  saveVoterSnapshot,
  getVoterSnapshotInfo,
  isInVoterSnapshot,
  recordFloorSnapshot,
  getFloorHistory,
  upsertAnnouncement,
  deleteAnnouncement,
  getAnnouncements,
  recordEvent,
  getEvents,
};
