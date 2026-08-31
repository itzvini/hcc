// Add funds — a dedicated marketplace view at /trade/add-funds.
//
// The cash-out's mirror, and the same reasoning: this was a 460px modal, and a member
// bringing money ONTO a network they have never heard of needs to see both sides at once.
// The card's insides are byte-for-byte what the modal had; the shell, the URL and the
// meaning of "cancel" are what changed.
//
// It answers one question — "how do I get the money to buy this?" — and the answer depends
// on the collection, which is why the view is NOT Creatures-only. Creatures trade on
// Immutable zkEVM, so funding means bringing ETH over and topping up IMX for gas. LAND
// trades on Ethereum, where gas is ETH and there is nothing to bridge, so funding means
// buying ETH with a card or bringing it back from zkEVM. Both LAND routes already existed;
// hiding the button was what made them unfindable.

import { t } from '../i18n.js';
import { esc, root } from './core/dom.js';
import { account, coll, tradeTab, bridgeJob } from './core/state.js';
import {
  BRIDGE_GAS_RESERVE_ETH, BRIDGE_URL, IMX_ETH_TOKEN,
  GAS_BRIDGE_URL, GAS_BRIDGE_URL_IMX, GAS_MAX_IMX, GAS_OK_WEI, GAS_PRESETS_IMX, GAS_TARGET_IMX,
  BRIDGE_TERMINAL, CARD_PHASES, FUND_CHAINS, LS_AMOUNT_STEP_WEI, ZK_CHAIN_ID_HEX,
} from './core/consts.js';
import { fmtEth, fmtEthFiat, fmtFeeUsd, fmtImx, weiToEth, weiToEthStr } from './core/fmt.js';
import { eth, friendlyError, onZk, readErc20, readNative, switchToChain } from './core/chain.js';
import { cashoutHopHtml } from './cash-out.js';
import { shell } from './core/bus.js';
import { coinIco, ico } from './core/icons.js';
import { moneyRailHtml } from './money-rail.js';

/** Is this view the one on screen? Derived, so it can never drift from what is rendered. */
const isOpen = () => tradeTab === 'add-funds';

let topupStep = 'intent';    // 'intent' → 'eth' (move mainnet ETH over) | 'gas' (IMX top-up)
let topupState = null;       // {phase:'load'|'ready', mainnetEthWei, mainnetImxWei, imxWei, zkEthWei, amount, quote, err, gasQuote, gasFrom}
let topupSeq = 0;
let topupQuoteTimer = null;
// The cash-out's mirror, opened from the wallet bar BEFORE the user is mid-purchase.
// The in-checkout bridge (funds panel) only appears once a buy comes up short — anyone
// wanting to fund their wallet ahead of time used to get the external Squid deep-link,
// the same leave-the-site jump that spooks novices. Two options: move mainnet ETH over
// (exact-input quote, native source so no approval) and the ~5 IMX gas top-up (reuses
// the existing exact-output gas quote + one-tap machinery).
const TOPUP_RESERVE_WEI = BigInt(Math.round(BRIDGE_GAS_RESERVE_ETH * 1e6)) * 10n ** 12n;

function topupInner() {
  return topupStep === 'eth' ? topupEthInner() : topupStep === 'gas' ? topupGasInner() : topupIntentInner();
}
/**
 * The whole view. Same shell as the cash-out, mirrored: `is-in` themes it mint (money in)
 * against the cash-out's lavender (money out). The flow card keeps its
 * `.trade-safety-card .trade-cashout-card` classes so every existing rule and patch
 * selector still finds it.
 */
export function addFundsViewHtml() {
  return `
    <div class="trade-money-view is-in" data-money="add-funds">
      <header class="trade-money-head">
        <button class="trade-money-back" data-act="funds-exit" type="button">
          ${ico('chevronLeft', 15)} ${esc(t('trade.money.back'))}
        </button>
        <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
        <h2 class="trade-money-h">${esc(t('trade.topup.view.h'))}</h2>
        <p class="trade-money-lead">${esc(t(coll === 'land' ? 'trade.topup.view.lead.land' : 'trade.topup.view.lead'))}</p>
      </header>
      <div class="trade-money-grid">
        <div class="trade-safety-card trade-cashout-card is-view" id="trade-topup-card">${topupInner()}</div>
        <aside class="trade-money-rail">${topupRailHtml()}</aside>
      </div>
    </div>`;
}

/**
 * Where the member's money actually is, on both networks at once. Balances are the ones
 * refreshTopupBalances already read, so the rail costs no extra call. On LAND the arrow
 * flips: the money is wanted on Ethereum, not off it.
 */
function topupRailHtml() {
  const st = topupState || {};
  const land = coll === 'land';
  return moneyRailHtml({
    dir: land ? 'out' : 'in',
    loading: st.phase === 'load',
    bal: {
      mainnetEthWei: st.mainnetEthWei, mainnetImxWei: st.mainnetImxWei,
      zkEthWei: st.zkEthWei, zkImxWei: st.imxWei,
    },
    note: land ? 'trade.money.rail.inNote.land' : 'trade.money.rail.inNote',
  });
}

/**
 * Swap the card's CONTENTS, never the card itself. `.trade-safety-card` carries the
 * `apply-rise` entrance animation, so replacing that node replays the 0.45s rise — and this
 * runs on every balance refresh, step change and quote result, which is what made the panel
 * look like it kept re-opening on its own.
 */
export function patchTopup() {
  if (!isOpen()) return;
  const card = root()?.querySelector('#trade-topup-card');
  if (card) card.innerHTML = topupInner();
  const rail = root()?.querySelector('.trade-money-view .trade-money-rail');
  if (rail) rail.innerHTML = topupRailHtml();
}
// Patch only the quote area + balance line — the amount input keeps focus while typing.
function patchTopupMove() {
  const slot = root()?.querySelector('#trade-topup-qslot');
  if (slot) slot.innerHTML = topupQuoteAreaHtml();
  const bal = root()?.querySelector('#trade-topup-balline');
  if (bal) bal.innerHTML = topupBalLineHtml();
  // The custody sentence names whoever will be holding the money, which is only known once
  // a quote has landed. Without this it keeps whatever it said before the first quote, and
  // a Layerswap move sits under "your money never leaves your own wallet" — comfortable,
  // and not true.
  const foot = root()?.querySelector('#trade-topup-foot');
  if (foot) foot.textContent = t(topupFootKey());
}
// Same idea for the gas step's amount box.
function patchTopupGas() {
  const slot = root()?.querySelector('#trade-topup-gasqslot');
  if (slot) slot.innerHTML = topupGasQuoteAreaHtml();
}

// Balances on BOTH chains: mainnet via the server (the wallet can only ever read the one
// chain it is connected to; eth-elsewhere reads ETH + IMX on Ethereum for any address),
// zkEVM via the wallet — and only while the wallet is actually there. Off zkEVM, readNative
// reports MAINNET ETH, which stored as "your IMX" is how a member gets waved past a gas
// check they cannot pass. Unknown has to stay unknown.
async function refreshTopupBalances() {
  const st = topupState;
  if (!st) return;
  const zk = onZk();
  const [elsewhere, imxWei, zkEthWei] = await Promise.all([
    fetch(`/api/market/creatures/eth-elsewhere/${account}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
    zk ? readNative(account) : null,
    zk ? readErc20(IMX_ETH_TOKEN, account) : null,
  ]);
  if (topupState !== st || !isOpen()) return;
  const big = v => { try { return v != null ? BigInt(v) : null; } catch { return null; } };
  Object.assign(st, {
    phase: 'ready', imxWei, zkEthWei,
    mainnetEthWei: big(elsewhere?.mainnetEthWei),
    mainnetImxWei: big(elsewhere?.mainnetImxWei),
    // ETH on each L2 we can fund from, so the source picker can show a figure beside every
    // chain. Ethereum keeps its own field: it is read by the gas step too.
    chains: Object.fromEntries(Object.entries(elsewhere?.chains || {}).map(([k, v]) => [k, big(v)])),
  });
  // Land on the chain that actually holds something. Ethereum is the cheapest source when
  // it has funds, so it stays the default; but opening on an empty Ethereum while the
  // member's ETH sits on Base is a screen that answers the wrong question.
  if (!st.srcPicked) {
    const best = topupBestSource(st);
    if (best) st.src = best;
  }
  patchTopup();
}

/** Which source holds the most, or null when we cannot see any of them. */
function topupBestSource(st) {
  const all = { ethereum: st.mainnetEthWei, ...(st.chains || {}) };
  let bestKey = null;
  let bestWei = 0n;
  for (const key of Object.keys(FUND_CHAINS)) {
    const wei = all[key];
    if (wei == null || wei <= TOPUP_RESERVE_WEI) continue;
    // Ethereum wins ties: cheapest bridge leg by an order of magnitude, so only a
    // strictly larger balance elsewhere should move the member off it.
    if (wei > bestWei) { bestWei = wei; bestKey = key; }
  }
  return bestKey;
}

/** The balance on the currently selected source chain, or null when unknown. */
function topupSrcBalWei(st = topupState) {
  if (!st) return null;
  return st.src === 'ethereum' ? st.mainnetEthWei ?? null : (st.chains || {})[st.src] ?? null;
}
/**
 * Enter the view. `step` lets a caller that already knows what it wants skip the chooser —
 * the gas panels elsewhere link straight to the IMX top-up.
 */
export function enterAddFunds({ step = 'intent' } = {}) {
  topupStep = step;
  topupState = { phase: 'load', mainnetEthWei: null, mainnetImxWei: null, imxWei: null, zkEthWei: null,
    chains: {}, src: 'ethereum', srcPicked: false, amount: '', quote: null, err: null, gasQuote: null, gasFrom: null };
  // No wallet, nothing to read: the view shows the connect gate instead, and asking the
  // server for the balances of "null" is a 404 nobody learns anything from.
  if (account) refreshTopupBalances();
}

// One chooser row. `art` is already-built HTML (a coin image or an icon), never a string to
// escape — and note the parameter is NOT called `ico`: that would shadow the icon helper the
// arrow below is drawn with.
function topupOptHtml(act, art, h, sub, { disabled = false, attrs = '' } = {}) {
  return `
    <button class="trade-cashout-opt" data-act="${act}" type="button" ${attrs} ${disabled ? 'disabled' : ''}>
      <span class="trade-cashout-opt-ico" aria-hidden="true">${art}</span>
      <span class="trade-cashout-opt-tx"><b>${esc(t(h))}</b><span>${esc(sub)}</span></span>
      <span class="trade-cashout-opt-arrow" aria-hidden="true">${ico('chevronRight', 16)}</span>
    </button>`;
}

/**
 * The chooser. Two collections, two different meanings of "add funds", and the reason this
 * view used to be hidden on LAND altogether:
 *
 *  - Creatures trade on Immutable zkEVM, so funding means bringing ETH over for the price
 *    and a little IMX for gas.
 *  - LAND trades on Ethereum itself, where gas is ETH and there is nothing to bridge. What
 *    a LAND buyer short of funds actually needs is ETH on Ethereum: bought with a card, or
 *    brought back from zkEVM if their Creature proceeds are sitting there.
 *
 * Hiding the button on LAND answered the first case by pretending the second didn't exist.
 * Both routes already worked — the card on-ramp from inside a failed buy, the zkEVM-to-
 * Ethereum move from the cash-out screen — they just had no entry point that said "funds".
 */
function topupIntentInner() {
  const st = topupState || {};
  const loading = st.phase === 'load';
  const land = coll === 'land';
  const hasMainnetEth = st.mainnetEthWei != null && st.mainnetEthWei > 0n;
  const mainnetLine = hasMainnetEth ? fmtEthFiat(weiToEth(st.mainnetEthWei)) : null;

  if (land) {
    const cardSub = loading ? t('trade.topup.checking')
      : mainnetLine ? t('trade.topup.opt.card.have').replace('{x}', mainnetLine)
        : t('trade.topup.opt.card.none');
    return `
      <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
      <h3 class="trade-safety-h">${esc(t('trade.topup.land.h'))}</h3>
      <p class="trade-safety-p">${esc(t('trade.topup.land.p'))}</p>
      <div class="trade-cashout-opts">
        ${topupOptHtml('onramp', ico('card', 22), 'trade.topup.opt.card.h', cardSub,
          { disabled: loading, attrs: 'data-chain="ethereum" data-token="ETH"' })}
        ${topupOptHtml('cashout-open', coinIco('ETH', 24), 'trade.topup.opt.back.h',
          t('trade.topup.opt.back.p'), { attrs: 'data-step="move"' })}
      </div>
      <p class="trade-safety-foot">${esc(t('trade.topup.land.foot'))}</p>`;
  }

  const ethSub = loading ? t('trade.topup.checking')
    : mainnetLine ? t('trade.topup.opt.eth.have').replace('{x}', mainnetLine)
      : t('trade.topup.opt.eth.none');
  const gasSub = loading ? t('trade.topup.checking')
    : st.imxWei == null ? t('trade.topup.opt.gas.unknown')
      : t('trade.topup.opt.gas.have').replace('{x}', fmtImx(weiToEth(st.imxWei)));

  // Card straight onto zkEVM. Transak delivers ETH on Immutable zkEVM natively, so a member
  // starting from an empty wallet needs no mainnet ETH and no bridge at all — one purchase
  // and they can buy. It leads when there is nothing on Ethereum to move, because then it is
  // the only option on this screen that goes anywhere.
  const buy = topupOptHtml('onramp', ico('card', 22), 'trade.topup.opt.buy.h',
    t('trade.topup.opt.buy.p'), { disabled: loading, attrs: 'data-chain="zkevm" data-token="ETH"' });
  const move = topupOptHtml('topup-eth', coinIco('ETH', 24), 'trade.topup.opt.eth.h', ethSub, { disabled: loading });

  return `
    <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.topup.h'))}</h3>
    <p class="trade-safety-p">${esc(t('trade.topup.p'))}</p>
    <div class="trade-cashout-opts">
      ${mainnetLine ? move + buy : buy + move}
      ${topupOptHtml('topup-gas', coinIco('IMX', 24), 'trade.topup.opt.gas.h', gasSub, { disabled: loading })}
    </div>
    <p class="trade-safety-foot">${esc(t('trade.topup.foot'))}</p>`;
}

// The typed amount as wei (comma-tolerant), or null when unparseable/zero.
function topupAmountWei() {
  const v = String(topupState?.amount ?? '').trim().replace(',', '.');
  const m = /^(\d{1,6})(?:\.(\d{1,18}))?$/.exec(v);
  if (!m) return null;
  const wei = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0'));
  return wei > 0n ? wei : null;
}
// The most they can move from the chosen source: its balance minus the gas that source's
// own send will cost. The reserve is sized for Ethereum, which is the expensive case; on an
// L2 it leaves more headroom than needed, and leaving too much is the safe direction.
function topupMaxWei() {
  const bal = topupSrcBalWei();
  if (bal == null) return null;
  const max = bal - TOPUP_RESERVE_WEI;
  return max > 0n ? max : null;
}
function topupBalLineHtml() {
  const st = topupState || {};
  if (st.phase === 'load') return `<span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.cashout.move.balLoading'))}`;
  const bal = topupSrcBalWei(st);
  if (bal == null) return esc(t('trade.cashout.move.balUnknown'));
  return esc(t('trade.topup.eth.bal')
    .replace('{x}', fmtEthFiat(weiToEth(bal)))
    .replace('{n}', FUND_CHAINS[st.src]?.label || ''));
}
/**
 * Where the ETH is coming FROM. Four chips, each showing that chain's balance.
 *
 * This exists because "move my ETH from Ethereum" assumed the only ETH a member could have
 * was on Ethereum, and that is not how anyone holds crypto: exchanges withdraw to whichever
 * network is cheapest, which is almost never mainnet. Measured 2026-08-31, Ethereum is still
 * the cheapest LEG (about a cent against 40 on a $300 move), so it leads and stays the
 * default — but a member whose money is on Base should not have to move it to Ethereum
 * first just to use this screen.
 *
 * A chain we could not read shows an em dash and stays pickable: unknown is not empty, and
 * refusing to let someone try because a public node timed out is the worse failure.
 */
function topupSrcPickerHtml() {
  const st = topupState || {};
  const loading = st.phase === 'load';
  const chips = Object.entries(FUND_CHAINS).map(([key, c]) => {
    const wei = key === 'ethereum' ? st.mainnetEthWei : (st.chains || {})[key];
    const bal = loading ? '' : wei == null ? '—' : fmtEth(weiToEth(wei));
    return `
      <button class="trade-src-chip${st.src === key ? ' is-on' : ''}" data-act="topup-src" data-src="${esc(key)}"
        type="button" role="tab" aria-selected="${st.src === key}" ${loading ? 'disabled' : ''}>
        <span class="trade-src-net">${esc(c.label)}</span>
        <span class="trade-src-bal">${loading ? '<span class="trade-mini-spin" aria-hidden="true"></span>' : esc(bal)}</span>
      </button>`;
  }).join('');
  return `
    <span class="trade-cashout-amtlbl">${esc(t('trade.topup.src.h'))}</span>
    <div class="trade-src-picks" role="tablist" aria-label="${esc(t('trade.topup.src.h'))}">${chips}</div>
    ${st.src !== 'ethereum' ? `<p class="trade-src-note">${esc(t('trade.topup.src.note'))}</p>` : ''}`;
}

function topupQuoteAreaHtml() {
  const st = topupState || {};
  const q = st.quote;
  // Quoting unavailable altogether (Squid not configured) → the prefilled deep-link.
  if (st.err === 'fallback') return `<a class="trade-funds-btn" href="${BRIDGE_URL}" target="_blank" rel="noopener">${esc(t('trade.funds.bridgeBtn'))} ${ico('external', 14)}</a>`;
  const ERR = { over: 'trade.topup.eth.err.over', amount: 'trade.cashout.move.err.amount', small: 'trade.cashout.move.err.small', rate: 'trade.err.rate', quote: 'trade.cashout.move.err.quote', srcdown: 'trade.topup.src.down' };
  if (st.err && st.err !== 'gas') return `<div class="trade-status is-error"><span aria-hidden="true">${ico('alert', 17)}</span><span>${esc(t(ERR[st.err]))}</span></div>`;
  if (q === 'loading') return `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.bridge.quote.loading'))}</div>`;
  if (!q) return '';
  // Name the provider that will actually hold the money, and quote its own ETA in its own
  // unit: rounding Layerswap's 7 seconds up to "about 1 minute" reads as a stall on a screen
  // that finishes before the member has looked away.
  const ls = q.provider === 'layerswap';
  const secs = Number(q.durationSeconds) || 0;
  const when = !secs ? null
    : secs < 90 ? t('trade.cashout.move.secs').replace('{s}', String(secs))
      : t('trade.bridge.quote.mins').replace('{m}', String(Math.max(1, Math.ceil(secs / 60))));
  const meta = [
    q.feeUsd != null ? t('trade.bridge.quote.fees').replace('{f}', fmtFeeUsd(q.feeUsd)) : null,
    when,
    t(ls ? 'trade.cashout.move.byLs' : 'trade.bridge.quote.by'),
  ].filter(Boolean).join(' · ');
  const feesShort = st.err === 'gas';
  const busy = bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase);
  return `
    <div class="trade-bridge-quote">
      <div class="trade-bridge-line">${esc(t('trade.topup.eth.quoteLine').replace('{y}', fmtEthFiat(q.toEth)))}</div>
      <div class="trade-bridge-meta">${esc(meta)}</div>
      ${feesShort ? `<div class="trade-status is-error"><span aria-hidden="true">${ico('alert', 17)}</span><span>${esc(t('trade.topup.eth.err.fees'))}</span></div>` : ''}
      <button class="trade-funds-btn" data-act="topup-now" type="button" ${feesShort || busy ? 'disabled' : ''}>${esc(t('trade.topup.eth.btn'))}</button>
      ${st.src === 'ethereum' ? `<button class="trade-cashout-diy" data-act="topup-route" type="button">${esc(t(ls ? 'trade.topup.route.official' : 'trade.topup.route.fast'))}</button>` : ''}
      ${bridgeJob && !shell.isGasBridge(bridgeJob) && !shell.isOutBridge(bridgeJob) ? shell.bridgeStatusHtml() : ''}
    </div>`;
}
function topupEthInner() {
  // A funding move is underway/finished — the tracker card takes over (this also covers
  // a checkout-shortfall bridge already in flight: same job, same truth).
  if (bridgeJob && !shell.isGasBridge(bridgeJob) && !shell.isOutBridge(bridgeJob) && CARD_PHASES.has(bridgeJob.phase)) {
    return `
      <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
      ${shell.bridgeCardHtml(bridgeJob)}
      <p class="trade-safety-foot">${esc(t('trade.topup.foot'))}</p>`;
  }
  const st = topupState || {};
  // Known-empty mainnet wallet: nothing to move, so send them to the card instead — and
  // straight onto zkEVM, not to Ethereum. Buying on Ethereum only to bridge it back is a
  // second fee and a second wait for no gain once Transak will deliver on zkEVM directly.
  // Nothing to move ANYWHERE we can see, not just on Ethereum: with four sources on offer,
  // showing the card dead end because mainnet is empty would hide a wallet that has funds
  // sitting on Base.
  const seen = [st.mainnetEthWei, ...Object.values(st.chains || {})].filter(w => w != null);
  const noEth = st.phase === 'ready' && seen.length > 0 && seen.every(w => w <= TOPUP_RESERVE_WEI);
  const body = noEth ? `
    <p class="trade-cashout-balline">${esc(t('trade.topup.eth.none'))}</p>
    <button class="trade-funds-btn" data-act="onramp" data-chain="zkevm" data-token="ETH" type="button">${esc(t('trade.onramp.btn'))} ${ico('card', 15)}</button>` : `
    ${topupSrcPickerHtml()}
    <label class="trade-cashout-amtlbl" for="trade-topup-amt">${esc(t('trade.cashout.move.amount'))}</label>
    <div class="trade-cashout-amtrow">
      <input id="trade-topup-amt" class="trade-cashout-amt" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
        value="${esc(st.amount || '')}" placeholder="0.05" ${st.phase === 'load' ? 'disabled' : ''}>
      <span class="trade-cashout-unit" aria-hidden="true">ETH</span>
      <button class="trade-cashout-max" data-act="topup-max" type="button" ${topupMaxWei() ? '' : 'disabled'}>${esc(t('trade.cashout.move.max'))}</button>
    </div>
    <p class="trade-cashout-balline" id="trade-topup-balline">${topupBalLineHtml()}</p>
    <div id="trade-topup-qslot">${topupQuoteAreaHtml()}</div>`;
  // With nothing to move, the Ethereum → zkEVM hop diagram describes a journey that isn't
  // going to happen: the only button on screen buys on zkEVM directly. Heading and diagram
  // both step aside rather than contradict the action underneath them.
  return `
    <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t(noEth ? 'trade.topup.eth.buyH' : 'trade.topup.eth.h'))}</h3>
    ${noEth ? '' : `
    <p class="trade-safety-p">${esc(t('trade.topup.eth.p'))}</p>
    <div class="trade-cashout-route">
      ${cashoutHopHtml('trade.cashout.move.from', '/img/brands/eth.png', FUND_CHAINS[st.src]?.label || 'Ethereum', 'trade.topup.eth.fromSub')}
      <div class="trade-cashout-hop-arrow" aria-hidden="true">${ico('chevronDown', 18)}</div>
      ${cashoutHopHtml('trade.cashout.move.to', '/img/brands/immutable.png', 'Immutable zkEVM', 'trade.topup.eth.toSub')}
    </div>`}
    ${body}
    <div class="trade-safety-actions">
      <button class="apply-btn-ghost" data-act="topup-back" type="button">${esc(t('trade.cashout.back'))}</button>
    </div>
    <p class="trade-safety-foot" id="trade-topup-foot">${esc(t(topupFootKey()))}</p>`;
}

// Which custody sentence belongs under this screen. Layerswap holds the ETH for the seconds
// it is in flight; the canonical route never does. Saying "your money never leaves your own
// wallet" over a Layerswap move would be a comfortable sentence that is not true.
function topupFootKey() {
  const q = topupState?.quote;
  return (q && q !== 'loading' && q.provider === 'layerswap') ? 'trade.topup.footLs' : 'trade.topup.foot';
}

function queueTopupQuote(ms = 500) {
  clearTimeout(topupQuoteTimer);
  topupQuoteTimer = setTimeout(fetchTopupQuote, ms);
}
async function fetchTopupQuote() {
  const st = topupState;
  if (!st || topupStep !== 'eth') return;
  const seq = ++topupSeq;
  const wei = topupAmountWei();
  if (wei == null) { st.quote = null; st.err = String(st.amount).trim() ? 'amount' : null; return patchTopupMove(); }
  if (st.mainnetEthWei != null && wei + TOPUP_RESERVE_WEI > st.mainnetEthWei) { st.quote = null; st.err = 'over'; return patchTopupMove(); }
  st.quote = 'loading'; st.err = null;
  patchTopupMove();
  const src = st.src || 'ethereum';
  // The member asked for the canonical bridge. It exists only from Ethereum, so the choice
  // is dropped the moment they pick another source (see the 'topup-src' action).
  const canonical = st.route === 'canonical' && src === 'ethereum';
  try {
    if (canonical) {
      const cres = await fetch('/api/market/creatures/topup/quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: account, amountEth: weiToEthStr(wei) }),
        signal: AbortSignal.timeout(30000),
      });
      const cbody = await cres.json().catch(() => ({}));
      if (topupSeq !== seq || topupState !== st) return;
      if (!cres.ok) {
        st.quote = null;
        st.err = cbody.error === 'not_configured' ? 'fallback'
          : cbody.error === 'no_route' ? 'small' : cbody.error === 'rate_limited' ? 'rate' : 'quote';
        return patchTopupMove();
      }
      st.quote = cbody;
      st.quoteSrc = src;
      const cbal = topupSrcBalWei(st);
      let cspend = wei;
      try { if (cbody.tx?.value) cspend = BigInt(cbody.tx.value); } catch { /* keep the input */ }
      st.err = (cbal != null && cbal < cspend + TOPUP_RESERVE_WEI) ? 'gas' : null;
      return patchTopupMove();
    }
    // Layerswap first, for every source. Measured 2026-08-31 on the same corridor it beats
    // the Squid route on both axes at once — $0.009 against $0.11 and 7 seconds against 17
    // minutes from Ethereum — and from an L2 it is not close, because Squid has to swap into
    // thin zkEVM ETH ($1.28 against $17 on a $1,000 move).
    let res = await fetch('/api/market/creatures/topup/ls/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountEth: weiToEthStr(wei), source: src }),
      signal: AbortSignal.timeout(30000),
    });
    let body = await res.json().catch(() => ({}));
    // Layerswap is a solver: a corridor exists only while somebody holds the float, so it
    // can be down while everything else is fine. From Ethereum the canonical bridge is
    // always there, so fall back to it rather than telling a member to come back later.
    // From an L2 there is no canonical route to fall back TO, and saying so is the honest
    // answer — pointing them at Ethereum is what the error copy does.
    if (!res.ok && src === 'ethereum' && body.error !== 'no_route') {
      res = await fetch('/api/market/creatures/topup/quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: account, amountEth: weiToEthStr(wei) }),
        signal: AbortSignal.timeout(30000),
      });
      body = await res.json().catch(() => ({}));
    }
    if (topupSeq !== seq || topupState !== st) return; // superseded
    if (!res.ok) {
      st.quote = null;
      st.err = body.error === 'not_configured' ? (src === 'ethereum' ? 'fallback' : 'srcdown')
        : body.error === 'route_down' ? 'srcdown'
          : body.error === 'no_route' ? 'small' : body.error === 'rate_limited' ? 'rate' : 'quote';
      return patchTopupMove();
    }
    st.quote = body;
    st.quoteSrc = src;
    // What the wallet will actually be asked to part with, plus that transaction's own gas.
    // Layerswap sends the amount itself; the Squid route's tx.value carries the relay fee on
    // top. Either way, flag the shortfall here rather than let MetaMask fail it cryptically.
    const bal = topupSrcBalWei(st);
    let spend = wei;
    try { if (body.tx?.value) spend = BigInt(body.tx.value); } catch { /* keep the input */ }
    st.err = (bal != null && bal < spend + TOPUP_RESERVE_WEI) ? 'gas' : null;
    patchTopupMove();
  } catch {
    if (topupSeq !== seq || topupState !== st) return;
    st.quote = null; st.err = 'quote';
    patchTopupMove();
  }
}
function topupMaxClick() {
  const st = topupState;
  const max = topupMaxWei();
  if (!st || max == null) return;
  st.amount = weiToEthStr(max);
  const input = root()?.querySelector('#trade-topup-amt');
  if (input) input.value = st.amount;
  clearTimeout(topupQuoteTimer);
  fetchTopupQuote();
}
async function runTopupEth() {
  const st = topupState;
  const q = st?.quote;
  if (!q || q === 'loading' || st.err === 'gas') return;
  // Layerswap mints its transaction only when the member commits, so a missing `tx` is
  // normal there. The canonical Squid quote carries one and must not be signed without it.
  if (q.provider !== 'layerswap' && !q.tx) return;
  // Arrival target for the tracker's balance signal: what's on zkEVM now plus most of
  // the quoted arrival (the estimate can drift a little; the provider's status is primary).
  let needWei = 0n;
  const cur = await readErc20(IMX_ETH_TOKEN, account);
  const toWei = BigInt(Math.round((Number(q.toEth) || 0) * 1e6)) * 10n ** 12n;
  if (cur != null && toWei > 0n) needWei = cur + (toWei * 95n) / 100n;
  if (q.provider === 'layerswap') return runTopupLayerswap(q, needWei);
  return shell.runBridge(q, { kind: 'eth', needWei, fromChainHex: '0x1' });
}

/**
 * Fund through Layerswap, from whichever chain the member picked.
 *
 * The cash-out's Layerswap leg signs an ERC-20 `transfer`, where the recipient and the
 * amount live inside calldata we decode. This one is the opposite shape: ETH is the NATIVE
 * coin on every source chain, so the money rides in `value` and the calldata is a 32-byte
 * attribution memo. That means a value-carrying send to an address this file cannot verify,
 * so the same three questions get asked here as on the server, against the numbers this
 * screen actually asked for: who receives it, how much, and on which chain.
 *
 * Checking again on the client is not redundant. The server's answer arrives over the
 * network; the wallet prompt is the last point at which anybody can still refuse.
 */
async function runTopupLayerswap(q, needWei) {
  if (bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase)) return; // one bridge at a time
  const st = topupState;
  const src = FUND_CHAINS[st?.src];
  if (!src) return;
  signing = true; // from here the wallet may have a prompt up — teardown must not run
  try {
    shell.setBridgeJob({ phase: 'switch', kind: 'eth', account, mins: null, startedAt: Date.now(),
      fromSym: 'ETH', toSym: 'ETH', fromEth: q.fromEth, toEth: q.toEth });
    patchTopup();
    shell.patchBridgeBanner();
    await switchToChain(src.hex);

    // Mint against the amount showing on screen right now, not the one the quote was taken
    // with: the member may have edited the box while the quote settled.
    const wei = topupAmountWei();
    if (wei == null) { shell.setBridgeJob({ phase: 'error', msg: t('trade.cashout.move.err.amount') }); return; }
    const res = await fetch('/api/market/creatures/topup/ls/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account, amountEth: weiToEthStr(wei), source: st.src }),
      signal: AbortSignal.timeout(30000),
    });
    const swap = await res.json().catch(() => ({}));
    if (!res.ok || !swap.tx?.to || !swap.swapId) {
      const key = swap.error === 'route_down' ? 'trade.topup.src.down'
        : swap.error === 'no_route' ? 'trade.cashout.move.err.small'
          : 'trade.cashout.move.err.quote';
      shell.setBridgeJob({ phase: 'error', msg: t(key) });
      return;
    }
    // It must leave from the chain the member chose. A swap minted for another network would
    // be signed on this one, and the deposit would never be credited.
    if (String(swap.chainHex || '').toLowerCase() !== src.hex) {
      console.error('Layerswap top-up chain mismatch', { got: swap.chainHex, want: src.hex });
      shell.setBridgeJob({ phase: 'error', msg: t('trade.cashout.move.err.quote') });
      return;
    }
    // Recipient: a real address, not the burn hole, and not the member (a no-op that burns
    // gas and credits no swap).
    const to = String(swap.tx.to).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(to) || to === '0x' + '0'.repeat(40) || to === account.toLowerCase()) {
      console.error('Layerswap top-up bad recipient', to);
      shell.setBridgeJob({ phase: 'error', msg: t('trade.cashout.move.err.quote') });
      return;
    }
    // Amount: exactly what this screen asked for, floored to the 1e-8 ETH step Layerswap
    // prices in. Same reasoning as the cash-out — the box carries 18 decimals and they do
    // not, so equality against the raw value refuses very nearly every real wallet.
    const wantWei = wei - (wei % LS_AMOUNT_STEP_WEI);
    let value = null;
    try { value = BigInt(swap.tx.value || '0x0'); } catch { value = null; }
    if (value == null || value !== wantWei) {
      console.error('Layerswap top-up amount mismatch', { got: String(value), want: String(wantWei) });
      shell.setBridgeJob({ phase: 'error', msg: t('trade.cashout.move.err.quote') });
      return;
    }
    // The memo. Empty or exactly 32 bytes; anything longer is a call nobody has read, riding
    // on a transaction that carries money.
    const data = String(swap.tx.data || '0x');
    if (!/^0x([0-9a-f]{64})?$/i.test(data)) {
      console.error('Layerswap top-up unexpected call_data', data.slice(0, 24));
      shell.setBridgeJob({ phase: 'error', msg: t('trade.cashout.move.err.quote') });
      return;
    }
    // And it has to be ETH they actually hold ON THIS CHAIN. The wallet is here now, so this
    // read is the source of truth — the picker's figure came from a server-side snapshot.
    const balNow = await readNative(account).catch(() => null);
    if (balNow != null && value + TOPUP_RESERVE_WEI > balNow) {
      shell.setBridgeJob({ phase: 'error', msg: t('trade.topup.eth.err.over') });
      return;
    }

    shell.setBridgeJob({ phase: 'confirm' });
    const hash = await eth().request({
      method: 'eth_sendTransaction',
      params: [{ from: account, to: swap.tx.to, value: swap.tx.value, ...(data === '0x' ? {} : { data }) }],
    });
    shell.setBridgeJob({ phase: 'back', hash });
    await switchToChain(ZK_CHAIN_ID_HEX); // back to where the money is landing
    shell.setBridgeJob({
      phase: 'waiting', hash, swapId: swap.swapId, mins: null, startedAt: Date.now(), stage: 'submitted',
      kind: 'eth', axelarUrl: null, needWei: needWei.toString(), quoteId: '', requestId: '', account,
      fromSym: 'ETH', toSym: 'ETH', fromEth: swap.fromEth ?? q.fromEth, toEth: swap.toEth ?? q.toEth,
    });
    shell.trackBridge();
  } catch (err) {
    console.error('Layerswap top-up failed:', err);
    shell.setBridgeJob({ phase: 'error', msg: friendlyError(err) });
  } finally {
    signing = false;
  }
}

// IMX gas option: an exact-OUTPUT quote ("bring me this much IMX"), so the member picks the
// amount they want to land on zkEVM and we work backwards to what they send. Reuses the
// one-tap flow the Buy/Sell/Transfer panels already use, just reachable before anything
// fails for gas.
async function openTopupGas() {
  const st = topupState;
  if (!st || st.phase !== 'ready') return;
  topupStep = 'gas';
  st.err = null;
  st.gasErr = null;
  if (!st.gasAmount) st.gasAmount = String(GAS_TARGET_IMX); // default, editable
  st.gasFrom = st.mainnetImxWei != null && st.mainnetImxWei > 0n ? 'imx'
    : st.mainnetEthWei != null && st.mainnetEthWei > TOPUP_RESERVE_WEI ? 'eth' : null;
  if (!st.gasFrom) { st.gasQuote = null; patchTopup(); return; }
  patchTopup();
  fetchTopupGasQuote();
}

// The requested IMX as wei, or null when the box doesn't hold a usable number.
function topupGasAmountWei() {
  const v = String(topupState?.gasAmount ?? '').trim().replace(',', '.');
  const m = /^(\d{1,6})(?:\.(\d{1,18}))?$/.exec(v);
  if (!m) return null;
  const wei = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0'));
  return wei > 0n ? wei : null;
}

// A touch slower than the ETH step's 500ms on purpose: this is an exact-OUTPUT quote, so
// Squid may need up to three sequential calls to converge on one answer. Typing "12.5"
// would otherwise spend nine calls against a rate limit shared by every user on the site.
function queueTopupGasQuote(ms = 800) {
  clearTimeout(topupQuoteTimer);
  topupQuoteTimer = setTimeout(() => fetchTopupGasQuote(), ms);
}

// Quote the chosen amount, then check they can actually afford to send it. Without that
// last step a member could ask for 25 IMX holding a dollar of ETH, get a clean-looking
// quote, and only find out when MetaMask failed the transaction cryptically.
async function fetchTopupGasQuote({ retried = false } = {}) {
  const st = topupState;
  if (!st || topupStep !== 'gas' || !st.gasFrom) return;
  const seq = ++topupSeq;
  const wei = topupGasAmountWei();
  if (wei == null) {
    st.gasQuote = null;
    st.gasErr = String(st.gasAmount ?? '').trim() ? 'amount' : null;
    return patchTopupGas();
  }
  if (wei > BigInt(GAS_MAX_IMX) * 10n ** 18n) {
    st.gasQuote = null; st.gasErr = 'over';
    return patchTopupGas();
  }
  st.gasQuote = 'loading'; st.gasErr = null;
  patchTopupGas();
  try {
    const res = await fetch('/api/market/creatures/bridge/gas/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: account, needImx: weiToEthStr(wei), from: st.gasFrom }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => null);
    if (topupSeq !== seq || topupState !== st || topupStep !== 'gas') return; // superseded
    if (!res.ok || !body?.tx) {
      // Squid's rate limit is per integrator id and therefore shared across all our
      // users, so a 429 usually means "someone else just quoted", not "this won't work".
      // The server already backs off internally; give it one more window here rather than
      // showing a dead end. Same treatment showGasHelp gives its own quote.
      if (body?.error === 'rate_limited' && !retried) {
        await new Promise(r => setTimeout(r, 1500));
        if (topupSeq !== seq || topupState !== st || topupStep !== 'gas') return;
        return fetchTopupGasQuote({ retried: true });
      }
      st.gasQuote = null;
      st.gasErr = body?.error === 'not_configured' ? 'fallback'
        : body?.error === 'no_route' ? 'small'
        : body?.error === 'rate_limited' ? 'rate' : 'quote';
      return patchTopupGas();
    }
    st.gasQuote = body;
    st.gasErr = gasAffordability(st, body);
    patchTopupGas();
  } catch {
    if (topupSeq !== seq || topupState !== st) return;
    st.gasQuote = null; st.gasErr = 'quote';
    patchTopupGas();
  }
}

// Can this wallet cover the move it's about to sign? Returns an error key or null.
// Sending mainnet ETH: the wallet pays tx.value plus that transaction's own L1 gas.
// Sending mainnet IMX (an ERC-20): it needs the IMX itself, and still some ETH for gas.
function gasAffordability(st, q) {
  try {
    if (st.gasFrom === 'eth') {
      const need = BigInt(q.tx.value || '0x0') + TOPUP_RESERVE_WEI;
      return st.mainnetEthWei != null && st.mainnetEthWei < need ? 'fees' : null;
    }
    const fromWei = BigInt(Math.round((Number(q.fromEth) || 0) * 1e6)) * 10n ** 12n;
    if (st.mainnetImxWei != null && fromWei > 0n && st.mainnetImxWei < fromWei) return 'overImx';
    if (st.mainnetEthWei != null && st.mainnetEthWei < TOPUP_RESERVE_WEI) return 'fees';
    return null;
  } catch { return null; }
}
function topupGasInner() {
  if (shell.isGasBridge(bridgeJob) && CARD_PHASES.has(bridgeJob.phase)) {
    return `
      <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
      ${shell.bridgeCardHtml(bridgeJob)}
      <p class="trade-safety-foot">${esc(t('trade.topup.foot'))}</p>`;
  }
  const st = topupState || {};
  const gasOk = st.imxWei != null && st.imxWei >= GAS_OK_WEI;
  const balLine = st.phase === 'load'
    ? `<span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.cashout.move.balLoading'))}`
    : esc(t(gasOk ? 'trade.topup.gas.balOk' : 'trade.topup.gas.bal').replace('{x}', fmtImx(weiToEth(st.imxWei ?? 0n))));

  // Nothing on Ethereum to bridge or swap — no amount to pick, so skip straight to the
  // card on-ramp, which delivers IMX to Immutable zkEVM directly.
  if (!st.gasFrom && st.phase === 'ready') {
    return `
      <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
      <h3 class="trade-safety-h">${esc(t('trade.topup.gas.h'))}</h3>
      <p class="trade-safety-p">${esc(t('trade.topup.gas.p'))}</p>
      <p class="trade-cashout-balline">${balLine}</p>
      <p class="trade-cashout-balline">${esc(t('trade.topup.gas.none'))}</p>
      <button class="trade-funds-btn" data-act="onramp" data-chain="zkevm" data-token="IMX" type="button">${esc(t('trade.onramp.btn'))} ${ico('card', 15)}</button>
      <div class="trade-safety-actions">
        <button class="apply-btn-ghost" data-act="topup-back" type="button">${esc(t('trade.cashout.back'))}</button>
      </div>
      <p class="trade-safety-foot">${esc(t('trade.topup.foot'))}</p>`;
  }

  const current = String(st.gasAmount ?? '').trim();
  const chips = GAS_PRESETS_IMX.map(n => `
    <button class="trade-gas-chip${current === String(n) ? ' is-on' : ''}" data-act="topup-gas-preset" data-imx="${n}"
      type="button" aria-pressed="${current === String(n)}">${esc(n.toLocaleString())}</button>`).join('');

  return `
    <span class="apply-pill">${esc(t('trade.topup.badge'))}</span>
    <h3 class="trade-safety-h">${esc(t('trade.topup.gas.h'))}</h3>
    <p class="trade-safety-p">${esc(t('trade.topup.gas.p'))}</p>
    <p class="trade-cashout-balline">${balLine}</p>
    <label class="trade-cashout-amtlbl" for="trade-topup-gas-amt">${esc(t('trade.topup.gas.amount'))}</label>
    <div class="trade-gas-chips" role="group" aria-label="${esc(t('trade.topup.gas.presets'))}">${chips}</div>
    <div class="trade-cashout-amtrow">
      <input id="trade-topup-gas-amt" class="trade-cashout-amt" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
        value="${esc(current)}" placeholder="${GAS_TARGET_IMX}" ${st.phase === 'load' ? 'disabled' : ''}>
      <span class="trade-cashout-unit" aria-hidden="true">IMX</span>
    </div>
    <div id="trade-topup-gasqslot">${topupGasQuoteAreaHtml()}</div>
    <div class="trade-safety-actions">
      <button class="apply-btn-ghost" data-act="topup-back" type="button">${esc(t('trade.cashout.back'))}</button>
    </div>
    <p class="trade-safety-foot">${esc(t('trade.topup.foot'))}</p>`;
}

// The quote + CTA for the gas step. Split out of topupGasInner so a keystroke repaints
// only this, leaving the amount input (and its caret) alone.
function topupGasQuoteAreaHtml() {
  const st = topupState || {};
  const g = st.gasQuote;
  if (st.gasErr === 'fallback') {
    return `<a class="trade-funds-btn" href="${st.gasFrom === 'imx' ? GAS_BRIDGE_URL_IMX : GAS_BRIDGE_URL}" target="_blank" rel="noopener">${esc(t('trade.gas.getBtn'))} ${ico('external', 14)}</a>`;
  }
  // Errors that mean "there's no quote to show".
  const HARD = {
    amount: 'trade.cashout.move.err.amount',
    over: 'trade.topup.gas.err.over',
    small: 'trade.cashout.move.err.small',
    rate: 'trade.err.rate',
    quote: 'trade.cashout.move.err.quote',
  };
  if (st.gasErr && HARD[st.gasErr]) {
    const msg = t(HARD[st.gasErr]).replace('{x}', fmtImx(GAS_MAX_IMX));
    return `<div class="trade-status is-error"><span aria-hidden="true">${ico('alert', 17)}</span><span>${esc(msg)}</span></div>`;
  }
  if (g === 'loading') return `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.bridge.quote.loading'))}</div>`;
  if (!g || !g.tx) return '';

  const mins = g.durationSeconds ? Math.max(1, Math.ceil(g.durationSeconds / 60)) : null;
  const meta = [
    g.feeUsd != null ? t('trade.bridge.quote.fees').replace('{f}', fmtFeeUsd(g.feeUsd)) : null,
    mins != null ? t('trade.bridge.quote.mins').replace('{m}', String(mins)) : null,
    t('trade.bridge.quote.by'),
  ].filter(Boolean).join(' · ');
  const fromTxt = st.gasFrom === 'imx' ? fmtImx(g.fromEth) : fmtEthFiat(g.fromEth);
  // Soft errors: the quote is real, they just can't afford to sign it. Show both.
  const short = st.gasErr === 'fees' ? 'trade.topup.gas.err.fees'
    : st.gasErr === 'overImx' ? 'trade.topup.gas.err.overImx' : null;
  const busy = bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase);
  return `
    <div class="trade-bridge-quote">
      <div class="trade-bridge-line">${esc(t('trade.gas.bridge.line').replace('{x}', fromTxt).replace('{y}', fmtImx(g.toEth)))}</div>
      <div class="trade-bridge-meta">${esc(meta)}</div>
      ${short ? `<div class="trade-status is-error"><span aria-hidden="true">${ico('alert', 17)}</span><span>${esc(t(short).replace('{x}', fmtImx(weiToEth(st.mainnetImxWei ?? 0n))))}</span></div>` : ''}
      <button class="trade-funds-btn" data-act="topup-gas-now" type="button" ${short || busy ? 'disabled' : ''}>${esc(t('trade.gas.bridge.now'))}</button>
      ${shell.isGasBridge(bridgeJob) ? shell.bridgeStatusHtml() : ''}
    </div>`;
}

// Pick a preset: fill the box, mark the chip, re-quote at once (no debounce — a click is
// a finished decision, unlike a half-typed number).
function topupGasPreset(imx) {
  const st = topupState;
  if (!st || !imx) return;
  st.gasAmount = String(imx);
  clearTimeout(topupQuoteTimer);
  patchTopup(); // full repaint so the chip's pressed state moves
  fetchTopupGasQuote();
}

function runTopupGas() {
  const st = topupState;
  if (!st?.gasQuote || st.gasQuote === 'loading') return;
  if (st.gasErr) return; // can't afford the move — the button is disabled, belt and braces
  // Arrival target for the tracker: what they asked for, or the quote's own figure if the
  // box somehow no longer parses.
  const asked = topupGasAmountWei();
  const needWei = asked ?? BigInt(Math.round((Number(st.gasQuote.toEth) || GAS_TARGET_IMX) * 1e6)) * 10n ** 12n;
  return shell.runBridge(st.gasQuote, { kind: 'gas', needWei, fromSym: st.gasFrom === 'imx' ? 'IMX' : 'ETH', toSym: 'IMX' });
}

// --- View lifecycle -------------------------------------------------------------------

/** True while the wallet may have a prompt up — see the same note in cash-out.js. */
let signing = false;
export const isSigning = () => signing;

/**
 * Leave the view. bridgeJob is deliberately untouched: it is the persisted record of real
 * money in motion, and the banner above every view keeps reporting on it. A pending
 * signature wins — returns false so the caller knows it declined.
 */
export function leaveAddFunds() {
  clearTimeout(topupQuoteTimer);
  topupQuoteTimer = null;
  if (signing) return false;
  topupStep = 'intent';
  topupState = null;
  return true;
}

/** Drop what this flow holds without navigating (the wallet switched account under us). */
export function resetAddFunds() {
  clearTimeout(topupQuoteTimer);
  topupQuoteTimer = null;
  topupState = null;
  topupStep = 'intent';
}

/** data-act names this view owns. The shell merges this into its delegated switch. */
export const addFundsActs = {
  'topup-eth': () => {
    if (topupState) { topupState.err = null; topupState.quote = null; }
    topupStep = 'eth';
    patchTopup();
  },
  'topup-gas':        () => openTopupGas(),
  'topup-gas-preset': target => topupGasPreset(Number(target.dataset.imx)),
  'topup-max':        () => topupMaxClick(),
  'topup-now':        () => runTopupEth(),
  'topup-gas-now':    () => runTopupGas(),
  // Switch the source chain. The amount survives the switch (it is what the member wants to
  // move, not a property of the chain), but the quote does not: it was priced for the old
  // corridor, and showing it under a new chip would misprice the move.
  // Ethereum only: swap between the fast solver route and Immutable's own bridge. The one
  // real difference is custody for the seconds in flight, and the footer says which is which.
  'topup-route': () => {
    const st = topupState;
    if (!st || st.src !== 'ethereum') return;
    st.route = st.route === 'canonical' ? 'auto' : 'canonical';
    st.quote = null;
    st.err = null;
    clearTimeout(topupQuoteTimer);
    patchTopup();
    if (topupAmountWei() != null) queueTopupQuote(0);
  },
  'topup-src': target => {
    const st = topupState;
    const next = target?.dataset?.src;
    if (!st || !FUND_CHAINS[next] || st.src === next) return;
    st.src = next;
    st.srcPicked = true;   // stop the balance refresh from moving them off their choice
    // Only Ethereum has a canonical bridge to prefer, so the preference cannot survive a
    // move to Base: leaving it set would silently quote the fast route while the link still
    // claimed the official one was selected.
    if (next !== 'ethereum') st.route = 'auto';
    st.quote = null;
    st.err = null;
    clearTimeout(topupQuoteTimer);
    patchTopup();
    if (topupAmountWei() != null) queueTopupQuote(0);
  },
  'topup-back': () => {
    topupStep = 'intent';
    clearTimeout(topupQuoteTimer);
    if (topupState) {
      topupState.err = null; topupState.quote = null; topupState.gasQuote = null;
      // gasAmount and gasErr were left behind here, so a round trip through the chooser
      // re-entered the gas step showing a stale "you can't afford this" against an amount
      // the member had already changed, with the CTA dead. Clear the pair.
      topupState.gasAmount = null; topupState.gasErr = null;
    }
    patchTopup();
  },
};

/** The two amount boxes live in this view; the shell forwards their input events here. */
export function onAddFundsInput(el) {
  if (el?.id === 'trade-topup-amt') {
    if (topupState) { topupState.amount = el.value; queueTopupQuote(); }
    return true;
  }
  if (el?.id === 'trade-topup-gas-amt') {
    if (topupState) topupState.gasAmount = el.value;
    // Un-press any preset chip the typed value no longer matches, without repainting
    // the input itself.
    const v = String(el.value).trim();
    for (const chip of root()?.querySelectorAll('.trade-gas-chip') || []) {
      const on = chip.dataset.imx === v;
      chip.classList.toggle('is-on', on);
      chip.setAttribute('aria-pressed', String(on));
    }
    queueTopupGasQuote();
    return true;
  }
  return false;
}

/** True when a live bridge job belongs to this flow (a funding move, not a cash-out). */
export const ownsBridge = () =>
  !!bridgeJob && !shell.isOutBridge(bridgeJob);

export { patchTopupMove, patchTopupGas };

/** A bridge job was dismissed: if this view is up, re-read balances and repaint. */
export function onBridgeDismissed() {
  if (!isOpen()) return;
  if (topupState) { topupState.phase = 'load'; patchTopup(); refreshTopupBalances(); }
  else patchTopup();
}
