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
  floorSnapshots: new Map(), // `${day}|${collection}` -> { date, collection, eth_floor, usd_floor }
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

// Create or update the user's application. `status` is 'draft' or 'submitted'.
async function saveApplication(row) {
  const { discordId, discordUsername, ethWallet, bracket, displayName, pitch, answers, positions, status } = row;
  const submitted = status === 'submitted';
  if (usePg) {
    const { rows } = await pool.query(
      `INSERT INTO applications
         (discord_id, discord_username, eth_wallet, bracket, display_name, pitch, answers, positions, status, updated_at, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), ${submitted ? 'now()' : 'NULL'})
       ON CONFLICT (discord_id) DO UPDATE SET
         discord_username = EXCLUDED.discord_username,
         eth_wallet       = EXCLUDED.eth_wallet,
         bracket          = EXCLUDED.bracket,
         display_name     = EXCLUDED.display_name,
         pitch            = EXCLUDED.pitch,
         answers          = EXCLUDED.answers,
         positions        = EXCLUDED.positions,
         status           = EXCLUDED.status,
         updated_at       = now(),
         submitted_at     = ${submitted ? 'COALESCE(applications.submitted_at, now())' : 'applications.submitted_at'}
       RETURNING discord_id, display_name, pitch, answers, positions, bracket, status, submitted_at, updated_at`,
      [discordId, discordUsername, ethWallet, bracket, displayName, pitch, JSON.stringify(answers || {}), JSON.stringify(positions || {}), status],
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
    created_at: existing?.created_at ?? Date.now(),
    updated_at: Date.now(),
    submitted_at: submitted ? (existing?.submitted_at ?? Date.now()) : (existing?.submitted_at ?? null),
  };
  mem.applications.set(discordId, saved);
  return saved;
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

module.exports = {
  get usingPostgres() { return usePg; },
  init,
  createSession,
  getSession,
  deleteSession,
  upsertApplicant,
  getApplication,
  saveApplication,
  recordFloorSnapshot,
  getFloorHistory,
};
