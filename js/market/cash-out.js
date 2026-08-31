// Cash out — a dedicated marketplace view at /trade/cash-out.
//
// This was a 460px modal. It is now a page, for the reason the flow exists at all: a member
// moving real money out needs room to see where it is going, and a backdrop you can click
// away by accident is the wrong container for that. The card's INSIDES are unchanged —
// every builder, quote fetcher, debounce guard, element id and CSS class is byte-for-byte
// what the modal had, because that is the part that took the support tickets to get right.
// What changed is the shell around them, the fact that the screen owns a URL, and that
// "cancel" now means "back to the market" rather than "dismiss".
//
// State the flow owns lives here and nowhere else. What it borrows:
//  - core/state.js  the wallet, the active collection, and the bridge job (shared, persisted)
//  - core/chain.js  balance reads, the network switch, provider-error wording
//  - core/bus.js    the shell's own services (the bridge tracker, the gas panel, render)
// The bus hooks marked "phase 2" below become direct imports once js/market/bridge.js and
// js/market/gas.js are extracted; nothing else about this module changes when they do.

import { t } from '../i18n.js';
import { esc, root } from './core/dom.js';
import {
  account, coll, tradeTab, bridgeJob, gasState, unwrapState,
  setGasState, setBridgeJobRaw, setTradeTab,
} from './core/state.js';
import {
  CASHOUT_URL, IMX_ETH_TOKEN, METAMASK_IMG, SEL_APPROVE, ZK_CHAIN_ID_HEX,
  LS_AMOUNT_STEP_WEI, LS_MIN_GAS_WEI, BRIDGE_TERMINAL, CARD_PHASES,
} from './core/consts.js';
import {
  fmtEth, fmtEthFiat, fmtFeeUsd, fmtImx, weiToEth, weiToEthStr,
} from './core/fmt.js';
import {
  eth, onZk, word, friendlyError, readAllowance, readErc20, readNative,
  switchToChain, waitForReceipt,
} from './core/chain.js';
import { shell } from './core/bus.js';
import { ico } from './core/icons.js';
import { moneyRailHtml } from './money-rail.js';

/** Is this view the one on screen? Derived, so it can never drift from what is rendered. */
const isOpen = () => tradeTab === 'cash-out';

let cashoutStep = 'intent';  // 'intent' → 'move' (Creatures, in-site) | 'guide' (LAND unwrap / external fallback)
let cashoutState = null;     // move screen: {phase:'load'|'ready', balWei, imxWei, amount, quote, err}
let cashoutSeq = 0;          // drops stale quote responses when the amount changes mid-flight
let cashoutQuoteTimer = null;
// Which way the ETH leaves zkEVM. 'layerswap' is the default because it takes its fee out of
// the ETH, so it works from a wallet holding no IMX — the state that stranded members on the
// canonical route (see lib/layerswap-bridge.js). 'canonical' keeps a trust-minimised exit on
// offer for anyone who holds the IMX to prepay Ethereum-side gas.
let cashoutRoute = 'layerswap';
const CASHOUT_ROUTES = ['layerswap', 'canonical'];
// Cash-out: selling pays in a token novices misroute when "withdrawing".
//  • Creatures: ETH on Immutable zkEVM — sent straight to an exchange it's LOST (exchanges
//    credit only mainnet ETH). Safe path: move it to Ethereum first, then send. The move
//    runs IN-SITE (quote → approve → one confirm → live tracker) — sending novices to an
//    external bridge site cost real support tickets; anything that leaves the site reads
//    as a scam risk to them. The external deep-link survives only as the quote-less
//    fallback (Squid not configured / unavailable).
//  • LAND: WETH on Ethereum — already the right network, but WETH ≠ ETH (many exchanges
//    won't credit a WETH deposit). Safe path: unwrap to ETH first, then send.
// An intent-first modal routes them to the right path for the active collection.
function cashoutInner() {
  return cashoutStep === 'move' ? cashoutMoveInner()
    : cashoutStep === 'guide'
      ? (coll === 'land' ? cashoutLandGuideInner() : cashoutGuideInner())
      : cashoutIntentInner();
}
/**
 * The whole view. The flow card keeps its `.trade-safety-card .trade-cashout-card` classes
 * so every rule and every patch selector written for the modal still finds it; `.is-view`
 * is what widens it, drops the dialog's 90vh cap and un-centres its text.
 *
 * "Back to the market" lives in the HEADER, outside the card, on purpose: a page has no
 * backdrop to click, so the way out has to survive every state the card can be in —
 * including a dead-end quote error, which is exactly when a member most needs it.
 */
export function cashOutViewHtml() {
  return `
    <div class="trade-money-view is-out" data-money="cash-out">
      <header class="trade-money-head">
        <button class="trade-money-back" data-act="funds-exit" type="button">
          ${ico('chevronLeft', 15)} ${esc(t('trade.money.back'))}
        </button>
        <span class="apply-pill">${esc(t('trade.cashout.badge'))}</span>
        <h2 class="trade-money-h">${esc(t('trade.cashout.view.h'))}</h2>
        <p class="trade-money-lead">${esc(t(
          // The move screen is chain-level, not collection-level: it takes ETH off Immutable
          // zkEVM whatever brought you here, including Add funds on LAND. Only the LAND
          // chooser and its WETH-unwrap guide get the LAND wording.
          coll === 'land' && cashoutStep !== 'move' ? 'trade.cashout.p.land' : 'trade.cashout.view.lead'))}</p>
      </header>
      <div class="trade-money-grid">
        <div class="trade-safety-card trade-cashout-card is-view" id="trade-cashout-card">${cashoutInner()}</div>
        <aside class="trade-money-rail">${cashoutRailHtml()}</aside>
      </div>
    </div>`;
}

/**
 * The "where your money is" rail. Balances come from the view's own read, so it costs no
 * extra RPC call.
 *
 * It used to list two rows, both on Immutable zkEVM. That made the destination of the entire
 * flow — the Ethereum side the money is going TO — the one thing you could not see, and left
 * a member with no way to confirm the ETH had landed without leaving for a block explorer.
 * The mainnet figures come from the server, because the wallet can only read the chain it is
 * connected to and this flow keeps it on zkEVM.
 */
function cashoutRailHtml() {
  const st = cashoutState || {};
  return moneyRailHtml({
    dir: 'out',
    loading: st.phase === 'load',
    bal: {
      mainnetEthWei: st.mainnetEthWei, mainnetImxWei: st.mainnetImxWei,
      zkEthWei: st.balWei, zkImxWei: st.imxWei,
    },
    note: 'trade.money.rail.outNote',
    link: { href: '/guides/marketplace/cashout', act: 'cashout-howto', label: 'trade.cashout.move.whereSell' },
  });
}
function cashoutIntentInner() {
  return `
    <span class="apply-pill">${esc(t('trade.cashout.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.cashout.h'))}</h3>
    <p class="trade-safety-p">${esc(t(coll === 'land' ? 'trade.cashout.p.land' : 'trade.cashout.p'))}</p>
    <div class="trade-cashout-opts">
      <button class="trade-cashout-opt" data-act="${coll === 'land' ? 'cashout-guide' : 'cashout-move'}" type="button">
        <span class="trade-cashout-opt-ico" aria-hidden="true">${ico('bank', 22)}</span>
        <span class="trade-cashout-opt-tx"><b>${esc(t('trade.cashout.opt.move.h'))}</b><span>${esc(t('trade.cashout.opt.move.p'))}</span></span>
        <span class="trade-cashout-opt-arrow" aria-hidden="true">${ico('chevronRight', 16)}</span>
      </button>
      <button class="trade-cashout-opt" data-act="funds-exit" type="button">
        <span class="trade-cashout-opt-ico" aria-hidden="true">${ico('bag', 22)}</span>
        <span class="trade-cashout-opt-tx"><b>${esc(t('trade.cashout.opt.keep.h'))}</b><span>${esc(t('trade.cashout.opt.keep.p'))}</span></span>
        <span class="trade-cashout-opt-arrow" aria-hidden="true">${ico('chevronRight', 16)}</span>
      </button>
    </div>`;
}
// Quote-less fallback (Squid not configured / unavailable): the old step guide with the
// external deep-link. Never the first resort — see the note on cashoutHtml.
function cashoutGuideInner() {
  const steps = [1, 2, 3].map(i => `<li><span class="trade-cashout-num">${i}</span><span>${esc(t('trade.cashout.step' + i))}</span></li>`).join('');
  return `
    <span class="apply-pill">${esc(t('trade.cashout.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.cashout.guide.h'))}</h3>
    <div class="trade-cashout-warn"><span aria-hidden="true">${ico('alert', 19)}</span><p>${esc(t('trade.cashout.warn'))}</p></div>
    <ol class="trade-cashout-steps">${steps}</ol>
    <div class="trade-safety-actions">
      <button class="apply-btn-ghost" data-act="cashout-back" type="button">${esc(t('trade.cashout.back'))}</button>
      <a class="trade-send trade-safety-ok" href="${CASHOUT_URL}" target="_blank" rel="noopener">${esc(t('trade.cashout.bridge'))} ${ico('external', 14)}</a>
    </div>
    <p class="trade-safety-foot">${esc(t('trade.cashout.foot'))}</p>`;
}

// --- In-site cash-out ("Move to Ethereum") -------------------------------------------
// Token-Trove-style move screen: your wallet on Immutable zkEVM → the SAME wallet on
// Ethereum, an amount prefilled with the full balance, a live quote, one button. Born
// from a support ticket: a seller sent to the external Squid deep-link (unconnected
// wallet, zero balances) froze in fear of losing her proceeds — "anything with crypto
// that opens outside of the site is something I don't like."

// The typed amount as wei (comma-tolerant — half the community types "0,17"), or null
// when unparseable/zero.
function cashoutAmountWei() {
  const v = String(cashoutState?.amount ?? '').trim().replace(',', '.');
  const m = /^(\d{1,6})(?:\.(\d{1,18}))?$/.exec(v);
  if (!m) return null;
  const wei = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0'));
  return wei > 0n ? wei : null;
}

// The quoted route tx needs native IMX: its `value` (the cross-chain relay fee) plus a
// little headroom for the zkEVM execution gas itself (which is fractions of a cent).
const CASHOUT_IMX_GAS_HEADROOM = 5n * 10n ** 16n; // 0.05 IMX
// How long a canonical quote stays signable. Its tx.value is the Axelar relay deposit, and
// that tracks Ethereum gas: observed moving from 4.5 to 67.9 IMX across three hours on a
// single day. Past this, re-quote rather than sign what we last saw.
const CASHOUT_QUOTE_MAX_AGE_MS = 60 * 1000;
// The two routes need completely different amounts of native IMX, and this used to answer for
// both with the canonical figure. On Layerswap there is no relay deposit at all: the move is a
// plain ERC-20 transfer and the fee comes out of the ETH, so the only IMX in play is ordinary
// zkEVM gas. Charging it the canonical 0.05 headroom put a gas wall in front of a wallet
// holding 0.003 IMX while the route chip directly above said "no IMX needed", and — worse —
// pushed the requirement above what the free grant tops up to, so the one member the grant
// exists for was told there was nothing we could do.
// The default reads the route off the quote itself where it says so, and only falls back to
// the current selection: a quote outlives a chip press, and answering for the wrong route is
// how a gas wall ends up in front of the route that doesn't have one.
function cashoutImxNeeded(q, route = (q && q.provider === 'layerswap' ? 'layerswap' : cashoutRoute)) {
  if (route === 'layerswap') return LS_MIN_GAS_WEI;
  try { return BigInt(q.tx.value || '0x0') + CASHOUT_IMX_GAS_HEADROOM; } catch { return null; }
}

async function openCashoutMove() {
  cashoutStep = 'move';
  if (!account) return; // the view shows the connect gate; there is nothing to read yet
  cashoutState = { phase: 'load', balWei: null, imxWei: null, amount: '', quote: null, err: null };
  patchCashout();
  readMainnetBalances(); // the rail's Ethereum side — the destination of this whole screen
  // switchToChain, not ensureNetwork: it flags the chainChanged echo as ours, so the
  // handler doesn't full-render and tear this modal down while it's loading.
  let onChain = true;
  try { if (!onZk()) await switchToChain(ZK_CHAIN_ID_HEX); } catch { onChain = false; /* reads below fail soft to em-dashes */ }
  const st = cashoutState;
  // Only read balances once we know which chain the provider is actually on. If the switch
  // was refused, readNative returns the wallet's MAINNET ETH and we were storing it as the
  // IMX balance — so the panel would cheerfully report a few ETH of "IMX" and wave a member
  // through a gas check they cannot pass. Unknown has to stay unknown.
  if (!onZk()) onChain = false;
  const [balWei, imxWei] = onChain
    ? await Promise.all([readErc20(IMX_ETH_TOKEN, account), readNative(account)])
    : [null, null];
  if (cashoutState !== st || cashoutStep !== 'move') return; // closed / navigated away
  const hasBal = balWei != null && balWei > 0n;
  cashoutState = { ...st, phase: 'ready', balWei, imxWei, amount: hasBal ? weiToEthStr(balWei) : '' };
  patchCashout();
  refreshCanonicalHealth(cashoutState);
  if (hasBal) fetchCashoutQuote();
}

function queueCashoutQuote(ms = 500) {
  clearTimeout(cashoutQuoteTimer);
  cashoutQuoteTimer = setTimeout(fetchCashoutQuote, ms);
}
async function fetchCashoutQuote() {
  const st = cashoutState;
  if (!st || cashoutStep !== 'move') return;
  const seq = ++cashoutSeq;
  const wei = cashoutAmountWei();
  if (wei == null) { st.quote = null; st.err = String(st.amount).trim() ? 'amount' : null; return patchCashoutMove(); }
  if (st.balWei != null && wei > st.balWei) { st.quote = null; st.err = 'over'; return patchCashoutMove(); }
  st.quote = 'loading'; st.err = null;
  patchCashoutMove();
  try {
    const res = await fetch(cashoutRoute === 'layerswap'
      ? '/api/market/creatures/cashout/ls/quote'
      : '/api/market/creatures/cashout/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account, amountEth: weiToEthStr(wei) }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    if (cashoutSeq !== seq || cashoutState !== st) return; // superseded
    if (!res.ok) {
      st.quote = null;
      // not_configured → no in-site quoting at all; fall back to the external-link guide.
      if (body.error === 'not_configured') { cashoutStep = 'guide'; return patchCashout(); }
      // Layerswap is a solver, so its routes come and go with whoever is holding the float
      // on the far side. When zkEVM -> Ethereum is not on offer, the fix is not "wait a
      // moment" — it is the canonical bridge, which is always there. Move them across and
      // say why, rather than leaving them poking a button that cannot work.
      if (body.error === 'route_down' && cashoutRoute === 'layerswap') {
        cashoutRoute = 'canonical';
        // Record the failure before switching. Without this the comparison map still holds
        // whatever Layerswap last quoted, so the gas panel's escape card would cheerfully
        // offer a one-click switch back to the route we just learned is not running.
        st.cmp = { ...(st.cmp || {}), layerswap: { error: 'route_down' } };
        st.routeDownNotice = true;
        st.quote = null; st.err = null;
        patchCashoutMove();
        return queueCashoutQuote(0);
      }
      st.err = body.error === 'route_down' ? 'routedown'
        : body.error === 'no_route' ? 'small'
        : body.error === 'rate_limited' ? 'rate' : 'quote';
      st.cmp = { ...(st.cmp || {}), [cashoutRoute]: { error: body.error || 'quote' } };
      refreshRouteCompare(st, wei);
      patchCashoutMove();
      return autoPickRoute(st);
    }
    st.quote = body;
    st.quoteAt = Date.now();
    // Stamp the amount each price was taken at. st.cmp is keyed by route alone and nothing
    // clears it when the member edits the box, so without this the gas panel's escape card
    // could quote the previous amount's fee and offer a switch to a route that cannot fill
    // the current one at all.
    st.cmp = { ...(st.cmp || {}), [cashoutRoute]: { ...body, forWei: String(wei) } };
    refreshRouteCompare(st, wei);
    // Layerswap takes its fee out of the ETH being moved, so there is no native-coin
    // PREPAYMENT to check. There is still a transaction to sign, and on zkEVM signing costs
    // native IMX like anywhere else. This used to skip the check below outright, which handed
    // a wallet holding exactly zero IMX a green Move button and let MetaMask refuse the
    // confirm with something unreadable. The requirement is simply much smaller here, and
    // cashoutImxNeeded now answers per route, so both routes can use one check.
    //
    // Getting this right is what makes the free gas grant reach the member it was built for:
    // 0.002 IMX of transfer gas is well inside what a grant tops up to, where the canonical
    // relay deposit never was.
    // The move is signed on zkEVM, where gas is native IMX — flag a short wallet now
    // instead of letting MetaMask fail the confirm with a cryptic alert.
    // Re-read the gas balance instead of trusting the one taken when the modal opened.
    // Between then and now they may have bridged, bought or been granted IMX — precisely
    // what the panel below tells them to go and do — and a stale read would leave the
    // panel up and the Move button dead after they had already fixed it.
    // readNative reads whatever chain the wallet is actually on, so this is only evidence
    // about IMX when the wallet is on zkEVM. openCashoutMove deliberately leaves imxWei null
    // when the network switch was refused ("unknown has to stay unknown"), and overwriting it
    // here put a MAINNET ETH balance in the IMX field. Against the canonical bar of tens of
    // IMX that mostly still failed safe; against the Layerswap bar of 0.002 it does not, so
    // any wallet carrying ordinary mainnet dust would clear a gas check it cannot pass.
    const freshImx = onZk() ? await readNative(account).catch(() => null) : null;
    if (cashoutSeq !== seq || cashoutState !== st) return;
    if (freshImx != null) st.imxWei = freshImx;

    const needImx = cashoutImxNeeded(body);
    const gasShort = needImx != null && st.imxWei != null && st.imxWei < needImx;
    st.err = gasShort ? 'gas' : null;
    patchCashoutMove();
    // Saying "you haven't got enough IMX" and greying out the button is a dead end. Load the
    // real ways out instead. `needImx` goes with it so the free-gas offer can hide itself:
    // a bridge out needs more gas than a grant covers, and burning someone's one claim
    // without unblocking them is worse than not offering.
    if (gasShort) shell.showGasHelp('cashout', queueCashoutQuote, needImx);
    else if (gasState?.ctx === 'cashout') { setGasState(null); patchCashoutMove(); }
  } catch {
    if (cashoutSeq !== seq || cashoutState !== st) return;
    st.quote = null; st.err = 'quote';
    patchCashoutMove();
  }
}

// --- Comparing the two exits -----------------------------------------------------------
// Both routes get priced against the SAME amount so the member can see what each actually
// costs right now, rather than picking on a description and finding out afterwards. This is
// worth the extra request: the two are not reliably ranked. Layerswap's fee is steady near
// $0.65, while the canonical relay tracks Ethereum gas and has run anywhere from about 4 IMX
// in a lull to 50+ in a spike on the same day. Which one is cheaper genuinely depends on when
// you ask.
//
// Only the route the member is NOT on is fetched here; the active one already has a full
// quote. That keeps this to one extra call, which matters because the canonical quote shares
// a 6/min bucket.
async function refreshRouteCompare(st, wei) {
  const other = cashoutRoute === 'layerswap' ? 'canonical' : 'layerswap';
  const seq = cashoutSeq;
  try {
    const res = await fetch(other === 'layerswap'
      ? '/api/market/creatures/cashout/ls/quote'
      : '/api/market/creatures/cashout/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account, amountEth: weiToEthStr(wei) }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    if (cashoutSeq !== seq || cashoutState !== st) return;
    st.cmp = { ...(st.cmp || {}), [other]: res.ok ? { ...body, forWei: String(wei) } : { error: body.error || 'quote' } };
    patchCashoutMove();
    // The pick waits on BOTH sides being priced, and this is the one that arrives second.
    // Calling it only from the caller left it evaluating before this fetch had resolved, so
    // it early-returned, never set its latch, and stayed armed to fire much later — long
    // after the member had chosen for themselves.
    autoPickRoute(st);
  } catch {
    // No price for that chip, but the pick must not wait forever on an answer that will never
    // come, or it stays armed and can move the member later.
    if (cashoutState === st) { st.cmp = { ...(st.cmp || {}), [other]: { error: 'quote' } }; autoPickRoute(st); }
  }
}

// The canonical route's two Ethereum-side hazards, read live. Cheap and cached server-side.
async function refreshCanonicalHealth(st) {
  try {
    const r = await fetch('/api/market/creatures/cashout/canonical/health', { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return;
    const h = await r.json();
    if (cashoutState !== st) return;
    st.canonHealth = h;
    patchCashoutMove();
  } catch { /* unknown stays unknown — the chip says so */ }
}

// What the canonical route needs in native IMX for a given quote, or null when unknown.
const canonNeedWei = q => (q && q.tx ? cashoutImxNeeded(q, 'canonical') : null);

// Pick the route that will actually work for this wallet, once, on first load. After that the
// member's own choice stands — re-quoting must never yank the selection out from under them.
//
// The order encodes what can go wrong rather than what is cheapest:
//   * The withdrawal queue holds EVERY canonical withdrawal for 24 hours when it trips, and
//     leaves the member owing a mainnet transaction to finalise. Nothing about a price makes
//     that a good default, so the queue wins outright.
//   * Then affordability, because a route you cannot fund is not an option. Canonical needs
//     the relay deposit sitting in the wallet first; Layerswap needs a fraction of a cent of
//     ordinary transfer gas.
//   * Only when both are genuinely usable does price decide, and then on the quoted fee,
//     because that is the number the member can see and check.
//   * When neither is comfortably affordable, Layerswap: it asks for the least, and the
//     alternative is telling someone to go and acquire tens of IMX they haven't got.
function autoPickRoute(st) {
  if (!st || st.autoPicked || cashoutState !== st) return;
  // A deliberate pick ends the matter. Without this the latch could still be unset when the
  // member chose for themselves, and a later answer would quietly move them — off the
  // trust-minimised bridge they had selected and onto the custodial route, unannounced.
  if (st.routePicked) { st.autoPicked = true; return; }
  const cmp = st.cmp || {};
  const ls = cmp.layerswap, cn = cmp.canonical;
  if (!ls || !cn) return;                       // wait until both have answered
  st.autoPicked = true;

  const lsOk = !ls.error;
  const cnOk = !cn.error && st.canonHealth?.queueActive !== true;
  const need = canonNeedWei(cn);
  const cnAfford = cnOk && need != null && st.imxWei != null && st.imxWei >= need;

  let pick;
  if (!cnOk) pick = 'layerswap';
  else if (!lsOk) pick = 'canonical';
  else if (cnAfford) {
    const lsFee = Number(ls.feeUsd), cnFee = Number(cn.feeUsd);
    pick = Number.isFinite(lsFee) && Number.isFinite(cnFee) && cnFee < lsFee ? 'canonical' : 'layerswap';
  } else pick = 'layerswap';

  if (pick !== cashoutRoute) {
    cashoutRoute = pick;
    st.quote = null; st.err = null;
    patchCashoutMove();
    queueCashoutQuote(0);
  }
}

function cashoutBalLineHtml() {
  const st = cashoutState || {};
  if (st.phase === 'load') return `<span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.cashout.move.balLoading'))}`;
  if (st.balWei == null) return esc(t('trade.cashout.move.balUnknown'));
  return esc(t('trade.cashout.move.bal').replace('{x}', fmtEthFiat(weiToEth(st.balWei))));
}
// The two ways out, as a pair of chips above the quote. Layerswap leads because it works
// from any wallet; the canonical bridge is named as the trust-minimised alternative rather
// than hidden, because for anyone already holding IMX it is the better trade.
// Switching re-quotes: the two routes price completely differently.
function cashoutRoutePickerHtml() {
  const st = cashoutState || {};
  const busy = bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase);
  const cmp = st.cmp || {};
  const queued = st.canonHealth?.queueActive === true;
  // null means the read failed. Not knowing is not the same as knowing it's clear, and this
  // route's failure mode is a 24-hour hold, so the chip says so rather than staying silent.
  const queueUnknown = st.canonHealth != null && st.canonHealth.queueActive == null;

  // Each chip carries this route's real price for THIS amount, priced now. Descriptions alone
  // can't rank these two: Layerswap sits near $0.65 while the canonical relay follows Ethereum
  // gas and swings by more than tenfold in a day, so which is cheaper depends on the hour.
  const priceLine = r => {
    const q = cmp[r];
    if (!q) return `<i class="trade-route-fee is-wait">${esc(t('trade.cashout.route.pricing'))}</i>`;
    if (q.error) {
      return `<i class="trade-route-fee is-off">${esc(t(q.error === 'route_down'
        ? 'trade.cashout.route.offline' : 'trade.cashout.route.noprice'))}</i>`;
    }
    const secs = q.durationSeconds;
    const eta = r === 'layerswap' && secs
      ? t('trade.cashout.move.secs').replace('{s}', String(secs))
      : t('trade.cashout.move.mins');
    return `<i class="trade-route-fee">${esc(t('trade.cashout.route.fee')
      .replace('{f}', fmtFeeUsd(q.feeUsd)).replace('{t}', eta))}</i>`;
  };

  // What this route demands you already hold, which is the thing that actually decides whether
  // it's usable. Layerswap's fee comes out of the ETH; canonical wants the relay deposit in the
  // wallet first, and that is the wall members kept hitting.
  const needLine = r => {
    if (r === 'layerswap') {
      // The fee comes out of the ETH, so no IMX is needed to PAY. The transfer still costs
      // ordinary zkEVM gas (~0.0004 IMX), and promising "no IMX needed" to a wallet holding
      // literally zero would strand exactly the member this route exists for.
      const have = st.imxWei;
      if (have != null && have < LS_MIN_GAS_WEI) {
        return `<i class="trade-route-need is-bad">${esc(t('trade.cashout.route.needDust'))}</i>`;
      }
      return `<i class="trade-route-need is-ok">${esc(t('trade.cashout.route.needNone'))}</i>`;
    }
    if (queued) return `<i class="trade-route-need is-bad">${esc(t('trade.cashout.route.queued'))}</i>`;
    if (queueUnknown) return `<i class="trade-route-need is-bad">${esc(t('trade.cashout.route.queueUnsure'))}</i>`;
    const need = canonNeedWei(cmp.canonical);
    if (need == null) return '';
    const have = st.imxWei;
    const ok = have != null && have >= need;
    return `<i class="trade-route-need ${ok ? 'is-ok' : 'is-bad'}">${esc(
      t(ok ? 'trade.cashout.route.needHave' : 'trade.cashout.route.needShort')
        .replace('{x}', fmtImx(weiToEth(need))))}</i>`;
  };

  const chip = r => {
    const off = r === 'canonical' && (queued || cmp[r]?.error === 'route_down');
    return `
    <button class="trade-route-pick${cashoutRoute === r ? ' is-on' : ''}${off ? ' is-off' : ''}"
      data-act="cashout-route" data-route="${r}"
      type="button" role="radio" aria-checked="${cashoutRoute === r}" ${busy || off ? 'disabled' : ''}>
      <b>${esc(t(`trade.cashout.route.${r}.h`))}</b>
      <span>${esc(t(`trade.cashout.route.${r}.p`))}</span>
      ${priceLine(r)}
      ${needLine(r)}
    </button>`;
  };

  // The queue is the one hazard worth interrupting for: when it's on, a canonical withdrawal
  // is held 24 hours whatever its size, and the member is left owing a mainnet transaction to
  // release it. Say that before they pick, not after they've signed.
  const queueWarn = queued
    ? `<div class="trade-status is-warn"><span aria-hidden="true">⏳</span><span>${esc(t('trade.cashout.route.queueWarn'))}</span></div>`
    : '';

  // A single withdrawal over largeTransferThresholds is queued on its own, even when the global
  // queue is off — same 24-hour hold, same "send your own mainnet transaction to finish it".
  // We already read the threshold live; not warning on it would mean cheerfully taking a
  // member's signature on a move that quietly becomes a day-long wait. Only the canonical route
  // is affected, so this stays quiet on Layerswap.
  let bigWarn = '';
  if (!queued && cashoutRoute === 'canonical' && st.canonHealth?.thresholdWei) {
    try {
      const thr = BigInt(st.canonHealth.thresholdWei);
      const want = cashoutAmountWei();
      if (thr > 0n && want != null && want >= thr) {
        bigWarn = `<div class="trade-status is-warn"><span aria-hidden="true">⏳</span><span>${esc(
          t('trade.cashout.route.bigWarn').replace('{x}', fmtEth(weiToEth(thr))))}</span></div>`;
      }
    } catch { /* unparseable threshold — say nothing rather than guess */ }
  }
  return `
    <div class="trade-route-picks" role="radiogroup" aria-label="${esc(t('trade.cashout.route.aria'))}">
      ${CASHOUT_ROUTES.map(chip).join('')}
    </div>${queueWarn}${bigWarn}`;
}

function cashoutQuoteAreaHtml() {
  const st = cashoutState || {};
  const q = st.quote;
  // The picker rides above every state, including errors and loading: switching route is
  // often the fix for whatever the error is saying, so it must never be the thing that
  // disappears when something goes wrong.
  const pick = (st.routeDownNotice
    ? `<div class="trade-status is-warn"><span aria-hidden="true">${ico('alert', 17)}</span><span>${esc(t('trade.cashout.route.downNotice'))}</span></div>`
    : '') + cashoutRoutePickerHtml();
  const ERR = { over: 'trade.cashout.move.err.over', amount: 'trade.cashout.move.err.amount', small: 'trade.cashout.move.err.small', rate: 'trade.err.rate', quote: 'trade.cashout.move.err.quote', routedown: 'trade.cashout.route.down' };
  if (st.err && st.err !== 'gas') return `${pick}<div class="trade-status is-error"><span aria-hidden="true">${ico('alert', 17)}</span><span>${esc(t(ERR[st.err]))}</span></div>`;
  if (q === 'loading') return `${pick}<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.bridge.quote.loading'))}</div>`;
  if (!q) return pick;
  // Don't show Squid's durationSeconds here: it's calibrated to the slow (mainnet →
  // zkEVM) direction. A real cash-out executed in 72s while the quote claimed ~23 min —
  // an ETA that wrong reads as "something's broken" to a nervous seller. Layerswap's ETA is
  // measured on this direction and runs ~25s, so that one is worth showing.
  const lsMins = q.provider === 'layerswap' && q.durationSeconds
    ? t('trade.cashout.move.secs').replace('{s}', String(q.durationSeconds))
    : t('trade.cashout.move.mins');
  const meta = [
    q.feeUsd != null ? t('trade.bridge.quote.fees').replace('{f}', fmtFeeUsd(q.feeUsd)) : null,
    lsMins,
    t(q.provider === 'layerswap' ? 'trade.cashout.move.byLs' : 'trade.bridge.quote.by'),
  ].filter(Boolean).join(' · ');
  const gasShort = st.err === 'gas';
  const needImx = cashoutImxNeeded(q);
  const busy = bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase);
  return `${pick}
    <div class="trade-bridge-quote">
      <div class="trade-bridge-line">${esc(t('trade.cashout.move.quoteLine').replace('{y}', fmtEthFiat(q.toEth)))}</div>
      <div class="trade-bridge-meta">${esc(meta)}</div>
      ${gasShort ? `<div class="trade-status is-error"><span aria-hidden="true">${ico('fuel', 17)}</span><span>${esc(
        // The IMX figure and the "fees ≈ $X" line directly above it are the SAME money: the
        // relay fee, quoted once in dollars and once in the coin it's actually paid in. Shown
        // as two bare numbers they read as two charges, and the IMX one reads as enormous
        // because IMX is a ten-cent coin. So say the dollar amount alongside it and say
        // plainly that it is not an extra charge.
        //
        // That reasoning is canonical-only. On Layerswap the fee comes out of the ETH being
        // moved and is nothing to do with the IMX, so telling someone the fee "is charged in
        // IMX" there would be flatly untrue. Same shortfall, opposite explanation.
        (q.provider === 'layerswap'
          ? (q.feeUsd != null
            ? t('trade.cashout.move.gasShortLs').replace('{z}', fmtFeeUsd(q.feeUsd))
            : t('trade.cashout.move.gasShort'))
          : q.feeUsd != null
          ? t('trade.cashout.move.gasShortUsd').replace('{z}', fmtFeeUsd(q.feeUsd))
          : t('trade.cashout.move.gasShort'))
          .replace('{x}', fmtImx(weiToEth(needImx)))
          .replace('{y}', fmtImx(weiToEth(cashoutState?.imxWei ?? 0n))))}</span></div>` : ''}
      ${gasShort && gasState?.ctx === 'cashout'
        ? shell.gasHelpHtml()
        : `<button class="trade-funds-btn" data-act="cashout-now" type="button" ${gasShort || busy ? 'disabled' : ''}>${esc(t('trade.cashout.move.btn'))}</button>`}
      ${shell.isCashout(bridgeJob) ? shell.bridgeStatusHtml() : ''}
    </div>`;
}
// One route hop (From / To): the SAME wallet on each side — seeing their own address
// twice is what makes the move feel safe. MetaMask mark + short address + network chip.
/**
 * One route hop (From / To): the SAME wallet on each side — seeing their own address twice
 * is what makes the move feel safe. Exported because the Add funds view renders the mirror
 * image of it (Ethereum → zkEVM) and there is no reason for two copies.
 */
export function cashoutHopHtml(lblKey, netImg, netName, sub) {
  const short = account ? `${account.slice(0, 6)}…${account.slice(-4)}` : '—';
  return `
    <div class="trade-cashout-hop">
      <img class="trade-cashout-hop-mm" src="${METAMASK_IMG}" alt="" width="26" height="26">
      <span class="trade-cashout-hop-tx">
        <b>${esc(t(lblKey))} · ${esc(short)}</b>
        <span>${esc(t(sub))}</span>
      </span>
      <span class="trade-bchip"><img src="${netImg}" alt="" width="14" height="14">${esc(netName)}</span>
    </div>`;
}
// Which custody sentence belongs on this screen. The two routes make opposite promises about
// where the member's ETH goes, so picking the wrong one is the most misleading thing this
// modal can say.
//
// For a bridge that already exists, the answer comes from the JOB, never from the current
// selection. `cashoutRoute` is a module global that resets to the default on every page load,
// while a bridge job is persisted and restored across one — so after a reload a canonical
// withdrawal was being described as "your ETH goes to Layerswap", to a member who had
// deliberately chosen the route where it does not. swapId is written only by
// runCashoutLayerswap, which makes it the marker that survives.
const cashoutFootKey = (job = null) =>
  (job ? !!job.swapId : cashoutRoute === 'layerswap')
    ? 'trade.cashout.move.footLs' : 'trade.cashout.move.foot';

function cashoutMoveInner() {
  // A move is underway/finished — the tracker card takes over the modal (same pattern as
  // the funds/gas panels), so there's exactly one source of truth on screen.
  if (shell.isCashout(bridgeJob) && CARD_PHASES.has(bridgeJob.phase)) {
    return `
      <span class="apply-pill">${esc(t('trade.cashout.badge'))}</span>
      ${shell.bridgeCardHtml(bridgeJob)}
      ${/* The one-tap fix for a message that stalled out of relay gas lives here, because
            this branch owns the screen for every terminal phase including 'error'. It was
            hung off the quote area, which this return never reaches — so the button existed
            and was unreachable, which is worse than not having built it. */
        gasRescueHtml()}
      <p class="trade-safety-foot">${esc(t(cashoutFootKey(bridgeJob)))}</p>`;
  }
  const st = cashoutState || {};
  return `
    <span class="apply-pill">${esc(t('trade.cashout.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.cashout.move.h'))}</h3>
    <p class="trade-safety-p">${esc(t('trade.cashout.move.p'))}</p>
    <div class="trade-cashout-route" aria-hidden="false">
      ${cashoutHopHtml('trade.cashout.move.from', '/img/brands/immutable.png', 'Immutable zkEVM', 'trade.cashout.move.fromSub')}
      <div class="trade-cashout-hop-arrow" aria-hidden="true">${ico('chevronDown', 18)}</div>
      ${cashoutHopHtml('trade.cashout.move.to', '/img/brands/eth.png', 'Ethereum', 'trade.cashout.move.toSub')}
    </div>
    <label class="trade-cashout-amtlbl" for="trade-cashout-amt">${esc(t('trade.cashout.move.amount'))}</label>
    <div class="trade-cashout-amtrow">
      <input id="trade-cashout-amt" class="trade-cashout-amt" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
        value="${esc(st.amount || '')}" placeholder="0.0" ${st.phase === 'load' ? 'disabled' : ''}>
      <span class="trade-cashout-unit" aria-hidden="true">ETH</span>
      <button class="trade-cashout-max" data-act="cashout-max" type="button" ${st.balWei ? '' : 'disabled'}>${esc(t('trade.cashout.move.max'))}</button>
    </div>
    <p class="trade-cashout-balline" id="trade-cashout-balline">${cashoutBalLineHtml()}</p>
    <div id="trade-cashout-qslot">${cashoutQuoteAreaHtml()}</div>
    <div class="trade-safety-actions">
      <button class="apply-btn-ghost" data-act="cashout-back" type="button">${esc(t('trade.cashout.back'))}</button>
    </div>
    <p class="trade-safety-foot" id="trade-cashout-foot">${cashoutFootInnerHtml()}</p>`;
}
// Patch only the quote area + balance line — the amount input keeps focus while typing.
function patchCashoutMove() {
  const slot = root()?.querySelector('#trade-cashout-qslot');
  if (slot) slot.innerHTML = cashoutQuoteAreaHtml();
  const bal = root()?.querySelector('#trade-cashout-balline');
  if (bal) bal.innerHTML = cashoutBalLineHtml();
  // The custody sentence changes with the route, and every route change comes through here.
  // It used to sit outside the two patched nodes, so switching route repainted the price and
  // left the promise describing the route the member had just left — telling someone their
  // ETH never leaves their wallet as they signed it over to a solver, or the reverse.
  const foot = root()?.querySelector('#trade-cashout-foot');
  if (foot) foot.innerHTML = cashoutFootInnerHtml();
}
// The footer's contents, so the full render and the patch can never drift apart.
function cashoutFootInnerHtml() {
  return `${esc(t(cashoutFootKey()))}<br>
    <a class="trade-cashout-diy" href="${CASHOUT_URL}" target="_blank" rel="noopener">${esc(t('trade.cashout.move.diy'))} ${ico('external', 13)}</a>`;
}
function cashoutMaxClick() {
  const st = cashoutState;
  if (!st?.balWei) return;
  st.amount = weiToEthStr(st.balWei);
  const input = root()?.querySelector('#trade-cashout-amt');
  if (input) input.value = st.amount;
  clearTimeout(cashoutQuoteTimer);
  fetchCashoutQuote();
}

// Sign and send the move: (one-time) ERC-20 approval for the router, then the quoted
// route tx — both on Immutable zkEVM — then hand off to the shared resumable tracker.
async function runCashout() {
  const st = cashoutState;
  const q = st?.quote;
  // The canonical route carries its transaction on the quote; Layerswap mints one only when
  // the member commits, so a missing `tx` is normal there and must not block the button.
  if (!q || q === 'loading' || st.err === 'gas') return;
  if (cashoutRoute !== 'layerswap' && !q.tx) return;
  if (bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase)) return; // one bridge at a time
  if (cashoutRoute === 'layerswap') return runCashoutLayerswap(q);
  // A canonical quote is perishable. Its `tx.value` is the Axelar relay deposit, which
  // tracks Ethereum gas and has moved more than tenfold inside three hours. Signing a stale
  // one underpays the relay, and an underfunded message does not heal: it sits approved and
  // unexecuted until somebody tops it up by hand. So refuse to sign an old quote and go get
  // a fresh one instead — a second of waiting against weeks of stranded ETH.
  if (st.quoteAt && Date.now() - st.quoteAt > CASHOUT_QUOTE_MAX_AGE_MS) {
    st.quote = null;
    patchCashoutMove();
    return queueCashoutQuote(0);
  }
  // Read the queue again, right now, and refuse if it is on OR if we cannot tell. Checking it
  // when the screen opened is not evidence about this moment: the queue trips on aggregate
  // traffic, so it can come on between opening the panel and pressing the button, and a
  // withdrawal signed into it is held 24 hours and then needs a mainnet transaction the member
  // may not be able to afford. "We could not check" has to block too — presenting an unknown
  // as clear is how you promise a few minutes and deliver a day.
  const health = await fetch('/api/market/creatures/cashout/canonical/health',
    { signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null).catch(() => null);
  if (cashoutState !== st) return;
  if (health) st.canonHealth = health;
  if (health?.queueActive !== false) {
    st.err = null;
    patchCashoutMove();
    shell.setBridgeJob({ phase: 'error', kind: 'cashout', dir: 'out', account,
      msg: t(health?.queueActive === true ? 'trade.cashout.route.queueBlocked' : 'trade.cashout.route.queueUnknown') });
    return;
  }
  signing = true; // from here the wallet may have a prompt up — teardown must not run
  try {
    setBridgeJobRaw({ phase: 'switch', dir: 'out', kind: 'cashout', account, mins: null, startedAt: Date.now(), fromSym: 'ETH', toSym: 'ETH', fromEth: q.fromEth, toEth: q.toEth });
    patchCashout();
    shell.patchBridgeBanner();
    await switchToChain(ZK_CHAIN_ID_HEX); // the SOURCE chain this time — Immutable zkEVM (usually a no-op)
    // The router pulls the ETH ERC-20 from the wallet, so it needs an allowance — exactly
    // the quoted amount, no open-ended approvals.
    const fromWei = BigInt(q.fromWei);
    const allowance = await readAllowance(IMX_ETH_TOKEN, account, q.approveSpender);
    if (allowance == null || allowance < fromWei) {
      shell.setBridgeJob({ phase: 'approve' });
      const aHash = await eth().request({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: IMX_ETH_TOKEN, data: SEL_APPROVE + word(q.approveSpender) + word(fromWei) }],
      });
      const rec = await waitForReceipt(aHash);
      if (!rec || rec.status !== '0x1') { shell.setBridgeJob({ phase: 'error', msg: t('trade.cashout.move.err.approve') }); return; }
    }
    shell.setBridgeJob({ phase: 'confirm' });
    const hash = await eth().request({
      method: 'eth_sendTransaction',
      params: [{ from: account, to: q.tx.to, data: q.tx.data, value: q.tx.value, ...(q.tx.gas ? { gas: q.tx.gas } : {}) }],
    });
    // mins stays null: Squid's estimate is calibrated to the slow funding direction
    // (a real cash-out landed in 72s vs a quoted ~23 min). Null renders the honest
    // "a few minutes" ETA, and the 25-min tracking window still guards the slow tail.
    shell.setBridgeJob({
      phase: 'waiting', hash, mins: null, startedAt: Date.now(), stage: 'submitted', kind: 'cashout', dir: 'out',
      axelarUrl: null, needWei: '0', quoteId: q.quoteId || '', requestId: q.requestId || '', account,
      fromSym: 'ETH', toSym: 'ETH', fromEth: q.fromEth, toEth: q.toEth,
    });
    shell.trackBridge();
  } catch (err) {
    console.error('Cash-out failed:', err);
    shell.setBridgeJob({ phase: 'error', msg: friendlyError(err) });
  } finally {
    signing = false;
  }
}

// Did a canonical withdrawal actually PAY OUT, or did it execute into the 24-hour queue?
// Axelar cannot tell us apart from these, so ask the bridge: if the flow-rate guard is on, or
// the amount cleared the per-transfer threshold, the ETH is held rather than delivered. Only
// the clear case gets to say "landed".
async function confirmCanonicalDelivery(hash) {
  let h = null;
  try {
    const r = await fetch('/api/market/creatures/cashout/canonical/health', { signal: AbortSignal.timeout(10000) });
    h = r.ok ? await r.json() : null;
  } catch { h = null; }
  if (!bridgeJob || bridgeJob.hash !== hash) return; // superseded
  let overThreshold = false;
  try {
    const thr = h?.thresholdWei ? BigInt(h.thresholdWei) : null;
    const sent = bridgeJob.fromEth != null ? BigInt(Math.round(Number(bridgeJob.fromEth) * 1e6)) * 10n ** 12n : null;
    overThreshold = thr != null && thr > 0n && sent != null && sent >= thr;
  } catch { overThreshold = false; }
  // Unknown health does NOT get the celebration. A quiet "check your wallet" is honest; a
  // wrong "it's landed" sends someone hunting for money that is sitting in a queue.
  if (h?.queueActive === true || overThreshold) {
    shell.setBridgeJob({ phase: 'done', stage: 'arrived', queuedDelivery: true });
  } else if (h?.queueActive === false) {
    shell.setBridgeJob({ phase: 'done', stage: 'arrived' });
  } else {
    shell.setBridgeJob({ phase: 'done', stage: 'arrived', deliveryUnsure: true });
  }
}

// --- A stalled canonical message ---------------------------------------------------------
// The Ethereum-side relay ran out of prepaid gas, so the message sits approved and unexecuted.
// The ETH is not lost and not spent: it is waiting on a gas top-up. Left unexplained this is
// the worst outcome on the whole screen, and it is not hypothetical — two of these from
// 2026-07-31 were still untouched nineteen days later because nobody knew what to do.
//
// The top-up itself (addNativeGas on the zkEVM gas service) needs the message's log index, and
// Axelar publishes several similarly-named indices with different scopes. Getting it wrong
// spends real IMX on the wrong event. Rather than guess with a member's money, this hands them
// to Axelarscan's page for their transaction, which offers the same top-up and computes the
// index correctly. Worth revisiting as a one-tap once the field can be verified against a live
// stalled message.
function gasRescueHtml() {
  const b = bridgeJob;
  if (!b?.stalled || !b.hash) return '';
  const url = b.axelarUrl || `https://axelarscan.io/gmp/${encodeURIComponent(b.hash)}`;
  return `
    <p class="trade-funds-net">${esc(t('trade.bridge.rescue.p'))}</p>
    <a class="trade-funds-btn" href="${esc(url)}" target="_blank" rel="noopener">${esc(t('trade.bridge.rescue.btn'))} ${ico('external', 14)}</a>`;
}

// Layerswap cash-out: one signature, no approval, no IMX beyond ordinary transfer gas.
//
// The shape differs from the canonical route in two ways worth naming:
//   * The transaction is minted HERE, not at quote time, because creating it registers a
//     swap on Layerswap's side. Quoting stays free and repeatable; committing happens once.
//   * It is a bare ERC-20 transfer, so there is nothing to approve. The router-pull the
//     canonical route needs an allowance for simply doesn't exist here.
// The calldata is forwarded exactly as the server hands it over: Layerswap appends the swap
// id to it, and that is the only thing tying the transfer to this swap.
async function runCashoutLayerswap(q) {
  signing = true; // from here the wallet may have a prompt up — teardown must not run
  try {
    setBridgeJobRaw({ phase: 'switch', dir: 'out', kind: 'cashout', account, mins: null, startedAt: Date.now(), fromSym: 'ETH', toSym: 'ETH', fromEth: q.fromEth, toEth: q.toEth });
    patchCashout();
    shell.patchBridgeBanner();
    await switchToChain(ZK_CHAIN_ID_HEX); // source chain — usually a no-op, we're already here

    // Mint against the amount showing on screen, re-read now rather than trusting the one
    // the quote was taken with: the member may have edited the box while the quote settled.
    const wei = cashoutAmountWei();
    if (wei == null) { shell.setBridgeJob({ phase: 'error', msg: t('trade.cashout.move.err.amount') }); return; }
    const res = await fetch('/api/market/creatures/cashout/ls/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account, amountEth: weiToEthStr(wei) }),
      signal: AbortSignal.timeout(30000),
    });
    const swap = await res.json().catch(() => ({}));
    if (!res.ok || !swap.tx?.to || !swap.tx?.data || !swap.swapId) {
      // The route can vanish between quoting and committing — it is a solver, and Ethereum is
      // the leg they drop first. "Try again in a moment" is the one answer that is never true
      // for that, so it gets the message that actually helps: switch to the official bridge.
      const key = swap.error === 'route_down' ? 'trade.cashout.route.down'
        : swap.error === 'no_route' ? 'trade.cashout.move.err.small'
        : 'trade.cashout.move.err.quote';
      shell.setBridgeJob({ phase: 'error', msg: t(key) });
      return;
    }
    // Assert the same facts here rather than trust that the server did. The wallet is about
    // to be asked to move real ETH, so the recipient and the amount are decoded from the
    // calldata and checked against what this screen actually asked for. A mismatch means
    // something upstream is wrong, and the right answer is to refuse, not to sign and hope.
    const d = String(swap.tx.data || '');
    const okShape = swap.tx.to?.toLowerCase() === IMX_ETH_TOKEN.toLowerCase()
      && /^0xa9059cbb[0-9a-f]{128,}$/i.test(d);
    const recip = okShape ? ('0x' + d.slice(34, 74)).toLowerCase() : null;
    let amt = null;
    try { amt = okShape ? BigInt('0x' + d.slice(74, 138)) : null; } catch { amt = null; }
    // Compare against the amount Layerswap can actually express, not the one in the box.
    //
    // They price in units of 1e-8 ETH, so the calldata always carries this figure floored to
    // that step. Asserting equality against the raw 18-decimal box value refused every wallet
    // whose balance had more than eight decimal places, which is very nearly every wallet:
    // the box is PREFILLED with the exact balance, so pressing Move on the default route
    // failed for the ordinary case, and failed after ls/create had already registered a swap
    // upstream. The earlier test missed it because its stub balance happened to be round.
    //
    // Flooring here keeps the property that matters: the transaction can never move more than
    // was asked, and the only difference tolerated is the sub-cent rounding Layerswap itself
    // performs. Anything else is still refused unsigned.
    const wantWei = wei - (wei % LS_AMOUNT_STEP_WEI);
    if (!okShape || !recip || recip === account.toLowerCase() || amt == null || amt !== wantWei) {
      console.error('Layerswap returned an unexpected call', { to: swap.tx.to, recip, amt: String(amt), want: String(wantWei) });
      shell.setBridgeJob({ phase: 'error', msg: t('trade.cashout.move.err.quote') });
      return;
    }
    // And it has to be ETH they actually hold. The amount is re-read from the box at commit
    // time, so a balance checked when the quote landed is not evidence about this number.
    const balNow = await readErc20(IMX_ETH_TOKEN, account).catch(() => null);
    if (balNow != null && amt > balNow) {
      shell.setBridgeJob({ phase: 'error', msg: t('trade.cashout.move.err.over') });
      return;
    }

    shell.setBridgeJob({ phase: 'confirm' });
    const hash = await eth().request({
      method: 'eth_sendTransaction',
      params: [{ from: account, to: swap.tx.to, data: swap.tx.data }],
    });
    shell.setBridgeJob({
      phase: 'waiting', hash, swapId: swap.swapId, mins: null, startedAt: Date.now(), stage: 'submitted',
      kind: 'cashout', dir: 'out', axelarUrl: null, needWei: '0', quoteId: '', requestId: '', account,
      fromSym: 'ETH', toSym: 'ETH', fromEth: swap.fromEth ?? q.fromEth, toEth: swap.toEth ?? q.toEth,
    });
    shell.trackBridge();
  } catch (err) {
    console.error('Layerswap cash-out failed:', err);
    shell.setBridgeJob({ phase: 'error', msg: friendlyError(err) });
  } finally {
    signing = false;
  }
}
// LAND variant: proceeds are WETH already on Ethereum — no bridge, just unwrap to plain ETH.
// The unwrap runs in-place (its status shows here via patchCashout from setUnwrap).
function cashoutLandGuideInner() {
  const steps = [1, 2].map(i => `<li><span class="trade-cashout-num">${i}</span><span>${esc(t('trade.cashout.land.step' + i))}</span></li>`).join('');
  const unwrapping = unwrapState && (unwrapState.phase === 'send' || unwrapState.phase === 'wait');
  return `
    <span class="apply-pill">${esc(t('trade.cashout.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.cashout.guide.h'))}</h3>
    <div class="trade-cashout-warn"><span aria-hidden="true">${ico('alert', 19)}</span><p>${esc(t('trade.cashout.land.warn'))}</p></div>
    <ol class="trade-cashout-steps">${steps}</ol>
    ${shell.unwrapStatusHtml()}
    <div class="trade-safety-actions">
      <button class="apply-btn-ghost" data-act="cashout-back" type="button">${esc(t('trade.cashout.back'))}</button>
      <button class="trade-send trade-safety-ok" data-act="unwrap-weth" type="button" ${unwrapping ? 'disabled' : ''}>${esc(t('trade.cashout.land.unwrapBtn'))}</button>
    </div>
    <p class="trade-safety-foot">${esc(t('trade.cashout.land.foot'))}</p>`;
}

// --- View lifecycle -------------------------------------------------------------------

/**
 * True from the moment a transaction is handed to the wallet until it resolves or throws.
 *
 * As a modal there was no way to navigate while MetaMask had a prompt up. As a page,
 * "back to the market" is one click, and tearing the state down mid-signature would strand
 * a member who is still approving: runCashout re-checks `cashoutState !== st` after its
 * awaits and would silently abandon the run, leaving money moving with nothing tracking it.
 */
let signing = false;
export const isSigning = () => signing;

/** Repaint the flow card in place. Contents only — replacing the card replays its entrance. */
export function patchCashout() {
  if (!isOpen()) return;
  const card = root()?.querySelector('#trade-cashout-card');
  if (card) card.innerHTML = cashoutInner();
  const rail = root()?.querySelector('.trade-money-view .trade-money-rail');
  if (rail) rail.innerHTML = cashoutRailHtml();
}

/**
 * Open the view. `step` lets an entry point that has already said what it wants skip the
 * chooser — the sold card's button reads "Cash out to Ethereum", so following it with
 * "what next with your ETH?" is a dead beat.
 */
export function enterCashOut({ step = 'intent' } = {}) {
  cashoutStep = step;
  if (step === 'move') { openCashoutMove(); return; }
  cashoutState = null;
  // The rail answers "where is my money" for the whole page, not just the move step, so the
  // balances have to be read on arrival. No chain switch here: the chooser has not asked the
  // member to commit to anything yet, and a MetaMask network prompt on page load is startling.
  readCashoutBalances();
}

/**
 * Read the two zkEVM balances into cashoutState without touching the network. Only meaningful
 * while the wallet is actually on zkEVM: readNative reports whatever chain it is on, and
 * storing mainnet ETH as an IMX balance is how a member gets waved through a gas check they
 * cannot pass. Unknown stays unknown.
 */
async function readCashoutBalances() {
  if (!account || !isOpen()) return;
  cashoutState = { ...(cashoutState || {}), phase: 'load', balWei: null, imxWei: null };
  patchCashout();
  readMainnetBalances();
  const st = cashoutState;
  const [balWei, imxWei] = onZk()
    ? await Promise.all([readErc20(IMX_ETH_TOKEN, account), readNative(account)])
    : [null, null];
  if (cashoutState !== st) return; // navigated away or the move screen took over
  cashoutState = { ...st, phase: 'ready', balWei, imxWei };
  patchCashout();
}

/**
 * The Ethereum side of the rail. It has to come from the server: this flow deliberately keeps
 * the wallet on Immutable zkEVM, and a provider only ever answers for the chain it is on, so
 * the browser cannot read mainnet at all (CSP blocks external RPCs too).
 *
 * Merged into whatever cashoutState is current rather than replacing it, because the zkEVM
 * read runs alongside and either may land first. A failure leaves the figures null, which the
 * rail draws as an em dash — the honest answer, unlike a zero.
 */
async function readMainnetBalances() {
  if (!account) return;
  const res = await fetch(`/api/market/creatures/eth-elsewhere/${account}`)
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!res || !isOpen() || !cashoutState) return;
  const big = v => { try { return v != null ? BigInt(v) : null; } catch { return null; } };
  cashoutState.mainnetEthWei = big(res.mainnetEthWei);
  cashoutState.mainnetImxWei = big(res.mainnetImxWei);
  patchCashoutRail();
}

/** Repaint just the rail — the card may be mid-quote and must not lose its input. */
function patchCashoutRail() {
  const rail = root()?.querySelector('.trade-money-view .trade-money-rail');
  if (rail) rail.innerHTML = cashoutRailHtml();
}

/**
 * Leave the view. Two invariants, both learned the hard way:
 *  - bridgeJob is NEVER touched. It is the persisted, reload-surviving record of real money
 *    in motion, and the banner above every view is what keeps reporting on it.
 *  - a pending signature wins. If the wallet still has a prompt up, keep the state so the
 *    run function can finish; the next leave (or its own completion) clears it.
 * Returns false when it declined, so the caller can decide whether to still navigate.
 */
export function leaveCashOut() {
  clearTimeout(cashoutQuoteTimer);
  cashoutQuoteTimer = null;
  if (signing) return false;
  cashoutStep = 'intent';
  cashoutState = null;
  // The gas panel is shared; only drop it if it was ours.
  if (gasState?.ctx === 'cashout') setGasState(null);
  return true;
}

/** data-act names this view owns, and what each one does. The shell merges this into its switch. */
export const cashOutActs = {
  'cashout-guide': () => { cashoutStep = 'guide'; patchCashout(); },
  'cashout-move':  () => openCashoutMove(),
  'cashout-max':   () => cashoutMaxClick(),
  'cashout-now':   () => runCashout(),
  'cashout-back':  () => { cashoutStep = 'intent'; cashoutState = null; clearTimeout(cashoutQuoteTimer); patchCashout(); },
  'cashout-route': target => {
    const r = target.dataset.route;
    if (!CASHOUT_ROUTES.includes(r) || r === cashoutRoute) return;
    cashoutRoute = r;
    // The old quote priced a different route, so drop it rather than leave a stale number
    // on screen while the new one loads. Any gas panel belonged to the old route too, and
    // a deliberate pick clears the "we moved you" notice — they have seen it and acted.
    if (cashoutState) {
      cashoutState.quote = null; cashoutState.err = null; cashoutState.routeDownNotice = false;
      // Their choice, and it stands: this disarms the auto-pick for the rest of the session.
      cashoutState.routePicked = true; cashoutState.autoPicked = true;
    }
    if (gasState?.ctx === 'cashout') setGasState(null);
    patchCashoutMove();
    queueCashoutQuote(0);
  },
};

/** The amount box lives in this view; the shell forwards its input events here. */
export function onCashoutInput(el) {
  if (el?.id !== 'trade-cashout-amt') return false;
  if (cashoutState) { cashoutState.amount = el.value; queueCashoutQuote(); }
  return true;
}

/**
 * Drop everything this flow holds, without navigating. Used when the wallet changes account
 * under us: the balances, the quote and the route comparison all described someone else.
 * Same invariant as leaveCashOut — bridgeJob is not ours to clear.
 */
export function resetCashOut() {
  clearTimeout(cashoutQuoteTimer);
  cashoutQuoteTimer = null;
  cashoutState = null;
  cashoutStep = 'intent';
}

/** True when a bridge job belongs to this flow — the shell uses it to avoid a double tracker. */
export const ownsBridge = () => shell.isCashout(bridgeJob);

export { patchCashoutMove, queueCashoutQuote, confirmCanonicalDelivery };

/**
 * A bridge job was just dismissed. If it was ours and the member is still on the move
 * screen, re-read balances — the move just changed them, so the refreshed screen should
 * offer what is actually left rather than the figures from before it ran.
 */
export function onBridgeDismissed(wasOurs) {
  if (!isOpen()) return;
  if (wasOurs && cashoutStep === 'move') openCashoutMove();
  else patchCashout();
}

// Read-only peeks for the shared gas panel, which offers a one-tap switch to the cheaper
// route and therefore has to know which route is selected and what it would cost.
export { cashoutRoute, cashoutState, cashoutAmountWei };
