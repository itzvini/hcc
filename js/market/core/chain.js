// Everything that talks to the wallet's provider: reading balances, encoding call data,
// switching networks, and turning a provider error into a sentence a member can act on.
//
// Non-custodial throughout — every write is a request the user signs in MetaMask. Nothing
// here builds HTML, so a feature module can read a balance without importing the shell.

import { t } from '../../i18n.js';
import {
  CREATURE_CONTRACT, ZK_CHAIN_ID_HEX, ZK_NETWORK, COLLECTIONS, FUND_CHAIN_BY_HEX,
  SEL_BALANCE_OF, SEL_OWNER_OF, SEL_ALLOWANCE,
} from './consts.js';
import { account, chainId, coll, setChainId } from './state.js';

/** The injected provider, or undefined when no wallet is installed. */
export const eth = () => window.ethereum;

/** The active collection's config: API base, chain, contract, label key. */
export const C = () => COLLECTIONS[coll];

/** Is the wallet on Immutable zkEVM? */
export const onZk = () => (chainId || '').toLowerCase() === ZK_CHAIN_ID_HEX;

/** Is the wallet on the chain the ACTIVE collection needs (zkEVM for Creatures, mainnet for LAND)? */
export const onRightChain = () => (chainId || '').toLowerCase() === C().chainHex;

/** ABI-encode a value as one 32-byte word of call data. */
export function word(v) {
  const hex = (typeof v === 'string' && v.startsWith('0x')) ? v.slice(2) : BigInt(v).toString(16);
  return hex.toLowerCase().padStart(64, '0');
}

// --- Known wallet bugs ---------------------------------------------------------------
// Set by the MetaMask version sniff in the shell. friendlyError reads it so a forced
// "cancel" is explained as the wallet's bug rather than left to read as the user's mistake.
export let mmBuggyVersion = null;
export function setMmBuggyVersion(v) { mmBuggyVersion = v; }

// --- Reads ----------------------------------------------------------------------------

/** How many Creatures this wallet holds, or null when the read fails / it's off zkEVM. */
export async function readBalance() {
  if (!account || !onZk()) return null;
  try {
    const res = await eth().request({ method: 'eth_call', params: [{ to: CREATURE_CONTRACT, data: SEL_BALANCE_OF + word(account) }, 'latest'] });
    return parseInt(res, 16) || 0;
  } catch { return null; }
}

export async function ownerOf(contract, tokenId) {
  try {
    const res = await eth().request({ method: 'eth_call', params: [{ to: contract, data: SEL_OWNER_OF + word(tokenId) }, 'latest'] });
    if (!res || res.length < 42) return null;
    return ('0x' + res.slice(-40)).toLowerCase();
  } catch { return null; }
}

/** ERC-20 balance in wei (BigInt), or null on a read failure. */
export async function readErc20(token, addr) {
  try { return BigInt(await eth().request({ method: 'eth_call', params: [{ to: token, data: SEL_BALANCE_OF + word(addr) }, 'latest'] }) || '0x0'); }
  catch { return null; }
}

/** Native-coin balance in wei (BigInt) on whatever chain the wallet is currently on. */
export async function readNative(addr) {
  try { return BigInt(await eth().request({ method: 'eth_getBalance', params: [addr, 'latest'] }) || '0x0'); }
  catch { return null; }
}

/**
 * Current gas price in wei, straight from the connected wallet's own node. Only Ethereum
 * needs it — there a send's fee is real money and swings with the base fee, so the amount a
 * native send has to hold back can't be a constant. Null when the read fails; callers fall
 * back to a fixed reserve rather than guessing at zero.
 */
export async function readGasPrice() {
  try { return BigInt(await eth().request({ method: 'eth_gasPrice' }) || '0x0') || null; }
  catch { return null; }
}

export async function readAllowance(token, owner, spender) {
  try { return BigInt(await eth().request({ method: 'eth_call', params: [{ to: token, data: SEL_ALLOWANCE + word(owner) + word(spender) }, 'latest'] }) || '0x0'); }
  catch { return null; }
}

/** Poll for a transaction receipt. Returns null if it hasn't landed inside the timeout. */
export async function waitForReceipt(hash, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await eth().request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (r) return r;
    } catch { /* transient provider hiccup — keep polling */ }
    await new Promise(res => setTimeout(res, 1500));
  }
  return null;
}

// --- Network switching ------------------------------------------------------------------

/**
 * The chain we just asked the wallet to move to. The provider's chainChanged event fires
 * for our own switches as well as the user's, and the two need opposite handling: ours is
 * expected and should patch quietly, theirs is a surprise and warrants a full re-render.
 */
export let expectedChainHex = null;
export function setExpectedChainHex(v) { expectedChainHex = v; }

/** Move the wallet to Immutable zkEVM, adding the network if it doesn't know it yet. */
export async function ensureNetwork() {
  try {
    await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ZK_CHAIN_ID_HEX }] });
  } catch (err) {
    if (err?.code === 4902 || /unrecognized chain|add.*chain/i.test(err?.message || '')) {
      await eth().request({ method: 'wallet_addEthereumChain', params: [ZK_NETWORK] });
    } else { throw err; }
  }
  setChainId(await eth().request({ method: 'eth_chainId' }));
}

/**
 * Move the wallet to `hex`, flagging the resulting chainChanged event as ours. Always use
 * this rather than a raw wallet_switchEthereumChain: without the flag the echo reads as a
 * user-initiated switch and triggers a full re-render, which tears down whatever flow asked
 * for the switch in the first place.
 */
export async function switchToChain(hex) {
  const want = String(hex).toLowerCase();
  setExpectedChainHex(want); // the coming chainChanged event is ours
  try {
    if (hex === ZK_CHAIN_ID_HEX) { await ensureNetwork(); return; }
    try {
      await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    } catch (err) {
      // 4902 means the wallet has never heard of this chain. MetaMask ships Base, Arbitrum
      // and OP as "popular networks" that are not added until first use, so a member picking
      // one as a funding source hits this on a clean wallet. Offer to add it, but only for
      // chains we have vetted parameters for — never one named by a response.
      const add = FUND_CHAIN_BY_HEX[want]?.params;
      const unknown = err?.code === 4902 || /unrecognized chain|add.*chain/i.test(err?.message || '');
      if (!unknown || !add) throw err;
      await eth().request({ method: 'wallet_addEthereumChain', params: [add] });
    }
    setChainId(await eth().request({ method: 'eth_chainId' }));
  } catch (err) {
    if (expectedChainHex === want) setExpectedChainHex(null); // declined — future events are external
    throw err;
  }
}

// --- Errors -------------------------------------------------------------------------------

/** Map a wallet/provider error to a friendly, actionable message — never a raw revert. */
export function friendlyError(err) {
  const code = err?.code;
  const msg  = (err?.message || '').toLowerCase();
  if (code === 4001 || /user rejected|user denied|rejected the request/.test(msg)) {
    // On buggy MetaMask builds a "cancel" is often forced by the phantom insufficient-
    // IMX block — say so, or the user blames themselves (or us).
    return t('trade.err.rejected') + (mmBuggyVersion ? ` ${t('trade.err.mmBugHint')}` : '');
  }
  if (code === -32002 || /already pending|already processing|request already/.test(msg)) return t('trade.err.pending');
  if (/insufficient funds|insufficient balance|gas required|exceeds balance/.test(msg)) return t('trade.err.gas');
  if (code === 4902 || /unrecognized chain|wrong network/.test(msg)) return t('trade.err.network');
  return t('trade.err.generic');
}
