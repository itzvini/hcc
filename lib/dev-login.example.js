'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL DEV TESTING HELPER — TEMPLATE (this .example file is committed but INERT).
//
// To enable dev login on your machine:
//   1. Copy this file to  lib/dev-login.js   (that path is gitignored)
//   2. Set  DEV_LOGIN=1  in your .env
//   3. Restart the server
//
// server.js only ever require()s lib/dev-login.js — never this .example — so this
// template does nothing on its own, and the real file is never committed or
// deployed. That means the auth bypass below CANNOT exist in production, no matter
// how environment variables are configured.
//
// It mints a session with arbitrary holdings so every eligibility screen can be
// tested without a real wallet/NFT:
//   /api/auth/dev-login?user=Whale&creatures=4&land=2   → 5+ bracket
//   /api/auth/dev-login?creatures=3                      → 2–4 bracket
//   /api/auth/dev-login?creatures=1                      → single bracket
//   /api/auth/dev-login?creatures=0&land=0               → holds nothing
//   /api/auth/dev-login?linked=0                         → no wallet linked
//   /api/auth/dev-login?creatures=2&holders=0            → holder snapshot loading
// ─────────────────────────────────────────────────────────────────────────────

const db = require('./db');
const auth = require('./auth');
const { computeEligibility } = require('./eligibility');

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds

module.exports = async function devLogin(request, response, url) {
  // Second gate: even with this file present, require an explicit opt-in and never
  // run under a production NODE_ENV.
  if (process.env.DEV_LOGIN !== '1' || process.env.NODE_ENV === 'production') {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const q = url.searchParams;
  const n = (key) => Math.max(0, parseInt(q.get(key) || '0', 10) || 0);
  const linked = q.get('linked') !== '0';
  const holdersAvailable = q.get('holders') !== '0';
  const creatureCount = n('creatures');
  const landCount = n('land');
  const username = (q.get('user') || 'Dev Tester').slice(0, 40);
  const ethWallet = linked ? (q.get('wallet') || '0xDEV0000000000000000000000000000000000dead') : null;

  const eligibility = {
    linked,
    ethWallet,
    holdersAvailable: linked ? holdersAvailable : false,
    ...computeEligibility({ creatureCount, landCount }),
  };
  const profile = { id: `dev-${username}`, username: `${username} (DEV)`, avatar: null };
  const sid = await db.createSession(profile.id, profile, eligibility);

  response.writeHead(302, {
    Location: '/#apply',
    'Set-Cookie': auth.serializeCookie(auth.SESSION_COOKIE, sid, { maxAge: SESSION_MAX_AGE, secure: auth.isSecure(request) }),
    'Cache-Control': 'no-store',
  });
  response.end();
};
