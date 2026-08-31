// The marketplace's genuinely shared state — the handful of values every feature needs to
// read, and nothing else. Feature-owned state (a quote in flight, a picker's selection, one
// panel's error) stays inside the feature that owns it; putting it here would only rebuild
// the 150-variable global bag this split exists to break up.
//
// The shape is deliberate. Each value is exported as a live `let` binding, so a reader just
// does `import { account }` and sees the current value with no call and no subscription —
// every existing `if (!account) …` keeps working verbatim. Writing goes through a setter,
// because assigning to an imported binding is an early SyntaxError: a write site that gets
// missed during an extraction refuses to parse instead of silently forking the state.

// --- Wallet -------------------------------------------------------------------------
export let account = null;   // lowercase 0x address, or null when disconnected
export let chainId = null;   // hex chain id as the wallet reports it
export let busy    = false;  // a wallet request is in flight (connect / switch)

export function setAccount(v) { account = v; }
export function setChainId(v) { chainId = v; }
export function setBusy(v)    { busy = v; }

// --- Which collection is in view ----------------------------------------------------
// 'creatures' (Immutable zkEVM) or 'land' (Ethereum mainnet). Scopes the API base, the
// chain every action needs, and which features exist at all.
export let coll = 'creatures';
export function setColl(v) { coll = v; }

// --- Which view is on screen --------------------------------------------------------
// The two funds views own a URL, and their tab value IS their URL slug ('/trade/cash-out'),
// so there is no name-to-slug table anywhere to drift out of step.
export const TRADE_VIEWS = new Set([
  'buy', 'sell', 'transfer', 'sales', 'history', 'profile', 'add-funds', 'cash-out',
]);
export let tradeTab = 'buy';
/**
 * Change the visible view. The allowlist earns its keep because the shell's view dispatcher
 * ends in an unconditional Browse fallthrough: without this, a typo'd tab value silently
 * renders the grid, which reads as "the route is broken" rather than "the branch is missing".
 */
export function setTradeTab(v) {
  if (!TRADE_VIEWS.has(v)) { console.error(`[market] unknown view "${v}" — staying on "${tradeTab}"`); return; }
  tradeTab = v;
}

// --- Money display ------------------------------------------------------------------
// The fiat estimate under every ETH amount. 'eth' means "show no fiat at all".
export let currency = 'usd';
export let ethUsd   = null;         // USD per ETH, from the listings API
export let fxRates  = { usd: 1 };   // USD-relative display rates, same source

export function setCurrency(v) { currency = v; }
export function setEthUsd(v)   { ethUsd = v; }
export function setFxRates(v)  { fxRates = v; }

// --- Money in flight ------------------------------------------------------------------
// A bridge outlives any one screen: the job is held here AND persisted to localStorage, so
// leaving the page, switching tabs or reloading never loses track of it — the banner on the
// Trade tab keeps reporting until it lands. Read by the tracker, the banner, both funds
// views and the buy flow's funds panel, which is what makes it shared rather than feature-owned.
// {phase, hash, mins, startedAt, stage, axelarUrl, msg, needWei, quoteId, requestId, account}
export let bridgeJob = null;
export function setBridgeJobRaw(v) { bridgeJob = v; }

// The "you haven't got enough IMX" panel, shared by Buy, Sell, Transfer and both funds views.
// {ctx:'buy'|'sell'|'transfer'|'cashout', imxBal, mainnetEthWei, quote:'loading'|null|{...}}; null = idle.
export let gasState = null;
export function setGasState(v) { gasState = v; }

/** One-tap WETH → ETH unwrap after a LAND sale: send|wait|done|error. */
export let unwrapState = null;
export function setUnwrapState(v) { unwrapState = v; }

// --- Boot + one-shot banner ---------------------------------------------------------
// loadedOnce gates every patch* helper: before the first render there is no DOM to patch.
export let loadedOnce = false;
export function setLoadedOnce(v) { loadedOnce = v; }

// A message to surface at the top of the next render, then forget. Set from anywhere a
// wallet action fails; consumed once by the shell's banner.
export let pendingFlash = null;
export function setPendingFlash(v) { pendingFlash = v; }
/** Take the pending message and clear it, so a render can never show it twice. */
export function takeFlash() { const m = pendingFlash; pendingFlash = null; return m; }
