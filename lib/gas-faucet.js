'use strict';

// Gas assist — we pay a member's zkEVM gas so owning a Creature never means being stuck
// with it.
//
// Why this exists: IMX is the native gas coin on Immutable zkEVM, so every action needs a
// little of it. A holder with no IMX and no ETH can't sell, can't transfer, can't even
// gift their Creature, and the cheapest way to acquire IMX from scratch runs about $30
// through a card on-ramp. Measured on-chain, the gas they actually need is worth about
// $0.0001 for a transfer and $0.0006 for a purchase. Asking someone to spend $30 to
// unlock $0.0006 of gas is the whole problem. Credit to Sam (@Community on HR), who
// built the first version of this for HCC middlemen and suggested we run one too.
//
// Sizing, from real transactions on our own contract (August 2026):
//   transfer  safeTransferFrom                 0.0005 - 0.0007 IMX
//   buy       fulfillAvailableAdvancedOrders   0.004 IMX average, 0.016 IMX worst seen
// So a 0.01 IMX grant would NOT reliably cover one purchase. The default target is
// 0.02 IMX (~$0.003): roughly 5 buys or 30 transfers. That still clears the worst buy we
// have measured, but only just — if grants start running out mid-trade, this number is
// the first thing to raise.
//
// Cost ceiling: at 0.02 IMX per wallet, paying every one of the ~5,300 Creature-holding
// wallets that exists comes to ~106 IMX, about $17. Cost is not the risk here. The risks
// are the hot wallet and the compliance posture, which is why:
//
//   • This is the only module that spends. It can only send native IMX to an address
//     (see lib/zk-tx.js — it cannot call a contract at all).
//   • It pays the wallet the member has CONNECTED, which is the wallet that actually
//     needs the gas. That wallet proves nothing about who they are, so it isn't asked to:
//     the claim is bound to the Creature instead. Every Creature in the paid wallet is
//     spent permanently, and the Discord account and Highrise account behind the session
//     each get exactly one claim, for good. Swapping wallets buys nothing, and neither
//     does selling or moving the Creatures, because the lock follows the token.
//   • Every destination is screened against the OFAC SDN list first (lib/sanctions.js),
//     and a screen we can't complete refuses the payment.
//   • It is OFF unless GAS_FAUCET_ENABLED=1 and a key is present, so the code can ship
//     and sit dark until it has a compliance sign-off.

const zk = require('./zk-tx');
const sanctions = require('./sanctions');

const ZK_RPC_URL = process.env.ZK_RPC_URL || 'https://rpc.immutable.com';

// Decimal IMX -> wei. Rejects anything that isn't a plain positive decimal.
function imxToWei(text, fallbackWei) {
  const s = String(text ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return fallbackWei;
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

const intEnv = (name, dflt) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// Top up TO this rather than granting a flat amount, so a wallet holding 0.009 IMX gets
// 0.011 and not a full 0.02.
const TARGET_WEI = imxToWei(process.env.GAS_FAUCET_TARGET_IMX, 2n * 10n ** 16n);   // 0.02 IMX
// And only help wallets that are actually stuck. This is the gate, not the target: at
// 0.01 IMX a member can already do a couple of buys and a dozen transfers, so they don't
// need us. Nobody between TRIGGER and TARGET gets topped off.
const TRIGGER_WEI = imxToWei(process.env.GAS_FAUCET_TRIGGER_IMX, 10n ** 16n);      // 0.01 IMX
// Leave this much in the faucet wallet untouched, so it always has gas for its own sends
// and a misconfigured target can't drain it to zero.
const RESERVE_WEI = imxToWei(process.env.GAS_FAUCET_RESERVE_IMX, 2n * 10n ** 18n); // 2 IMX
// Site-wide circuit breaker. At the default target this caps a runaway day at 4 IMX
// (~$0.64), which is the point: it bounds the damage from a bug we haven't thought of.
const DAILY_CAP = intEnv('GAS_FAUCET_DAILY_CAP', 200);

const KEY = zk.normalizeKey(process.env.GAS_FAUCET_KEY);
const ENABLED = process.env.GAS_FAUCET_ENABLED === '1';

if (process.env.GAS_FAUCET_KEY && !KEY) {
  console.error('[gas-faucet] GAS_FAUCET_KEY is set but is not a valid 32-byte hex private key — gas assist is OFF.');
}

const configured = () => !!KEY;
const live = () => !!KEY && ENABLED;
const address = () => (KEY ? zk.addressFromKey(KEY) : null);

// What the client is allowed to know: the thresholds, never the wallet or its balance.
// `once` is there so the UI can state the rule in its own words without hardcoding it.
const policy = () => ({
  targetImx: Number(TARGET_WEI) / 1e18,
  triggerImx: Number(TRIGGER_WEI) / 1e18,
  once: true,
});

// Faucet float, for the boot log and ops. Never exposed over HTTP.
async function health() {
  const base = { configured: configured(), enabled: ENABLED, live: live(), address: address() };
  if (!KEY) return { ...base, balanceWei: null };
  try {
    const balanceWei = await zk.nativeBalance(ZK_RPC_URL, address());
    return { ...base, balanceWei, lowFloat: balanceWei < RESERVE_WEI + TARGET_WEI * 20n };
  } catch (err) {
    return { ...base, balanceWei: null, error: err.message };
  }
}

// How much this wallet should receive, or 0n if it doesn't need help. Balance is read
// from the chain by the caller — never taken from the request.
function amountFor(walletImxWei) {
  if (walletImxWei >= TRIGGER_WEI) return 0n;
  const want = TARGET_WEI - walletImxWei;
  return want > 0n ? want : 0n;
}

// Pay a member's gas.
//
// `wallet` is the wallet the member has connected — the destination. It is NOT proof of
// identity, so nothing is trusted to it: the identity gates are the Discord account and
// the Highrise account on the session, and the eligibility gate is `tokenIds`, which the
// caller MUST read from the chain for this wallet rather than take from the request. Each
// of those Creatures is then spent for good, which is what stops the wallet being swapped
// for a fresh one.
//
// Returns { ok: true, txHash, amountWei } or { ok: false, reason }.
// Reasons: disabled, has_gas, blocked, screen_unavailable, faucet_empty, send_failed,
// plus the once-only/cap reasons from db.reserveGasGrant.
async function grant({ db, discordId, highriseId, wallet, tokenIds, walletImxWei }) {
  if (!live()) return { ok: false, reason: 'disabled' };

  const amountWei = amountFor(walletImxWei);
  if (amountWei === 0n) return { ok: false, reason: 'has_gas' };

  // Screen before reserving: a designated address shouldn't consume a cooldown slot, and
  // the refusal needs to be loud in the audit trail.
  const screened = await sanctions.screen(wallet);
  if (screened.sanctioned) {
    db.recordEvent({ event: 'gas.blocked', discordId, ok: false, detail: { wallet, source: screened.source } });
    return { ok: false, reason: 'blocked' };
  }
  if (!screened.ok) return { ok: false, reason: 'screen_unavailable' };

  // Don't spend the float down to nothing — the faucet needs gas for its own sends.
  let faucetWei;
  try {
    faucetWei = await zk.nativeBalance(ZK_RPC_URL, address());
  } catch (err) {
    console.error('[gas-faucet] balance read failed:', err.message);
    return { ok: false, reason: 'send_failed' };
  }
  if (faucetWei < amountWei + RESERVE_WEI) {
    console.error('[gas-faucet] float exhausted — top up the faucet wallet.');
    db.recordEvent({ event: 'gas.faucet_empty', ok: false, detail: { balanceWei: String(faucetWei) } });
    return { ok: false, reason: 'faucet_empty' };
  }

  const reserved = await db.reserveGasGrant({
    discordId, highriseId, wallet, tokenIds, dailyCap: DAILY_CAP,
  });
  if (!reserved.id) return { ok: false, reason: reserved.reason };

  try {
    const txHash = await zk.sendNative({ rpcUrl: ZK_RPC_URL, privKey: KEY, to: wallet, valueWei: amountWei });
    await db.settleGasGrant(reserved.id, { txHash, amountWei });
    db.recordEvent({
      event: 'gas.granted', discordId,
      detail: { wallet, amountWei: String(amountWei), txHash, screen: screened.source, creatures: (tokenIds || []).length },
    });
    return { ok: true, txHash, amountWei };
  } catch (err) {
    // The send never landed, so give the member their cooldown back.
    await db.releaseGasGrant(reserved.id).catch(() => {});
    console.error('[gas-faucet] send failed:', err.rpcError?.message || err.message);
    db.recordEvent({
      event: 'gas.send_failed', discordId, ok: false,
      detail: { wallet, amountWei: String(amountWei), error: err.rpcError?.message || err.message },
    });
    return { ok: false, reason: 'send_failed' };
  }
}

// A wallet's native IMX, read from the chain. The endpoints must never take a balance
// from the request body — this is where they get the real one.
const walletBalance = addr => zk.nativeBalance(ZK_RPC_URL, addr);

module.exports = {
  configured, live, address, policy, health, amountFor, grant, walletBalance,
  DAILY_CAP, TARGET_WEI, TRIGGER_WEI,
};
