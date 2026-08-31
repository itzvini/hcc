// Marketplace constants — contracts, chains, call selectors, brand marks and the
// bridge/gas thresholds. Pure values only: nothing here reads or writes state, so every
// other market module can import it without creating a cycle.
//
// Extracted verbatim from js/marketplace.js. Anything that needs the ACTIVE collection or
// the connected wallet (C(), onRightChain(), tokenExplorerUrl…) is deliberately not here —
// that reads state, and lives in core/state.js and core/chain.js.

export const CREATURE_CONTRACT = '0xCf44b1cBC959295bbBb49935B1b339cC0AA77cdA';
export const ZK_CHAIN_ID_HEX   = '0x343b'; // Immutable zkEVM mainnet (13371)
export const ZK_NETWORK = {
  chainId: ZK_CHAIN_ID_HEX,
  chainName: 'Immutable zkEVM',
  nativeCurrency: { name: 'Immutable X', symbol: 'IMX', decimals: 18 },
  rpcUrls: ['https://rpc.immutable.com'],
  blockExplorerUrls: ['https://explorer.immutable.com'],
};
export const EXPLORER = 'https://explorer.immutable.com';

/**
 * The chains a member can fund FROM, keyed the way the server's Layerswap allowlist keys
 * them (see FUND_SOURCES in lib/layerswap-bridge.js — the two lists must not drift).
 *
 * `params` is a full wallet_addEthereumChain payload because MetaMask ships these as
 * "popular networks" a member may never have added. Without it, picking Base on a fresh
 * wallet fails with an unrecognised-chain error and looks like our bug.
 */
export const FUND_CHAINS = {
  ethereum: { hex: '0x1', label: 'Ethereum', params: null }, // always present in every wallet
  base: {
    hex: '0x2105',
    label: 'Base',
    params: {
      chainId: '0x2105', chainName: 'Base',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'],
    },
  },
  arbitrum: {
    hex: '0xa4b1',
    label: 'Arbitrum One',
    params: {
      chainId: '0xa4b1', chainName: 'Arbitrum One',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://arb1.arbitrum.io/rpc'], blockExplorerUrls: ['https://arbiscan.io'],
    },
  },
  optimism: {
    hex: '0xa',
    label: 'OP Mainnet',
    params: {
      chainId: '0xa', chainName: 'OP Mainnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.optimism.io'], blockExplorerUrls: ['https://optimistic.etherscan.io'],
    },
  },
};
/** Source key → chain hex, and back. */
export const FUND_CHAIN_BY_HEX = Object.fromEntries(
  Object.entries(FUND_CHAINS).map(([k, c]) => [c.hex, { key: k, ...c }]),
);

// Two collections, two worlds: Creatures (Immutable zkEVM + Immutable orderbook) and
// LAND (Ethereum mainnet + OpenSea Seaport). The active collection scopes the API base,
// the chain every action needs, and which features exist (offers/sell are
// Creatures-only until LAND listing-creation ships).
export const LAND_CONTRACT_L1 = '0x8bf3a40ea2337e6e4f6e540680ea6390cb3b4e11';
// Brand marks for each collection (real assets, not emoji): the HCC glyph for Creatures,
// the Highrise LAND emoji for LAND. cdn.discordapp.com is in the page CSP img-src.
export const COLL_ICONS = {
  creatures: '/img/brands/icon_hcc.png',
  land:      'https://cdn.discordapp.com/emojis/974503320414744626.webp?size=128',
};
export const COLLECTIONS = {
  creatures: { api: '/api/market/creatures', chainHex: ZK_CHAIN_ID_HEX, contract: CREATURE_CONTRACT, labelKey: 'trade.coll.creatures' },
  land:      { api: '/api/market/land',      chainHex: '0x1',           contract: LAND_CONTRACT_L1, labelKey: 'trade.coll.land' },
};

export const SEL_SAFE_TRANSFER = '0x42842e0e'; // safeTransferFrom(address,address,uint256)
export const SEL_BALANCE_OF    = '0x70a08231'; // balanceOf(address)
export const SEL_OWNER_OF      = '0x6352211e'; // ownerOf(uint256)
export const SEL_WETH_WITHDRAW = '0x2e1a7d4d'; // withdraw(uint256) — unwrap WETH → native ETH (1:1)
export const SEL_APPROVE       = '0x095ea7b3'; // approve(address,uint256) — ERC-20, for the cash-out router
export const SEL_ERC20_TRANSFER = '0xa9059cbb'; // transfer(address,uint256) — plain ERC-20 send
export const SEL_ALLOWANCE     = '0xdd62ed3e'; // allowance(address,address)
export const ZERO = '0x0000000000000000000000000000000000000000';
export const METAMASK_IMG = '/img/brands/metamask.svg';
// Crisp shield-check (currentColor) — emoji shields render as flat glyphs on Windows.
export const SHIELD_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.5l7.5 2.8v5.4c0 4.8-3.2 8.9-7.5 10.3-4.3-1.4-7.5-5.5-7.5-10.3V5.3L12 2.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.6 12l2.4 2.4 4.4-4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const IS_ADDR = /^0x[0-9a-f]{40}$/;
// ETH on Immutable zkEVM is an ERC-20 (the price token); IMX is the NATIVE gas token.
// A buyer needs BOTH, on Immutable zkEVM. The bridge deep-link opens Squid (which also
// powers Immutable's own toolkit bridge) pre-set to ETH-on-Ethereum → ETH-on-zkEVM;
// unknown params degrade gracefully to Squid's defaults.
export const IMX_ETH_TOKEN = '0x52a6c53869ce09a731cd772f245b97a4401d3348';
export const IMX_USDC_TOKEN = '0x6de8acc0d406837030ce4dd28e7c08c5a96a30d2'; // bridged USDC on zkEVM (6 decimals, verified on-chain)
export const SQUID_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // Squid's native-coin placeholder
export const BRIDGE_URL = `https://app.squidrouter.com/?chains=1,13371&tokens=${SQUID_NATIVE},${IMX_ETH_TOKEN}`;
// The reverse, for sellers cashing out their proceeds: ETH-on-zkEVM → ETH-on-Ethereum.
export const CASHOUT_URL = `https://app.squidrouter.com/?chains=13371,1&tokens=${IMX_ETH_TOKEN},${SQUID_NATIVE}`;
// LAND offers settle in WETH on Ethereum mainnet — a seller's proceeds arrive as this ERC-20
// (invisible in MetaMask until added). Canonical mainnet WETH.
export const WETH_TOKEN = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
// USDC on Ethereum mainnet (Circle) — the dollar-pegged LAND listing currency (6 decimals,
// verified on-chain). A USDC LAND buyer's balance/allowance are read against this.
export const USDC_MAINNET_TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
// IMX is the NATIVE gas token on Immutable zkEVM — every on-chain action (a buy, a sell's
// one-time collection approval, a transfer) needs a little, and the ETH ERC-20 can't pay
// for it. This deep-link bridges native ETH on Ethereum → native IMX on zkEVM (both the
// Squid native placeholder, resolved per chain); the one-tap quote does the same exactly.
export const GAS_BRIDGE_URL = `https://app.squidrouter.com/?chains=1,13371&tokens=${SQUID_NATIVE},${SQUID_NATIVE}`;
// IMX held on Ethereum mainnet is an ERC-20 — when the user already has some, bridging it
// straight to native IMX on zkEVM is cheaper than swapping ETH (no DEX leg). This deep-link
// is preset for exactly that; the one-tap quote takes the same source via {from:'imx'}.
export const IMX_L1_TOKEN = '0xf57e7e7c23978c3caec3c3548e3d615c346e79ff';
export const GAS_BRIDGE_URL_IMX = `https://app.squidrouter.com/?chains=1,13371&tokens=${IMX_L1_TOKEN},${SQUID_NATIVE}`;
export const GAS_MIN_WEI = 10n ** 15n;        // < 0.001 IMX on hand → surface the gas helper
// What a Layerswap cash-out actually costs to sign on zkEVM: one ERC-20 transfer, measured at
// 33,160 gas / ~0.00037 IMX. The route needs no IMX for the FEE, which is the whole point of
// it, but it is still a transaction — so this is the floor below which "no IMX needed" would
// be a lie to the very wallet the route exists to rescue.
export const LS_MIN_GAS_WEI = 2n * 10n ** 15n; // 0.002 IMX — several times the measured cost
// Layerswap quotes, prices and moves in units of 1e-8 ETH (AMOUNT_DP in lib/layerswap-bridge.js),
// so the amount that reaches the calldata is always this wei figure floored to that step. The
// commit check has to floor the same way before comparing, or it rejects the truth. See the
// note in runCashoutLayerswap.
export const LS_AMOUNT_STEP_WEI = 10n ** 10n;  // 1e-8 ETH
export const GAS_OK_WEI  = 5n * 10n ** 15n;   // ≥ 0.005 IMX → "you're set for gas" (matches the buy panel)
export const GAS_TARGET_IMX = 5;              // one-tap top-up target, in IMX (tunable) — a lot of
                                              // runway (gas is fractions of a cent/tx) while still
                                              // clearing typical bridge minimums; deep-link covers the rest
// Quick picks for the Add-funds gas step, alongside a free-text amount for anything else.
// 5 stays the default (it's the one-tap target everywhere else) and the floor of the picks:
// the bridge fee is roughly flat at ~$0.09, so a 1 IMX top-up would spend over half the
// money on fees. Anyone with nothing at all is better served by the free gas assist, and
// the box below still takes a smaller number for anyone who insists.
export const GAS_PRESETS_IMX = [5, 10, 25, 50];
// The ceiling on any one top-up. It was 50, which was set when "gas" meant a rounding error
// and nobody had checked it against the one action that needs a real amount: a canonical
// cash-out prepays the Ethereum-side relay in IMX, and that ran 54-215 IMX in a single hour
// under observation. So the cap sat BELOW the requirement and no in-site top-up could ever
// be big enough — the member was told to add IMX by a panel that refused to quote enough of
// it. 300 clears the worst relay fee seen with room to spare, and still stops a tampered
// request quoting an enormous bridge. Keep this in step with the server-side cap.
export const GAS_MAX_IMX = 300;               // matches the server-side cap on /bridge/gas/quote
// Fiat on-ramp ("top up with card") — for a wallet that holds nothing anywhere, so there's
// nothing to bridge: they need to ACQUIRE crypto. The card path is a Transak deep-link built
// server-side (/api/market/onramp) with the destination NETWORK pinned and the buy amount
// prefilled — both zkEVM (Creatures) and Ethereum (LAND) go through it. This constant is only
// the keyless FALLBACK: Immutable's own hosted on-ramp page, used when no Transak key is set
// (it also delivers to zkEVM, but can't pin the network/amount, so it defaults to ETH-on-L1
// and the buyer has to pick the network themselves — hence it's the fallback, not the default).
export const ONRAMP_URL_ZKEVM = 'https://toolkit.immutable.com/onramp/';
// A bridge is signed on Ethereum MAINNET, so the wallet must hold the bridge INPUT *plus*
// enough ETH left over to pay that tx's L1 gas. Squid's quoted `feeUsd` covers the bridge
// + destination gas, NOT the source-chain execution gas the wallet itself pays — so we keep
// a separate headroom. When mainnet ETH can't cover input + this reserve, offering a bridge
// just produces an unfundable tx (the MetaMask "Review alert" → "something went wrong" a
// short wallet hits); we route to the card top-off instead. ~$5 of mainnet gas at typical
// fees — generous enough to clear gas spikes, small enough not to block real bridges.
export const BRIDGE_GAS_RESERVE_ETH = 0.0015;

// Where a bridge job is persisted, so it survives a reload.
export const BRIDGE_STORE = 'hcc-bridge';
/** Phases where a bridge has stopped moving — nothing further will happen on its own. */
export const BRIDGE_TERMINAL = new Set(['done', 'slow', 'error']);
/**
 * Phases where the tracker CARD takes over the panel (replacing its quote/CTA chrome). The
 * transient switch/confirm/back phases stay as a small inline status line instead.
 */
export const CARD_PHASES = new Set(['waiting', 'slow', 'done', 'error']);
