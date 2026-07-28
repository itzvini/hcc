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
TRANSAK_API_KEY=your_transak_publishable_key
```

`SQUID_INTEGRATOR_ID` (optional) powers the Trade tab's one-tap, exact-amount ETH
bridge quotes (Ethereum → Immutable zkEVM) via the [Squid Router API](https://docs.squidrouter.com).
Get one free from Squid's integrator portal. Without it, the funds helper falls back
to a prefilled Squid deep-link — everything else works unchanged. Like all secrets it
lives only in `.env` locally and in Railway **Variables** in production.

The "Buy with card" on-ramp (card / Apple Pay / Google Pay) mints a **session URL server-side**
at `/api/market/onramp` — Transak deprecated query-param widget URLs in mid-2026, so the widget
loads only with a session minted via a backend call. We mint through **Immutable's hosted
checkout** (`api.immutable.com/checkout/v1/widget-url`, the same call Immutable's toolkit on-ramp
makes), which rides **Immutable's own Transak account** (public key fetched from
`checkout-api.immutable.com/v1/config`) — so it needs **no Transak credentials of ours**. The URL
is single-use, expires in ~5 min, minted **on click**, with the **network + token pinned** and the
buy **amount prefilled** in USD (grossed up for Transak's ~3.5–5.5% fee). Routing reflects what
each network can actually deliver:

- **Gas (IMX)** → network `immutablezkevm`, delivered **natively to Immutable zkEVM**.
- **Price (ETH)** → network `ethereum`, delivered to **Ethereum**. Transak has **no fiat→zkEVM-ETH
  product** (a live $20 test order delivered ETH to L1), so for **Creatures** the buyer then
  **bridges** the ETH to zkEVM via the in-panel bridge (the prefill includes a bridge/L1-gas
  buffer); **LAND** is bought directly on Ethereum, no bridge.

If a mint fails, the client falls back: zkEVM/IMX → Immutable's keyless hosted page
([toolkit.immutable.com/onramp](https://toolkit.immutable.com/onramp/)); Ethereum/ETH → CTA hidden.

> **Note:** the `TRANSAK_*` env vars and the `transak*` helpers in `server.js` are an inactive
> alternate path (minting through *our own* Transak partner account instead of Immutable's). It's
> not used — our account's session API returns `401 errorCode 1002` pending Transak's activation /
> backend-IP allowlisting (on Railway that needs a static egress IP). Kept for if we later want our
> own account for fee capture; ignore for normal operation.

Without key+secret, the **LAND** card CTA is hidden and **Creatures** fall back to Immutable's
keyless hosted on-ramp ([toolkit.immutable.com/onramp](https://toolkit.immutable.com/onramp/)) —
which can't pin the network, so the buyer must pick Immutable zkEVM themselves.

## Collections (the release archive)

The **Collections** tab (`/collections`) is the club's full back catalogue: 104 releases
and 1,174 items, oldest to newest, on a year-by-year timeline. Each release card opens
into a grid of its items with their in-game art, rarity and copy counts. You can filter
by type (drops, grabs, Creature Store, events, giveaways, collabs), search across item and
release names, and flip the order.

A collapsed card carries a preview strip of up to seven items, rarest first and then by
how widely they were handed out, with a `+N` chip for the rest. The build picks them by
row index (`hero` in the JSON) from the items that resolve to a picture, so every release
gets a strip, and cuts each one a small thumbnail of its own (see below).

Clicking any item (in the grid or on a card's preview strip) opens it in a floating
inspect card: the item blown up, its rarity, slot, copy count and release, and the whole
avatar render for context. Arrow keys walk the rest of the release, Escape closes.

Two things feed it, and only one of them is in the repo:

- `collections.json` (~149 KB) — the release and item data, served static
- the `collection_art` table in Postgres — every item's picture, 1,587 rows, 25.0 MB

**No item art is committed.** The repo used to carry 561 files and 6.9 MB under
`img/collections/`; those bytes now live in the database and reach the browser through
`/api/collections/art/<variant>/<art_id>.webp`. That also closed the last id leak: an
`art_id` is a hash of the picture's own bytes, so nothing in the repo or on the page names
a Highrise item. See "About the item art" below for what this costs and what it buys.

Everything that makes those two lives in `tools/`, which is **gitignored**: the build
script, the workbook-derived maps, the asset-portal art, and the render cache. None of it
is needed to run or deploy the site.

Keep a copy of `tools/` wherever you build from. To regenerate:

```bash
pip install openpyxl pillow numpy psycopg2-binary
python tools/build-collections.py path/to/hcc_items_release_matching.xlsx
```

That reads a database URL from `COLLECTIONS_DATABASE_URL`, `DATABASE_PUBLIC_URL` or
`DATABASE_URL` (environment first, then the gitignored `.env`) and loads the pictures
straight in. Rerun it when new releases ship, then commit the regenerated JSON.
`--skip-art` builds the JSON alone and touches no database, which leaves every item
showing a placeholder. `--refresh-art` re-encodes and reloads everything.

**Rows the archive leaves out.** Two separate filters.

The build drops 59 catalogue rows that aren't really separate items to browse: `hair_back`
entries (34, each rendering identically to its `hair_front` twin), pet body parts (18 — a
pet species' own ears, eyes, tail and wings, spotted by the doubled `pet_pet` marker in the
disp_id, so pet *clothing* in the same slot is kept), unnamed entries whose name is nothing
but dashes, and `Fake Inverted Fangs`.

It also drops content that isn't the club's, on holder feedback (July 2026). The workbook
flags an item HCC when Tom authored it, which is not the same as club-exclusive, and five
releases were ordinary public ones: Ectoplasm Collection, Whispering Spirits Chase,
Moonlight Phantoms Chase, Halloween Wolf Grab and Tom's Mouth. See `DROP_RELEASES` in the
build for the list.

Earth Day Drop was nearly cut down the same way and then kept whole. The first read was
that its high-copy items were a public tip-war payout; a correction came back saying the
tip-war pieces were in fact the one-of-a-kind and three-made ones, and that keeping them on
the page was fine. So all 88 items stay and the card carries a note instead.

Release item counts, rarity mixes and copy totals are all summed over what survives, so the
numbers on a card match what it lists. Note they are copies *minted*, not sold: a giveaway
of 3,000 and a store sale of 3,000 look identical here.

**About the item art.** Every picture is served by us, out of `collection_art`, at
`/api/collections/art/<variant>/<art_id>.webp`. Two variants share one id:

- **`full`** is the whole render at its native size, usually 600x800. The item grid crops
  it to the item with a CSS window; the inspect card shows it both ways.
- **`thumb`** is a 104px square, cropped to the item when it was encoded, for the 52px
  boxes in a collapsed card's strip. 478 items need one, the ones a strip can show.

`art_id` is a SHA-1 of the source bytes, first 16 hex. Content-addressed does three jobs:
the URL names nothing, two items with identical art share a row, and because the bytes
behind an id can never change the serve route sends `immutable` with a year of
`max-age`. That is the one exception to the caching policy in
[.claude/CLAUDE.md](.claude/CLAUDE.md), and it is safe for exactly the reason the policy
forbids it elsewhere: these URLs really are fingerprinted.

**Why WebP at native size.** The Highrise CDN only serves PNG, averaging 93 KB. Re-encoded
at quality 88 the same 600x800 render is **21 KB**, so shrinking it buys almost nothing
(512px only saves another 2.5 KB) and full detail is kept for the inspect card. Thumbnails
are quality 82 and average 3.2 KB.

What that adds up to, measured in a browser against the same pages:

| | before, off the Highrise CDN | now, from Postgres |
|---|---|---|
| glance at the page | 4.73 MB | **192 KB** |
| scroll all 102 cards | 44.3 MB | **1.45 MB** |
| open a 56-item grab | 5.07 MB | **1.15 MB** |
| repeat visit | revalidates every picture | **0 bytes**, straight from cache |

All of it verified in a browser against the real database, including the last row: on a
revisit or a reload every picture comes back with `transferSize: 0`.

**Latency, not just bytes.** The one thing this design gives up is edge delivery: a first
visitor now waits on our origin instead of a CDN. `getCollectionArt()` keeps what it has
read in a bounded in-process cache (48 MB, comfortably the whole table), which is safe
precisely because an id names fixed bytes. Measured on a 56-item grid, 42 tiles in view:
cold, 8s to fill; with the pictures already in the server's memory, under 1s. Locally the
cold figure is inflated because every read crosses the public proxy to Railway; in
production the app and Postgres share the private network. If first-paint latency ever
matters more than this, a CDN in front of the domain is the fix, not a change here.

So the tab is lighter than it ever was on the CDN, grids included. Two trades. Those bytes
are now our egress rather than Highrise's. And **Collections needs Postgres**: with no
database the timeline, stats, search and filters all still work off the JSON, but every
tile shows its placeholder and the browser logs a 404 per picture.

**Where the pictures come from.** The build encodes one source per item, in this order:

- `tools/item-art/<disp_id>.png`/`.webp` when present, used uncropped and ahead of
  everything else. 35 items that aren't on the public CDN come from the asset portal's
  `avataritem/front/<disp_id>.png`, plus 6 sets and the Ignition Boost emote icon. These
  need the session cookie the HighriseHelper bot keeps in its `prod_api_settings` table,
  which is why they sit in `tools/` rather than being fetched at build time.
  `--extra-images DIR` points elsewhere.
- the workbook preview, for the 13 furniture pieces and the room decal. Nothing wears
  those, so no avatar render of them exists.
- otherwise `cdn.highrisegame.com/avatar/<disp_id>.png`, fetched once per item and kept in
  `tools/render-cache/` so later rebuilds ask for nothing. One request each, no retries; a
  failure becomes a warning and that item shows a placeholder until the build is rerun.
  Reruns are cheap because the cache holds everything already fetched.

**Crop windows.** 1,153 of the items carry a crop window (`b` in the JSON) framing just
the item, so the grid can zoom past the mannequin; the inspect card still shows the whole
render below it. `zoomStyle()` reads a window as fractions of its frame and scales one
axis only, leaving the other `auto`, so the image keeps its own aspect and no render can
come out stretched however large it arrives.

A window still only means something in the frame it was measured in, and 14 of the
renders Highrise serves come back trimmed instead of 600x800 — some to the item alone, one
to the avatar (298x783). Each is trimmed differently, so there is nothing to map.
`checkFrame()` compares the loaded shape against the frame the window names and, if they
disagree, drops the zoom and shows the picture whole. That guard now only matters for the
grid and the inspect card: strip thumbnails are cropped when they are encoded, against the
real pixels, so the one trimmed render that used to show a small avatar in the strip is a
proper close-up.

Most come from differencing a render against its category's median render, measured on the
workbook preview. That only works where the preview shares the render's 3:4 shape — the
workbook trimmed about 100 of them to odd shapes (32x90, 90x90, ...), and a window measured
on one of those maps nowhere on the render and stretches it badly. Those are skipped.

Face, neck, hat and hair windows are fixed fractions rather than measured, so they are
stated against the 600x800 render directly and keep working for the odd-shaped ones. The
head window itself is measured: across face-slot renders the head sits at x 17-48, y 1-36
of a 67x90 frame, padded out to a square. It has to reach the very top — starting even 2%
down clips the crown, which reads as the head being squashed vertically.

The only items with no window are the three whose bundled art is already the item alone.

**Releases the workbook doesn't have.** The workbook only exports items already matched
to a release, so a club item it never matched simply isn't there. `EXTRA_RELEASES` in the
build declares those by hand. Two so far, the Krampus Snugglin eggs: **Krampi** (Creature
Store, 50,000 Creature Coins) and **Krambi** (member giveaway). The catalogue marks both
"Creature Club Exclusive Item", which is what settled that they belong here.

Their dates come from the first four bytes of each archetype's ObjectId, which is its mint
time, so they carry `approx` precision for the same reason the workbook's median dates do:
that is when the item was made, not necessarily the day it went out. Art is staged in
`tools/item-art/` under the egg's `disp_id` like any other replacement picture, pulled from
`cdn.highrisegame.com/container/<disp_id>/full` — a different path from the `/avatar/` one
worn items use, and the only place these eggs have a picture. A missing staged file is
reported as a warning rather than shipping a placeholder silently.

The eggs sit in a `container` category, which is in `NOT_WORN_SLOTS` (and `NOT_WORN` on the
client) so nothing tries to find an avatar render for them, and reads as "Egg" on the card.
Each release also lists the snugglin the egg hatches, in a `pet` category (also not-worn,
reads as "Snugglin"), first in the list so it takes the hero thumbnail.

**The pet giveaways.** The club handed members a one-off pet eleven times between July 2023
and February 2026 — three slimes on `pet_slime_legendary`, two more on `pet_slime`, and six
bunnies on `pet_bunny_mythical`. None of them has a catalogue release row, so each is an
`EXTRA_RELEASES` entry built by the `pet_giveaway()` helper: one `pet` item and the rarity
from its archetype. Dates are read off the giveaway bot's own posts, so they are `exact`
rather than `approx` and every one wears the Announced badge. No note either — the card's
picture says what the creature is better than a sentence would.

Finding a pet's parts takes one look at the admin panel and no API access. Its character
page lists the traits, and one trait id gives away the whole set, because the family shares
a naming pattern: `body-pet_petbunny2024<slot><suffix>` for the bunnies,
`body-pet_<slot><datecode>` for the slimes. The rest come from probing that pattern against
the public CDN, where a wrong guess just 404s. The slot vocabulary across every pet here is
`body ears eyes mouth nose blush tail wings hat freckle` for bunnies and
`base eye mouth antenna` for slimes. Two of them hide something: a third eye ships as
`freckle`, and a unicorn horn ships as `antenna`.

**Composing the pets.** No pet has a picture anywhere upstream: the archetype rows carry no
`image_url`, `thumbnail_url` or `icon_url`, and no render endpoint applies a pet's own skin
— ask one for a snugglin and you get a peach avatar. So they are composed from their own
part assets, the same way the game does it and the same algorithm
[lib/land-pets.js](lib/land-pets.js) already uses for LAND's slimes:

1. Each part is a zip on the public avatar CDN, `/avatar/<item_id>.zip`. Inside, every
   `front-<item_id>-<Layer>.vec` entry is a plain SVG carrying its own bounds in a leading
   fixed-width comment.
2. Stack the layers in rig order and union the bounds. Order is keyed on the layer name
   (the rig slot: `Head`, `CoreBody`, `EarLeft`, `Tail`, `HatUpper`, …), not on the item id
   — a pet part fills several slots at once, unlike a slime part, which is why
   `lib/land-pets.js` can get away with keying off the id and this can't. Three rigs, three
   orders:
   * **plushie** (snugglins) — `CoreBody` sits *above* the torso: it is where the HCC badge
     and the keepsake pin go.
   * **bunny** — far-side limbs behind the body, near-side in front. The art says which is
     which, since every `Right*` layer is shaded darker than its `Left*` twin. Headwear
     (`HatUpper` / `BagUpper`) is a left-right pair on top of the head, not a front-back one.
   * **slime** — body, face, then whatever sits on top.
3. Skip the alternate animation frames shipped alongside the idle ones (`*Closed` blink
   frames, `HappyMouth`, `SadMouth`).
4. Recolour, but only the snugglins. Every bunny and slime here reports Active Palette 0 in
   the admin panel, so for those the default palette baked into the art *is* the final look
   and nothing is remapped. The snugglins are the exception: their art ships peach-furred
   with blue eyes and the palette a real one applies isn't in any source available here.
   Three source ramps map to three targets:
   * **fur** (the peach ramp's light and mid tones) → near-black, per both eggs.
   * **accent** (the same ramp's dark browns) → crimson for Krampi, pink for Krambi. These
     are not fur: they are the horns, hooves, tongue, blush rings and eye rims, which the
     reference art the community circulated shows in the pet's accent colour. Anchored on
     each pet's own baked trio — the keepsake and teddy already bake `5E1123`/`7A233A`/
     `C13A5E` and `E35D93`/`E679A5`/`F299C2`.
   * **eye/halo** → the two colours the pet's own colorpatch bakes, plus a near-white tip.

   Splitting fur from accent matters twice over. Mapping one ramp across both zones turned
   the horns and tongue black, and it stretched the range so the body's dominant `B56551`
   landed mid-ramp and came out charcoal instead of black. `9E4733` is the one hex that
   straddles them; it stays with the fur, because it shades the ear insides and tail tip
   where the difference shows, and a dark rim reads the same as a black one on black fur.

So every pet here is exact official art except the snugglins' three reconstructed ramps.
Nothing carries a crop window: the card shows each pet whole.

Bluluvey is the one pet that skips all of this: it ships as a single flat SVG under
[assets/pets/](assets/pets/) rather than as separate parts, so it is rasterised as-is.

**Release notes.** `RELEASE_NOTES` in the build attaches a short editorial note to a
release, rendered as a framed aside under the card's quote (`.col-annot`). It exists for
context the catalogue cannot carry: Earth Day Drop's rarest pieces came out of a charity
tip war rather than a club release, which no column in the workbook records. The label is
`t('col.annot')`, just "Note" — a note carries no byline, so nobody is on the hook for an
editorial call. The text itself is not translated, same as `quote`, since both are specific
to one release.

Mind the class name: `.col-note` was already taken by the approx-date fineprint, and reusing
it wrapped that in a border and a background on all 49 approx-dated cards. Hence `.col-annot`.

**Sets.** `tools/item-sets.json` maps a set's `disp_id` to the `disp_id`s it contains,
and that membership overrides the workbook's `release_name`. It has to: the Year Four
recolours were all filed under the Whiteout release even though each colourway shipped as
its own set, so without it the pink, blue and red items sat in the wrong place. Rebuilding
regroups 38 rows. Set art comes from the set record's `image_url` on CloudFront and lives
in `tools/item-art/` with the rest. Override with `--item-sets FILE`.

To refresh it after a new set ships, ask the asset portal for
`{"_type": "GetItemRequest", "disp_id": "<set disp_id>"}` and read `clothing[].item_id`
and `image_url` off the reply. Like the rest of `tools/`, the file is local only.

**What the JSON deliberately leaves out.** The inspect card used to carry a "View on
Highrise" link, which meant shipping every item's Highrise catalogue id: over 1,200 internal
ids in a public repo, as a bulk machine-readable index. Both the link and the ids are gone,
which took the JSON from 227 KB to 189 KB.

`disp_id` (`d`) is still there, because it is the only way to name an item's picture:
`cdn.highrisegame.com/avatar/<disp_id>.png` for the grid and inspect card, and the
thumbnail filenames. Removing it would mean serving every render from here instead, which
is 15 MB or more of committed art, or proxying the CDN through the server. Note the id is
already visible in each of those image URLs either way.

**About the dates.** Only 20 releases carry a posted release date, and the announcements
channel doesn't go back past March 2023. The build fills the gaps from the club's gift log
(a real dated distribution event) and, failing that, from when the items were authored.
Worked-out dates render as a month with a `~` marker and say so on the card, so the
timeline never shows a guessed date as a known one. The build also reports anything
suspicious — re-gifts of older sets, and releases whose date disagrees with the year in
their own name — so you can check those against the announcements.

## Market data

The **Market** tab shows floor prices and weekly sale-price history for Creatures and LAND.

- **Creatures** — floor + sale history from the Immutable zkEVM API (no key required).
- **LAND** — floor + 30-day stats + sale history from OpenSea when `OPENSEA_API_KEY` is set.
  Without a key it falls back to CoinGecko for the current floor only (no history line).

All data is fetched server-side and cached for 30 minutes (`/api/market`), so no
database is needed — history is recomputed from on-chain/marketplace sales each refresh.

## Apply & Vote (the First Election)

The **Council › Apply & Vote** sub-tab (`/council/vote` — the old `/apply` links
redirect there) runs the Council's first election end-to-end: a holder signs
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

## Polls & Votes (official community polls)

The **Polls & Votes** tab (`/polls`) hosts official club-wide votes — decisions the
Council sends to every holder rather than deciding in the room (the first: the Gen 2
ship order). Same trust chain as the election ballot: Discord sign-in → Highrise-linked
wallet → live holder check. One holder, one vote — enforced per Discord account *and*
per wallet — insert-only with a private receipt code; per-option tallies and the full
receipt list are published only after the poll closes.

- **Definitions** live in [lib/polls.js](lib/polls.js) (id, i18n key, option ids).
  Copy lives in the locales under `polls.p.<key>.*` — the API never ships display text.
- **Scheduling** is env-driven, no redeploy needed: e.g. `POLL_GEN2_OPENS` /
  `POLL_GEN2_CLOSES` (ISO timestamps). Unset opens-at → the poll shows as "opens soon";
  unset closes-at → open-ended until the env is set.
- **API**: `GET /api/polls` (viewer context + polls; results once closed),
  `POST /api/polls/vote` `{ poll, choice }` (401 signed-out, 403 non-holder/closed,
  409 already-voted).
- **Local testing**: use the in-memory recipe above with
  `$env:POLL_GEN2_OPENS='2026-01-01T00:00:00Z'` to force the poll open, then
  dev-login as a holder and vote. Set `POLL_GEN2_CLOSES` in the past to see results.

## Railway

Railway can deploy this repo directly. The app listens on `process.env.PORT` and serves `index.html`.

To get the LAND history line in production, add `OPENSEA_API_KEY` to the Railway service's
**Variables** (the local `.env` is gitignored and not deployed). Without it, LAND still shows
its current floor via CoinGecko.
