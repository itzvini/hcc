# HCC Player Council

Static Highrise Creature Club Player Council announcement site, packaged with a tiny Node server for Railway.

## Local Run

```bash
npm start
```

Then open `http://localhost:3000`.

For local dev with live market data, put your key in `.env` and run `npm run dev`:

```
OPENSEA_API_KEY=your_key_here
SQUID_INTEGRATOR_ID=your_squid_integrator_id
```

`SQUID_INTEGRATOR_ID` (optional) powers the Trade tab's one-tap, exact-amount ETH
bridge quotes (Ethereum → Immutable zkEVM) via the [Squid Router API](https://docs.squidrouter.com).
Get one free from Squid's integrator portal. Without it, the funds helper falls back
to a prefilled Squid deep-link — everything else works unchanged. Like all secrets it
lives only in `.env` locally and in Railway **Variables** in production.

## Market data

The **Market** tab shows floor prices and weekly sale-price history for Creatures and LAND.

- **Creatures** — floor + sale history from the Immutable zkEVM API (no key required).
- **LAND** — floor + 30-day stats + sale history from OpenSea when `OPENSEA_API_KEY` is set.
  Without a key it falls back to CoinGecko for the current floor only (no history line).

All data is fetched server-side and cached for 30 minutes (`/api/market`), so no
database is needed — history is recomputed from on-chain/marketplace sales each refresh.

## Apply & Vote (the First Election)

The **Apply & Vote** tab runs the Council's first election end-to-end: a holder signs
in with Discord, sees whether they can vote and which seat bracket they can run for,
self-nominates if eligible, and uses the Voting Advice Application to find their
best-matching candidates.

**Sign-in & eligibility.** `/api/auth/discord/login` → Discord OAuth2 (scope `identify`) →
`/api/auth/discord/callback` → look up the Discord account's linked ETH wallet via
the Highrise web API (`/discord/users/<id>/wallet`) → match that wallet against the
current Creature + LAND holder snapshot → compute the running bracket → create
a session. `GET /api/me` returns the logged-in user's eligibility for the front-end.

Brackets gate *running*, not voting — every eligible holder votes on all four races.
They're defined in [lib/eligibility.js](lib/eligibility.js):

- **1–4 assets** → 2 seats
- **5–14 assets** → 1 seat
- **15+ assets** → 1 seat

That's 4 elected seats; 3 more are appointed for continuity.

**Self-nomination.** `POST /api/application` saves a candidate's draft and submission
(short pitch, questionnaire answers, and a stance per VAA position). `POST
/api/application/derive` optionally drafts those stances from the candidate's own
answers with an AI assistant (OpenAI, strict JSON schema — see
[lib/derive-positions.js](lib/derive-positions.js)); the candidate reviews and edits
every line before submitting. Final submission is gated by `APPLICATIONS_OPEN`.

**Election board.** `GET /api/election` returns the public race snapshot — seats and
candidate counts per bracket — that powers the status board. No auth or wallet needed;
it's the same picture every voter sees.

**Voting Advice Application.** `GET /api/vote` returns the propositions; `POST /api/vote`
takes the voter's stances and ranks candidates by affinity. Matching runs **entirely
server-side** so candidate positions never ship to the browser, and the voter's answers
are never stored or logged. Candidate names and free-text answers stay hidden during the
candidacy phase and are revealed once `VOTING_OPEN` is set.

Required env vars (see `.env`):

- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` — from the Discord developer portal.
- `HIGHRISE_API_KEY` — for the wallet lookup (sent as `X-Api-Key`).
- `SESSION_SECRET` — change from the dev default in production.
- `DATABASE_URL` — Postgres connection string. Railway injects this when a Postgres
  plugin is attached. Without it, the app uses an in-memory store (fine for local dev,
  data lost on restart).
- `APPLICATIONS_OPEN` — gates candidacy submission. Until it's truthy (`1`/`true`/`yes`/`on`),
  the eligibility check and draft-saving stay live but final submission is blocked.
- `VOTING_OPEN` — distinct from `APPLICATIONS_OPEN`. Until it's set, candidates are an
  anonymous preview (pitch + matchable positions only); once set, names and full answers
  go public and the matcher returns live results.
- `OPENAI_API_KEY` — enables AI-assisted position drafting on the self-nomination form.
  Optional; without it the form still works, candidates just fill in stances themselves.
  `OPENAI_MODEL` overrides the default (`gpt-5.4-mini`).
- `ETH_RPC_URL` — optional override for the Ethereum RPC used in per-wallet holdings
  lookups (defaults to a public Blockscout endpoint).

In the Discord developer portal, register these **OAuth2 → Redirects**:

- `https://hcc.highrise.game/api/auth/discord/callback` (production)
- `http://localhost:3000/api/auth/discord/callback` (local dev)

The redirect URI is derived from the request host automatically (so both work);
set `DISCORD_REDIRECT_URI` only if you need to override it.

### Testing eligibility screens locally (no wallet needed)

To exercise every eligibility state without a real wallet/NFT, enable the local
dev-login helper:

1. Copy the template: `cp lib/dev-login.example.js lib/dev-login.js`
   (the active `lib/dev-login.js` is **gitignored** — it is never committed or deployed,
   so this auth bypass cannot exist in production).
2. Set `DEV_LOGIN=1` in `.env` and restart.
3. Visit, e.g.:
   - `…/api/auth/dev-login?user=Whale&creatures=4&land=2` → 5+ bracket
   - `…/api/auth/dev-login?creatures=3` → 2–4 bracket
   - `…/api/auth/dev-login?creatures=1` → single bracket
   - `…/api/auth/dev-login?creatures=0&land=0` → holds nothing
   - `…/api/auth/dev-login?linked=0` → no wallet linked
   - `…/api/auth/dev-login?creatures=2&holders=0` → holder snapshot loading

**Never** create `lib/dev-login.js` or set `DEV_LOGIN` on Railway.

## Railway

Railway can deploy this repo directly. The app listens on `process.env.PORT` and serves `index.html`.

To get the LAND history line in production, add `OPENSEA_API_KEY` to the Railway service's
**Variables** (the local `.env` is gitignored and not deployed). Without it, LAND still shows
its current floor via CoinGecko.
