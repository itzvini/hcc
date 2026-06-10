# Creature Rental Escrow — Design Spec (v0.1, not yet built)

Status: **DESIGN ONLY — no contract written or deployed.** This document exists to
judge cost/benefit concretely and to scope an audit before any Solidity is written.

## 1. Problem & goal

Renting Creatures is common in the community, but today it requires account sharing
(linking the owner's wallet inside the renter's Highrise account) — an account-compromise
vector with zero guarantees for either side.

**Goal:** trustless rentals where the renter holds the Creature **in their own wallet**
(so their own linked Highrise account legitimately receives perks) and the owner is
always made whole — either the Creature comes back, or they keep collateral worth more
than it.

**Non-goals (v1):** rental extensions, partial refunds, auctions/bidding on rentals,
ERC-1155 support, cross-collection support (Creatures only), upgradeability.

## 2. Mechanism in one paragraph

The owner lists a Creature for rent with three parameters: `fee` (what the renter pays,
non-refundable), `collateral` (what the renter must lock), and `duration`. To rent, the
renter pays `fee + collateral` in one transaction; the fee streams to the owner
immediately, the collateral locks in the contract, and the Creature transfers **to the
renter's wallet**. Before `expiry = rentedAt + duration`, the renter returns the Creature
to reclaim the full collateral. After expiry, if the Creature hasn't been returned, the
owner may claim the collateral instead (no deadline on claiming). The contract never
needs to force the NFT back — economics do the enforcing.

Payments use the same ERC-20 ETH token as the marketplace
(`0x52a6c53869ce09a731cd772f245b97a4401d3348` on Immutable zkEVM), so collateral is
denominated in the same asset Creatures are priced in.

## 3. The economic fine print (owners MUST understand this)

A collateralized rental is, mechanically, **selling the renter an American call option
with strike = collateral**: if the Creature's market value rises above the collateral
during the rental, a rational renter keeps the Creature and forfeits the collateral —
a forced sale at the collateral price. This is not an attack; it is the design.

Consequences:
- The UI must default and strongly recommend `collateral ≥ 120–150% of current floor`,
  re-quoted live at listing time.
- Owners of rare/high-trait Creatures must set collateral against *their* Creature's
  value, not the floor. The UI should warn when the token's rarity is above the
  collection median.
- Long durations widen the option window. v1 caps duration at **30 days**.
- The listing UI must show the owner a plain-language line: *"If the renter never
  returns it, you keep the {collateral}. Only list if you'd be happy with that trade."*

## 4. Actors & flows

### 4.1 List for rent (owner)
1. One-time `setApprovalForAll(rentalContract, true)` on the Creature contract.
2. `listForRent(tokenId, fee, collateral, duration)` — Creature stays in the owner's
   wallet until rented (it remains usable in-game while listed).
3. Owner may `cancelListing(tokenId)` anytime before it's rented.
4. Listing is invalidated automatically if the owner transfers/sells the Creature
   (contract checks `ownerOf` at rent time).

### 4.2 Rent (renter)
1. One-time ERC-20 approval for `fee + collateral`.
2. `rent(tokenId)` — atomically: pulls `fee + collateral`; sends `fee` to owner;
   escrows `collateral`; transfers Creature owner → renter (requires the owner's
   standing approval; reverts if the owner moved the token or revoked).
3. Renter links nothing anywhere — their own wallet now holds the Creature; Highrise
   perks follow automatically.

### 4.3 Return (renter, any time before or after expiry — until owner claims)
1. One-time `setApprovalForAll(rentalContract, true)` by the renter (or direct
   `safeTransferFrom` into `returnCreature(tokenId)` via `onERC721Received`).
2. `returnCreature(tokenId)` — Creature goes back to the owner, full collateral back
   to the renter. Fee is not refunded, even on early return (v1 simplicity).

### 4.4 Default (owner, after expiry)
1. `claimCollateral(tokenId)` — pays the owner the collateral, closes the rental.
   No deadline: an offline owner loses nothing by claiming late.
2. Race handling: between expiry and the owner's claim, a late `returnCreature` is
   still honored (return beats claim if it lands first — both sides are made whole
   either way, so ordering is not exploitable beyond ordinary tx racing).

### 4.5 State machine per token
`NONE → LISTED → RENTED → (RETURNED | DEFAULTED) → NONE` (re-listable after close).
One active rental per tokenId. No state allows both NFT-out and collateral-out.

## 5. Contract interface (target)

```solidity
struct Listing  { address owner; uint96 fee; uint96 collateral; uint32 duration; }
struct Rental   { address owner; address renter; uint96 collateral; uint40 expiry; }

function listForRent(uint256 tokenId, uint96 fee, uint96 collateral, uint32 duration) external;
function cancelListing(uint256 tokenId) external;
function rent(uint256 tokenId) external;                 // pulls fee+collateral (ERC20)
function returnCreature(uint256 tokenId) external;       // renter → owner, collateral back
function claimCollateral(uint256 tokenId) external;      // owner, post-expiry only

event Listed(uint256 indexed tokenId, address indexed owner, uint96 fee, uint96 collateral, uint32 duration);
event ListingCancelled(uint256 indexed tokenId);
event Rented(uint256 indexed tokenId, address indexed renter, uint40 expiry);
event Returned(uint256 indexed tokenId);
event Defaulted(uint256 indexed tokenId);
```

Constraints baked in: `CREATURE` and `PAYTOKEN` are immutable constructor params;
no admin role, no pause, no upgradeability, no fee switch (0% marketplace fee — the
contract has no owner at all). Duration: `1 hours ≤ duration ≤ 30 days`. `fee` may be
0 (friend lends); `collateral` must be > 0.

## 6. Threat model & mitigations

| Threat | Mitigation |
|---|---|
| Renter never returns | By design: owner keeps collateral (price the option, §3). |
| Floor pumps above collateral | Same as above — disclosed, owner-priced buffer. |
| Reentrancy on ERC-20/721 callbacks | Checks-effects-interactions + reentrancy guard; the pay token is a known standard ERC-20 (no hooks), NFT uses `safeTransferFrom` last. |
| Owner lists, then sells/moves the token | `rent()` re-checks `ownerOf(tokenId) == listing.owner` and reverts cleanly. |
| Owner revokes approval after listing | Same revert path; listing shown as "stale" in UI via a view call. |
| Fake/duplicate listings off-chain | All listing state is on-chain; the site reads the contract, never a DB. |
| Stuck states | Every state has exactly one exit per actor; no third-party or admin needed; no deadline on owner claim. |
| Griefing by dust collateral | Floor-aware UI warnings; the contract itself stays neutral (owner's choice). |
| Timestamp manipulation | Expiry granularity is hours–days; sequencer drift of seconds is immaterial. |

Residual risks (accepted, must be in the UI's plain-language terms):
- This is the project's **first custom contract** — a new class of risk vs. everything
  built so far (which rides on Immutable/Seaport's audited contracts only).
- Smart-contract bug risk concentrates in ~150 lines; mitigated by audit (§8), not eliminated.
- No dispute process by design — code is the settlement.

## 7. Marketplace integration (site side)

- **Server:** read-only — index `Listed/Rented/Returned/Defaulted` events via the zkEVM
  RPC (same pattern as existing holders/orderbook code) for a `GET /api/market/creatures/rentals`
  browse endpoint; no signing, no custody, consistent with the existing trust model.
- **Client:** a "Rent" tab beside Buy/Sell/Transfer. All four contract calls are simple
  single-arg functions — calldata is hand-encodable exactly like the existing
  `safeTransferFrom` flow (no new libraries). Reuse: staged status UI, error taxonomy,
  pre-flight balance checks (`fee+collateral` vs ERC-20 balance), live countdown chips
  on active rentals (reuse bridge-ticker pattern), persistent "rental ending soon"
  reminders (reuse bridge persistence pattern).
- **i18n:** all new copy through `t()` as usual.

## 8. Audit & deployment plan

1. Write contract + exhaustive unit/invariant tests (Foundry; invariants: no state where
   both NFT and collateral can leave; conservation of funds; single-rental-per-token).
2. Deploy to **Immutable zkEVM testnet**; run the full UI against it with test wallets.
3. **External audit** of the ~150-line contract (small scope: days, not weeks —
   budget roughly $5–15k at typical boutique rates, or Immutable's ecosystem
   audit partners may discount).
4. Community beta with a per-token collateral cap (UI-enforced) for the first weeks.
5. Mainnet deploy is **final** (no upgradeability) — any fix means a new contract and
   a migration banner. This is a feature (trustlessness), priced in.

## 9. Open questions (owner decisions)

1. Fee model: flat per rental (spec'd) vs per-day pro-rata? (Flat is simpler; per-day
   invites partial-refund complexity — recommend flat for v1.)
2. Should the UI enforce a minimum collateral (e.g. ≥ 100% of live floor) or only warn?
   (Contract stays neutral either way.)
3. Renew/extend in v2: renter pays another fee to push expiry before it lapses?
4. Does Pocket Worlds' perk system have any cooldown on wallet holdings changes that
   would affect rental UX? (e.g. perks granted only after N hours of holding.)

## 10. Relationship to the delegation path (Option B)

This spec serves renters **with capital** (collateral ≥ value). It does not serve the
"can't afford to buy" renter — only game-side delegation support (delegate.xyz /
ERC-4907 in Gen 2) does that, with zero collateral and zero asset movement. The two
are complementary; shipping this does not reduce the case for delegation.
