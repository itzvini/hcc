// "Where your money is" — the rail that sits beside both money views.
//
// It exists because the modals these views replaced could only ever answer the question one
// line at a time, inside whichever step you happened to be standing on. A member moving real
// money between two networks needs to see both sides at once, or the move is an act of faith.
//
// Shared, and deliberately so: Cash out used to draw its own two-row list with no Ethereum
// group in it at all, so the destination of the whole flow — the side the money is going TO —
// was the one place on the page you could not see. One rail, one set of labels, one arrow
// that flips.

import { t } from '../i18n.js';
import { esc } from './core/dom.js';
import { fmtEthFiat, fmtImx, weiToEth } from './core/fmt.js';
import { shell } from './core/bus.js';
import { ico } from './core/icons.js';

const ethRow = wei => (wei != null ? fmtEthFiat(weiToEth(wei)) : '—');
const imxRow = wei => (wei != null ? fmtImx(weiToEth(wei)) : '—');

/**
 * @param dir      'in' (Ethereum → Immutable zkEVM) or 'out' (the reverse). Only decides
 *                 which chain group sits above the arrow.
 * @param loading  show spinners instead of figures.
 * @param bal      {mainnetEthWei, mainnetImxWei, zkEthWei, zkImxWei} — any of them may be
 *                 null, which renders an em dash. That is the honest answer when the wallet
 *                 is connected to the other chain and we genuinely cannot read this one:
 *                 a zero would read as "you have nothing", which is a different claim.
 * @param note     i18n key for the paragraph under the balances.
 * @param link     optional {href, label} row at the foot.
 */
export function moneyRailHtml({ dir = 'in', loading = false, bal = {}, note, link } = {}) {
  const row = (label, val, sym) => `
    <li class="trade-money-bal">
      <span class="trade-money-bal-k">${esc(label)}</span>
      <span class="trade-money-bal-v">${loading ? '<span class="trade-mini-spin" aria-hidden="true"></span>' : esc(val)}</span>
      ${shell.bridgeCoinHtml(sym)}
    </li>`;
  // A group whose figures are all unknown says so. Two em dashes on their own read as "you
  // have nothing here", which is a different claim and the wrong one: it would talk a LAND
  // buyer out of the very option below that brings their zkEVM proceeds back.
  const grp = (title, pairs) => {
    const unknown = !loading && pairs.every(([, wei]) => wei == null);
    return `
    <div class="trade-money-chaingrp${unknown ? ' is-unknown' : ''}">
      <h4 class="trade-money-chain">${esc(title)}</h4>
      <ul class="trade-money-bals">${pairs.map(([label, wei, sym, fmt]) => row(label, fmt(wei), sym)).join('')}</ul>
      ${unknown ? `<p class="trade-money-chain-note">${esc(t('trade.money.rail.unknown'))}</p>` : ''}
    </div>`;
  };

  const ethereum = grp('Ethereum', [
    [t('trade.money.rail.eth'), bal.mainnetEthWei, 'ETH', ethRow],
    [t('trade.money.rail.imxL1'), bal.mainnetImxWei, 'IMX', imxRow],
  ]);
  const zkevm = grp('Immutable zkEVM', [
    [t('trade.money.rail.zkEth'), bal.zkEthWei, 'ETH', ethRow],
    [t('trade.money.rail.zkImx'), bal.zkImxWei, 'IMX', imxRow],
  ]);

  const [top, bottom] = dir === 'out' ? [zkevm, ethereum] : [ethereum, zkevm];
  return `
    <h3 class="trade-money-rail-h">${esc(t('trade.money.rail.h'))}</h3>
    ${top}
    <div class="trade-money-railarrow" aria-hidden="true">${ico('chevronDown', 18)}</div>
    ${bottom}
    ${note ? `<p class="trade-money-rail-p">${esc(t(note))}</p>` : ''}
    ${link ? `<a class="trade-money-rail-link" href="${esc(link.href)}" data-act="${esc(link.act || '')}">${esc(t(link.label))} ${ico('chevronRight', 13)}</a>` : ''}`;
}
