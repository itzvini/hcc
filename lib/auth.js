'use strict';

// Discord OAuth2 (Authorization Code grant) + Highrise wallet lookup.
//
// Flow:
//   1. /api/auth/discord/login  → redirect to Discord with a CSRF `state` cookie.
//   2. Discord → /api/auth/discord/callback?code&state → verify state,
//      exchange the code for a token, fetch the Discord user (scope: identify).
//   3. Look up that Discord id's linked ETH wallet via the Highrise web API.
// Eligibility + session creation happen in server.js, which owns the holder cache.

const crypto = require('node:crypto');

const DISCORD_API   = 'https://discord.com/api';
const HIGHRISE_API  = 'https://webapi.highrise.game';
// `guilds.members.read` lets us read the user's OWN member profile in a specific
// guild (their server nickname/display name) using their access token — no bot needed.
const OAUTH_SCOPE   = 'identify guilds.members.read';
const STATE_COOKIE  = 'hcc_oauth_state';
const SESSION_COOKIE = 'hcc_sid';

const CLIENT_ID     = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const HIGHRISE_KEY  = process.env.HIGHRISE_API_KEY || '';
// The Highrise Discord server — the candidate's display name there becomes their ballot name.
const HIGHRISE_GUILD_ID = process.env.HIGHRISE_GUILD_ID || '489227592507850772';

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && HIGHRISE_KEY);
}

// --- cookie helpers ---

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function serializeCookie(name, value, { maxAge, secure, httpOnly = true, path = '/', sameSite = 'Lax' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAge != null) c += `; Max-Age=${maxAge}`;
  return c;
}

// Hosts we'll honour when deriving the OAuth origin from request headers. The
// Host / X-Forwarded-Host headers are attacker-controlled, so an unrecognised host
// must never end up in the redirect_uri (it could point the OAuth round-trip at an
// attacker domain). Anything not on this list falls back to the canonical origin.
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_REDIRECT_HOSTS || 'hcc.highrise.game,localhost,127.0.0.1')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean),
);
const FALLBACK_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://hcc.highrise.game';

// Behind Railway's proxy the real scheme is in x-forwarded-proto.
function requestOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket.encrypted ? 'https' : 'http');
  const rawHost = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const hostname = rawHost.split(':')[0].toLowerCase();
  if (rawHost && ALLOWED_HOSTS.has(hostname)) return `${proto}://${rawHost}`;
  return FALLBACK_ORIGIN; // spoofed/unknown host — never trust it
}

function isSecure(req) {
  return requestOrigin(req).startsWith('https');
}

function redirectUri(req) {
  return process.env.DISCORD_REDIRECT_URI || `${requestOrigin(req)}/api/auth/discord/callback`;
}

// --- step 1: login redirect ---

function buildLoginRedirect(req) {
  const state = crypto.randomBytes(16).toString('hex');
  const url = new URL(`${DISCORD_API}/oauth2/authorize`);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(req));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('state', state);
  const stateCookie = serializeCookie(STATE_COOKIE, state, {
    maxAge: 600, secure: isSecure(req), sameSite: 'Lax',
  });
  return { location: url.toString(), stateCookie };
}

// --- step 2: token exchange + user fetch ---

async function exchangeCode(code, req) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(req),
  });
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Discord token exchange failed (${res.status})`);
  return res.json();
}

async function fetchDiscordUser(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Discord user fetch failed (${res.status})`);
  const u = await res.json();
  return {
    id: u.id,
    username: u.global_name || u.username || u.id,
    avatar: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
      : null,
  };
}

// The user's display name inside the Highrise Discord server (their ballot name).
// Precedence: per-server nickname → global display name → username. Never throws —
// returns { inGuild:false, serverName:null } if they're not in the server or the
// scope/call fails, so login still succeeds.
async function fetchGuildDisplayName(accessToken) {
  try {
    const res = await fetch(`${DISCORD_API}/users/@me/guilds/${HIGHRISE_GUILD_ID}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { inGuild: false, serverName: null }; // 404 = not a member; others = degrade gracefully
    const m = await res.json();
    const serverName = m.nick || m.user?.global_name || m.user?.username || null;
    return { inGuild: true, serverName };
  } catch {
    return { inGuild: false, serverName: null };
  }
}

// --- step 3: Highrise wallet lookup ---
// Returns { ethWallet, linked } or throws on a real error. A 404 means the Discord
// account has no linked wallet (linked: false), which is a normal outcome, not an error.

async function fetchHighriseWallet(discordId, { retried = false } = {}) {
  const res = await fetch(`${HIGHRISE_API}/discord/users/${encodeURIComponent(discordId)}/wallet`, {
    headers: { 'X-Api-Key': HIGHRISE_KEY },
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 404) return { ethWallet: null, linked: false };

  if (res.status === 429 && !retried) {
    await new Promise(r => setTimeout(r, 1100)); // rate limited — wait ~1s and retry once
    return fetchHighriseWallet(discordId, { retried: true });
  }

  if (!res.ok) throw new Error(`Highrise wallet lookup failed (${res.status})`);

  const body = await res.json();
  return { ethWallet: body.eth_wallet || null, linked: !!body.eth_wallet, userId: body.user_id || null };
}

// Public Highrise profile by user_id (from the wallet lookup). Returns the ready-made
// CDN icon/avatar URLs + username. Never throws — returns null on any failure so login
// still succeeds without the Highrise avatar.
async function fetchHighriseProfile(userId, { retried = false } = {}) {
  if (!userId) return null;
  try {
    const res = await fetch(`${HIGHRISE_API}/users/${encodeURIComponent(userId)}`, {
      headers: { 'X-Api-Key': HIGHRISE_KEY },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429 && !retried) {
      await new Promise(r => setTimeout(r, 1100));
      return fetchHighriseProfile(userId, { retried: true });
    }
    if (!res.ok) return null;
    const u = (await res.json()).user || {};
    return { userId, name: u.username || null, iconUrl: u.icon_url || null, avatarUrl: u.avatar_url || null };
  } catch {
    return null;
  }
}

module.exports = {
  STATE_COOKIE,
  SESSION_COOKIE,
  isConfigured,
  parseCookies,
  serializeCookie,
  isSecure,
  buildLoginRedirect,
  exchangeCode,
  fetchDiscordUser,
  fetchGuildDisplayName,
  fetchHighriseWallet,
  fetchHighriseProfile,
};
