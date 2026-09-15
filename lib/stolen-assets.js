// Stolen-asset blocklist — LAND taken from the highrise.vault treasury account.
//
// Between 18 July and 11 September 2026 four wallets withdrew 229 parcels belonging to the
// company treasury account onto Ethereum and sold them into standing collection bids. The
// mint route itself was legitimate (HighriseLandWithdrawal.withdraw, signed by Highrise's
// own backend) — the compromise was of the game ACCOUNT, not of any contract. See the
// incident report for the full chain of custody.
//
// What this file does: keeps the parcels still sitting in those wallets, and any future
// listing by those wallets, off this marketplace. It is a REFUSAL TO BROKER, nothing more.
// We cannot freeze an ERC-721 and we do not try to. The parcels remain tradeable on any
// other venue until OpenSea acts on the same list.
//
// Deliberately NOT filtered:
//   - Sales history and transfer feeds. Those are the factual record of what happened and
//     the evidence trail; censoring them would hide the theft, not the thief.
//   - The 163 parcels already sold on. Those buyers paid market price in good faith and are
//     not party to this. Blocking them would punish the wrong people.
//
// Maintenance: TOKENS is a snapshot verified with ownerOf() at the block noted below. If a
// blocked wallet moves a parcel, the parcel stops being "held by a thief" but stays stolen,
// so entries are never removed on a transfer — only when the parcel is recovered or the
// claim is formally dropped. WALLETS is the durable half: it blocks anything those
// addresses list in future, including the other 163 should they ever come back.

'use strict';

// The four wallets. Every one is linked to the others on-chain by direct funding.
const WALLETS = new Set([
  '0xb95f897f3c229ba2dd0cab3b3a68e0ba60ec8333', // w1 — 56 minted 2026-07-18, all sold
  '0x55a41a230ebeae3542ae56f2dbea6676cb96bcd5', // w2 — 78 minted 2026-07-18, 17 held
  '0xb9cc629127220ec2fdadd0699e255fac9f62833e', // w3 — 31 minted 2026-07-19, 3 held
  '0xf32f95a14b968f70be7e619d4b27c1d59ef035d1', // w4 — 64 minted 2026-09-11, 46 held
]);

// Parcels still in those wallets. Verified with ownerOf() on 2026-09-15; all 66 confirmed.
const TOKENS = new Set([
  // w2 0x55a41a230ebeae3542ae56f2dbea6676cb96bcd5 — 17 parcels
  '12386508', '13435069', '13435074', '13435075', '13435077', '13435079',
  '13500604', '13500608', '13500616', '13566144', '13566152', '9961606',
  '9961639', '9961641', '9961642', '9961643', '9961646',
  // w3 0xb9cc629127220ec2fdadd0699e255fac9f62833e — 3 parcels
  '13959368', '14024903', '14614727',
  // w4 0xf32f95a14b968f70be7e619d4b27c1d59ef035d1 — 46 parcels
  '10027155', '10027158', '10027165', '10027178', '10027181', '10027184',
  '10551476', '10551487', '10551488', '10551491', '10551493', '10551496',
  '10551497', '10551498', '10551499', '10551500', '10551501', '10616978',
  '10616980', '10616982', '10617017', '10617018', '10617022', '10617031',
  '9109701', '9109702', '9109706', '9109709', '9175196', '9175213',
  '9175214', '9175215', '9175219', '9175220', '9175221', '9175222',
  '9175225', '9175228', '9765059', '9765060', '9830551', '9830552',
  '9830554', '9830598', '9961637', '9961672',
]);

const norm = v => String(v == null ? '' : v).trim().toLowerCase();

// A wallet on the list. Used to drop its listings and to refuse to prepare a trade with it.
const isBlockedWallet = addr => WALLETS.has(norm(addr));

// A parcel on the list. Token ids arrive as decimal strings, numbers or BigInts depending on
// which feed they came from, so normalise through BigInt rather than trusting the shape.
function isBlockedToken(tokenId) {
  if (tokenId == null || tokenId === '') return false;
  let dec;
  try { dec = BigInt(tokenId).toString(); } catch { return false; }
  return TOKENS.has(dec);
}

// Either half matches → don't broker it.
const isBlocked = ({ tokenId, wallet } = {}) => isBlockedToken(tokenId) || isBlockedWallet(wallet);

// Shown to anyone who deep-links a blocked parcel. Plain, factual, no accusation of the
// current viewer — they may be a buyer who found it through a search engine.
const BLOCK_NOTICE = 'This parcel was taken from a Highrise treasury account and is under '
  + 'investigation. It can\'t be bought or sold here.';

module.exports = {
  isBlocked, isBlockedToken, isBlockedWallet, BLOCK_NOTICE,
  blockedWallets: () => [...WALLETS],
  blockedTokens: () => [...TOKENS],
  counts: () => ({ wallets: WALLETS.size, tokens: TOKENS.size }),
};
