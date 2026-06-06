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
  sessions: new Map(),   // id -> { id, discord_id, profile, eligibility, expires_at }
  applicants: new Map(), // discord_id -> applicant row
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

module.exports = {
  get usingPostgres() { return usePg; },
  init,
  createSession,
  getSession,
  deleteSession,
  upsertApplicant,
};
