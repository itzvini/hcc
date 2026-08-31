// Money formatting. Every ETH, IMX and fiat figure the marketplace prints comes through
// here, so the same amount reads the same way in a browse tile, a quote and a receipt.
//
// These read the display currency from core/state.js and nothing else, which is why they
// can be imported by any feature module without dragging the shell in behind them.

import { currency, ethUsd, fxRates } from './state.js';

/** Wei → a Number of ETH. Null in, null out. */
export const weiToEth = wei => (wei == null ? null : Number(wei) / 1e18);

/**
 * Full-precision wei → decimal ETH string ("0.169923456789012345"). The cash-out Max
 * sends the EXACT balance to the quote, so the route never overdraws by a rounding hair.
 */
export function weiToEthStr(wei) {
  const s = wei.toString().padStart(19, '0');
  const frac = s.slice(-18).replace(/0+$/, '');
  return frac ? `${s.slice(0, -18)}.${frac}` : s.slice(0, -18);
}

export function fmtWeiEth(wei) {
  if (wei == null) return '—';
  return (Number(wei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function fmtEth(eth) {
  const n = Number(eth);
  return Number.isFinite(n) ? `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH` : '—';
}

/**
 * IMX amounts. Gas figures run from tens of coins down to fractions of a thousandth, and a
 * flat 3dp printed "you need 0.002 IMX" above a dead button next to a balance of "0 IMX"
 * that was not actually empty. Give the small end the digits it needs to stay a different
 * number from its own threshold.
 */
export function fmtImx(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const dp = v !== 0 && Math.abs(v) < 0.01 ? 6 : 3;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: dp })} IMX`;
}

/**
 * A bridge fee in whole cents. The server rounds to 2dp, so a 10-cent fee arrives as the
 * number 0.1 and String() would print "$0.1" — always show both digits.
 */
export const fmtFeeUsd = n => Number(n).toFixed(2);

/**
 * The fiat estimate under an ETH price, in the user's chosen currency. Returns '' when
 * ETH-only is selected or no rate is available (so the caller renders nothing).
 */
export function fmtFiat(eth) {
  if (currency === 'eth' || eth == null || ethUsd == null) return '';
  const rate = currency === 'usd' ? 1 : fxRates[currency];
  if (rate == null) return '';
  const val = Number(eth) * ethUsd * rate;
  // Whole units are right for prices, but they turn any sub-unit amount into "US$ 0",
  // which reads as broken rather than cheap (a 1 IMX gas top-up is ~$0.16). So show cents
  // below 1, and say "under a cent" rather than "0.00" for the truly tiny.
  const abs = Math.abs(val);
  const digits = abs > 0 && abs < 1 ? 2 : 0;
  try {
    const money = (n, d) => new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: d, minimumFractionDigits: d }).format(n);
    // Format the threshold itself rather than patching the string: this locale writes
    // "0,01", so a search-and-replace for "0.00" would silently miss.
    if (abs > 0 && abs < 0.005) return `< ${money(val < 0 ? -0.01 : 0.01, 2)}`;
    return `≈ ${money(val, digits)}`;
  } catch {
    return `≈ ${(digits ? val.toFixed(2) : Math.round(val)).toLocaleString?.() ?? val.toFixed(digits)} ${currency.toUpperCase()}`;
  }
}

/** "0.0618 ETH (≈ R$ 520)" — every ETH amount carries the user's selected currency. */
export function fmtEthFiat(eth) {
  if (eth == null || !Number.isFinite(Number(eth))) return '—';
  const fiat = fmtFiat(eth);
  return fiat ? `${fmtEth(eth)} (${fiat})` : fmtEth(eth);
}

/**
 * A past sale's fiat value AT THE TIME OF SALE. The server already valued it in USD at that
 * day's ETH rate (priceUsd); other display currencies scale by today's USD→X rate (exact
 * for USD, a close proxy elsewhere — same approach the price chart uses). '' when showing ETH.
 */
export function fmtSaleFiat(usd) {
  if (currency === 'eth' || usd == null || !Number.isFinite(Number(usd))) return '';
  const rate = currency === 'usd' ? 1 : fxRates[currency];
  if (rate == null) return '';
  const val = Number(usd) * rate;
  try {
    return `≈ ${new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(val)}`;
  } catch {
    return `≈ ${Math.round(val).toLocaleString()} ${currency.toUpperCase()}`;
  }
}

/**
 * A trait's collection-wide rarity as a percentage, e.g. 0.032 → "3.2%". One decimal
 * under 10% (where it carries signal), whole numbers above. Returns '' for unknowns.
 */
export function fmtTraitPct(p) {
  if (p == null || !Number.isFinite(Number(p))) return '';
  const v = Number(p) * 100;
  if (v > 0 && v < 0.1) return '<0.1%';
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}

/** "0x1234…abcd" — a wallet address short enough to sit in a chip. */
export function shortWallet(a) {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || '');
}
