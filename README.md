# Highrise Creature Club

The official Highrise Creature Club member site — a single hub for the community: the club
overview, live market data, in-wallet trading, holder stats, the roadmap, and the holder-led
**Player Council** and its election. Static front-end (vanilla HTML/CSS/ES modules, no build
step) packaged with a tiny Node server for Railway.

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
A submitted application can be edited (full validation re-runs) until voting begins —
through the candidacy window and the quiet period after it. It always stays submitted —
a draft save can't silently withdraw a candidacy — and it locks once `VOTING_OPEN` is
set, so the field can't shift mid-vote.

**Election board.** `GET /api/election` returns the public race snapshot — seats and
candidate counts per bracket — that powers the status board. No auth or wallet needed;
it's the same picture every voter sees.

**Voting Advice Application.** `GET /api/vote` returns the propositions; `POST /api/vote`
takes the voter's stances and ranks candidates by affinity. Matching runs **entirely
server-side** so candidate positions never ship to the browser, and the voter's answers
are never stored or logged. Candidate names and free-text answers stay hidden during the
candidacy phase and are revealed once `VOTING_OPEN` is set.

**The official ballot.** `GET /api/ballot` returns the voter's races (mode, candidates,
their own ballot if cast); `POST /api/ballot { bracket, choice }` casts a vote. The
published rules, enforced in code:

- **One vote per seat** — a race elects `seats` seats and each voter gets that many
  votes in it (the Member race elects 2, so members pick two candidates; single-seat
  and confirmation races give one). The top `seats` candidates win. Never weighted by
  holdings. Picks are cast one at a time and a candidate can't be picked twice.
- **Each pick is final once cast** — ballot storage is insert-only, one row per pick
  ([lib/db.js](lib/db.js)); the per-race cap and de-dupe are enforced under an advisory
  lock so concurrent submits can't exceed it. A voter can ADD their unused picks later
  but can never change a cast one (a duplicate or over-cap pick gets a 409).
- **Secret ballot.** The voter↔choice row exists only to enforce one-vote-per-race and
  never leaves the server; the audit log records *that* a ballot was cast, never the
  choice; there is no live tally. Each voter gets a private receipt code as proof their
  vote was counted. Only aggregate per-seat tallies are ever published, and only once
  `RESULTS_OPEN` is set.
- **Inclusion verifiability.** With the results, each race publishes its full list of
  receipt codes (codes only — random, sorted, linked to neither voter nor choice).
  A voter finds their own code to confirm their ballot is in the count, and the list's
  length always equals the published turnout. Receipts deliberately do NOT encode the
  choice — a receipt that could prove *how* you voted would invite coercion and
  vote-buying.

**The frozen electorate (continuous-holding rule).** True continuous holding can't be
proven from a single chain read, so it's enforced as **two checkpoints**: set
`VOTER_SNAPSHOT=<label>` and the server captures the current holder set **once** at
startup (bulk holder data unioned with the authoritatively-verified `applicants`
wallets, so indexing gaps can't disenfranchise a real holder). From then on, casting a
ballot requires the voter's wallet to be **in the snapshot AND holding at vote time**
(eligibility is recomputed live on every ballot request — a stale session can't vote
with an emptied wallet). Assets bought after the snapshot can't vote in this election.
Operations notes:

- Capture is idempotent: restarts find the existing snapshot and reuse it; the
  electorate stays frozen. Verify the capture in the deploy logs
  (`[snapshot] '<label>' captured: N holder wallets`) before opening voting.
- **Fail-closed**: while `VOTER_SNAPSHOT` is set but capture hasn't completed,
  ballots are rejected (503) rather than silently skipping the check.
- Transparency: `/api/election` publishes the snapshot's size and capture date
  (never the wallet list), and the board states it under the race cards. Voters not
  in the snapshot see a clear gate explaining the rule instead of a 403.
- A wrongly-excluded holder can be remedied with a manual
  `INSERT INTO voter_snapshots` row — auditable, and far rarer than the union
  capture leaves room for.

**Unopposed races — the confirmation-vote rule.** A race with no more candidates than
seats (e.g. one 15+ candidate for the one 15+ seat) is *not* auto-won. The ballot for
that race becomes **"Seat the candidate(s)" vs "Reopen nominations"**:

- Seat wins a majority of votes cast on that race → seated with a real mandate.
- Reopen wins a **strict majority** (ties favour seating) → that bracket's candidacy
  window reopens once. A new candidate entering turns the re-run into a normal
  contested race; if **nobody new enters by the deadline, the original candidates are
  seated by rule**.

Rejection therefore has to be constructive: the only way to unseat an unopposed
candidate is to field someone who beats them. Since brackets gate running but not
voting, the wider electorate could otherwise veto a small bracket's only candidate at
zero cost — a brigade can force a real contest, but never vote a seat into a vacancy.

Election phases are driven by env flags, in order:

1. `APPLICATIONS_OPEN=1` — candidacy window (the application form accepts submissions).
2. `VOTER_SNAPSHOT=<label>` (with everything else still closed) — freezes the
   electorate; verify the capture count in the logs.
3. `VOTING_OPEN=1` — voting; names go public, ballots can be cast.
4. `RESULTS_OPEN=1` (with `VOTING_OPEN` cleared) — `/api/election` publishes tallies
   and per-race outcomes; the board renders them.
5. If a confirmation race resolved to "reopen": set `REOPENED_BRACKETS=whale` (csv) and
   `REOPEN_DEADLINE=<ISO date>` — that bracket's application window reopens until the
   deadline (everything else stays closed). If new candidates entered, re-run the vote
   with `VOTE_ROUND=2` + `VOTING_OPEN=1` (only reopened brackets are votable in round 2);
   if nobody entered, just re-set `RESULTS_OPEN=1` — the board shows the original
   candidates seated by rule.

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
  go public, the matcher returns live results, and the ballot accepts votes.
- `RESULTS_OPEN` — set after voting closes to publish per-race tallies and outcomes on
  `/api/election`. Aggregates only; never set together with `VOTING_OPEN`.
- `REOPENED_BRACKETS` / `REOPEN_DEADLINE` / `VOTE_ROUND` — the one-time reopen flow for
  a confirmation race that resolved to "reopen nominations" (see above).
- `VOTER_SNAPSHOT` — label of the frozen electorate snapshot (see above). Captured once
  at startup; voting is gated on membership while set. Local testing can seed it with
  `VOTER_SNAPSHOT_SEED=<csv wallets>` (honored only when the gitignored dev-login
  helper is present — inert in production).
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

### Testing the voting screens locally (test wallet + snapshot)

The repo `.env` points at the production database — **don't** run voting experiments
through it. Start the server from a directory without a `.env` so it uses the
in-memory store, and seed the snapshot with the dev wallet:

```powershell
cd $env:TEMP   # any directory without the repo .env
$env:DATABASE_URL=''; $env:DATABASE_PUBLIC_URL=''          # in-memory store
$env:DEV_LOGIN='1'; $env:APPLICATIONS_OPEN='1'; $env:VOTING_OPEN='1'
$env:VOTER_SNAPSHOT='local-test'
$env:VOTER_SNAPSHOT_SEED='0xdev0000000000000000000000000000000000dead'
node d:\hcc-player-council\server.js
```

- `…/api/auth/dev-login?user=Voter&creatures=2` → uses the default dev wallet, which
  is seeded → full ballot renders (submit a candidate first to populate races).
- `…/api/auth/dev-login?user=LateBuyer&creatures=2&wallet=0xdev-late` → wallet not in
  the snapshot → the "not in the voting snapshot" gate screen.
- Add `&icon=https://cdn.highrisegame.com/...` to test candidate avatars end-to-end.

## Railway

Railway can deploy this repo directly. The app listens on `process.env.PORT` and serves `index.html`.

To get the LAND history line in production, add `OPENSEA_API_KEY` to the Railway service's
**Variables** (the local `.env` is gitignored and not deployed). Without it, LAND still shows
its current floor via CoinGecko.
