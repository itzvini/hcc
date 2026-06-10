import { t } from './i18n.js';

// HCC Marketplace — Phase 0 (connect + transfer) + Phase 1 (public browse).
// Non-custodial throughout: browsing is read-only public data from our own server;
// every wallet action is signed by the user via window.ethereum (no web3 library).
// Buy/sell/cancel (signed orders, prepared server-side) arrive in later phases.

const CREATURE_CONTRACT = '0xCf44b1cBC959295bbBb49935B1b339cC0AA77cdA';
const ZK_CHAIN_ID_HEX   = '0x343b'; // Immutable zkEVM mainnet (13371)
const ZK_NETWORK = {
  chainId: ZK_CHAIN_ID_HEX,
  chainName: 'Immutable zkEVM',
  nativeCurrency: { name: 'Immutable X', symbol: 'IMX', decimals: 18 },
  rpcUrls: ['https://rpc.immutable.com'],
  blockExplorerUrls: ['https://explorer.immutable.com'],
};
const EXPLORER = 'https://explorer.immutable.com';
const LISTINGS_API = '/api/market/creatures/listings';
const TOKEN_API    = '/api/market/creatures/token/';

const SEL_SAFE_TRANSFER = '0x42842e0e'; // safeTransferFrom(address,address,uint256)
const SEL_BALANCE_OF    = '0x70a08231'; // balanceOf(address)
const SEL_OWNER_OF      = '0x6352211e'; // ownerOf(uint256)
const ZERO = '0x0000000000000000000000000000000000000000';
const METAMASK_IMG = '/img/brands/metamask.svg';
const IS_ADDR = /^0x[0-9a-f]{40}$/;
// ETH on Immutable zkEVM is an ERC-20 (the price token); IMX is the NATIVE gas token.
// A buyer needs BOTH, on Immutable zkEVM. The bridge deep-link opens Squid (which also
// powers Immutable's own toolkit bridge) pre-set to ETH-on-Ethereum → ETH-on-zkEVM;
// unknown params degrade gracefully to Squid's defaults.
const IMX_ETH_TOKEN = '0x52a6c53869ce09a731cd772f245b97a4401d3348';
const SQUID_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // Squid's native-coin placeholder
const BRIDGE_URL = `https://app.squidrouter.com/?chains=1,13371&tokens=${SQUID_NATIVE},${IMX_ETH_TOKEN}`;

// Wallet state
let account = null;
let chainId = null;
let busy    = false;
let pendingFlash = null; // one-shot banner surfaced on next render
let loadedOnce = false;

// Browse state
let listings = [];
let listingsCursor = null;
let listingsLoading = false;
let listingsError = false;
let ethUsd = null;
let fxRates = { usd: 1 };   // USD-relative display rates from the listings API
let currency = 'usd';       // active display currency for the fiat estimate ('eth' = none)
const CURRENCIES = ['usd', 'eth', 'eur', 'gbp', 'brl', 'rub', 'try', 'jpy', 'cad', 'aud'];

// Modal state
let modalToken = null;
let modalMeta = null;
let modalLoading = false;

// Buy state — survives modal re-renders so a language switch or balance refresh can't
// wipe an in-flight purchase status. {phase, msg?, hash?}; null = idle.
let buyState = null;
const BUY_BUSY_PHASES = new Set(['prepare', 'approve', 'approveWait', 'fulfill', 'fulfillWait']);

// Which action tab is active inside the Trade panel: 'buy' | 'sell' | 'transfer'.
let tradeTab = 'buy';

// Offers state. tokenOffers = bids on the open modal's token; collOffers = standing
// collection-wide ("floor") offers, best first; myOffers = the user's own active offers.
let tokenOffers = null;    // null = loading/not loaded
let collOffers = null;
let myOffers = null;
let offerState = null;     // staged make-offer: prepare|approve|approveWait|sign|create|done|error
let offerCtx = null;       // where the make-offer flow is running: 'modal' | 'browse'
let acceptState = null;    // staged accept-offer: prepare|approve|approveWait|fulfill|fulfillWait|done|error
let acceptBusyId = null;   // offerId being accepted (disables its button)
const OFFER_BUSY = new Set(['prepare', 'approve', 'approveWait', 'sign', 'create']);
const ACCEPT_BUSY = new Set(['prepare', 'approve', 'approveWait', 'fulfill', 'fulfillWait']);

// Seller state: your Creatures (sell picker), your active listings, and the staged
// sell / cancel progress. Loaded lazily once connected on the right network.
let owned = null;          // null = not loaded; [] = loaded, none
let mine = null;           // null = not loaded; [] = loaded, none
let sellerLoading = false;
let sellSel = null;        // tokenId picked for sale
let sellState = null;      // {phase, msg?, hash?}: prepare|approve|approveWait|sign|create|done|error
let cancelBusy = null;     // listingId currently being cancelled
const SELL_BUSY_PHASES = new Set(['prepare', 'approve', 'approveWait', 'sign', 'create']);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortWallet(a) {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || '');
}
const root = () => document.getElementById('trade-app');

// Small ⓘ disclosure for non-crucial detail: hover on desktop, tap on touch. Keeps the
// screen calm — the full explanation is one gesture away instead of always on.
function tipHtml(key) {
  return `<span class="trade-tip"><button type="button" class="trade-tip-btn" aria-label="${esc(t('trade.tip.aria'))}">i</button><span class="trade-tip-pop" role="tooltip">${esc(t(key))}</span></span>`;
}
let tipsWired = false;
function wireTips() {
  if (tipsWired) return; tipsWired = true;
  // Document-level so tips work anywhere on the page (incl. the static beta note),
  // and any outside click/tap closes whatever is open.
  document.addEventListener('click', e => {
    const btn = e.target.closest('.trade-tip-btn');
    const owner = btn ? btn.closest('.trade-tip') : null;
    document.querySelectorAll('.trade-tip.is-open').forEach(el => { if (el !== owner) el.classList.remove('is-open'); });
    if (owner) owner.classList.toggle('is-open');
  });
}
const eth  = () => window.ethereum;
const onZk = () => (chainId || '').toLowerCase() === ZK_CHAIN_ID_HEX;

function word(v) {
  const hex = (typeof v === 'string' && v.startsWith('0x')) ? v.slice(2) : BigInt(v).toString(16);
  return hex.toLowerCase().padStart(64, '0');
}

function fmtEth(eth) {
  const n = Number(eth);
  return Number.isFinite(n) ? `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH` : '—';
}
// The fiat estimate under an ETH price, in the user's chosen currency. Returns '' when
// ETH-only is selected or no rate is available (so the caller renders nothing).
function fmtFiat(eth) {
  if (currency === 'eth' || eth == null || ethUsd == null) return '';
  const rate = currency === 'usd' ? 1 : fxRates[currency];
  if (rate == null) return '';
  const val = Number(eth) * ethUsd * rate;
  try {
    return `≈ ${new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(val)}`;
  } catch {
    return `≈ ${Math.round(val).toLocaleString()} ${currency.toUpperCase()}`;
  }
}

// --- Known wallet bugs ---
// MetaMask extension 13.33.0+ ships a regression that wrongly reports "not enough IMX
// to pay for network fees" on custom networks even when the balance is ample (confirmed
// in the wild 2026-06-10; 13.32 and below behave). We read the wallet's version and
// warn affected users BEFORE they hit the wall. Bounded to major 13 on the assumption
// 14.x ships fixed — revisit/remove once MetaMask patches the regression.
let mmBuggyVersion = null;
async function detectWalletBug() {
  if (!eth()) return;
  try {
    const v = String(await eth().request({ method: 'web3_clientVersion' }) || '');
    const m = v.match(/MetaMask\/v?(\d+)\.(\d+)\.(\d+)/i);
    if (m && Number(m[1]) === 13 && Number(m[2]) >= 33) mmBuggyVersion = `${m[1]}.${m[2]}.${m[3]}`;
  } catch { /* harmless — no warning then */ }
  patchWalletNotice();
}
function mmWarnDismissed() {
  try { return localStorage.getItem('hcc-mmwarn-' + mmBuggyVersion) === '1'; } catch { return false; }
}
function walletNoticeHtml() {
  if (!mmBuggyVersion || mmWarnDismissed()) return '';
  return `
    <div class="trade-mmwarn" role="note">
      <span aria-hidden="true">⚠</span>
      <span>${esc(t('trade.mmbug.notice').replace('{v}', mmBuggyVersion))}</span>
      ${tipHtml('trade.mmbug.detail')}
      <button class="trade-bridgebar-x" data-act="mmwarn-dismiss" type="button" aria-label="${esc(t('trade.bridgebar.dismiss'))}">×</button>
    </div>`;
}
function patchWalletNotice() {
  const el = root()?.querySelector('#trade-mmwarn-slot');
  if (el) el.innerHTML = walletNoticeHtml();
}

// Map a wallet/provider error to a friendly, actionable message — never a raw revert.
function friendlyError(err) {
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

// --- Chain reads (through the wallet's provider) ---
async function readBalance() {
  if (!account || !onZk()) return null;
  try {
    const res = await eth().request({ method: 'eth_call', params: [{ to: CREATURE_CONTRACT, data: SEL_BALANCE_OF + word(account) }, 'latest'] });
    return parseInt(res, 16) || 0;
  } catch { return null; }
}
async function ownerOf(tokenId) {
  try {
    const res = await eth().request({ method: 'eth_call', params: [{ to: CREATURE_CONTRACT, data: SEL_OWNER_OF + word(tokenId) }, 'latest'] });
    if (!res || res.length < 42) return null;
    return ('0x' + res.slice(-40)).toLowerCase();
  } catch { return null; }
}
// Balances (wei BigInt, or null on read failure) for the funds-help block.
async function readErc20(token, addr) {
  try { return BigInt(await eth().request({ method: 'eth_call', params: [{ to: token, data: SEL_BALANCE_OF + word(addr) }, 'latest'] }) || '0x0'); }
  catch { return null; }
}
async function readNative(addr) {
  try { return BigInt(await eth().request({ method: 'eth_getBalance', params: [addr, 'latest'] }) || '0x0'); }
  catch { return null; }
}
function fmtWeiEth(wei) {
  if (wei == null) return '—';
  return (Number(wei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 });
}
// "0.0618 ETH (≈ R$ 520)" — every ETH amount carries the user's selected currency.
function fmtEthFiat(eth) {
  if (eth == null || !Number.isFinite(Number(eth))) return '—';
  const fiat = fmtFiat(eth);
  return fiat ? `${fmtEth(eth)} (${fiat})` : fmtEth(eth);
}
const weiToEth = wei => (wei == null ? null : Number(wei) / 1e18);

// --- Wallet actions ---
async function ensureNetwork() {
  try {
    await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ZK_CHAIN_ID_HEX }] });
  } catch (err) {
    if (err?.code === 4902 || /unrecognized chain|add.*chain/i.test(err?.message || '')) {
      await eth().request({ method: 'wallet_addEthereumChain', params: [ZK_NETWORK] });
    } else { throw err; }
  }
  chainId = await eth().request({ method: 'eth_chainId' });
}

async function connect() {
  if (!eth() || busy) return;
  busy = true; render();
  try {
    const accounts = await eth().request({ method: 'eth_requestAccounts' });
    account = (accounts[0] || '').toLowerCase() || null;
    chainId = await eth().request({ method: 'eth_chainId' });
    if (account && !onZk()) await ensureNetwork();
  } catch (err) {
    console.error('Wallet connect failed:', err);
    pendingFlash = friendlyError(err);
  } finally { busy = false; render(); }
}

async function switchNetwork(btn) {
  if (busy) return;
  busy = true;
  if (btn) { btn.disabled = true; btn.textContent = t('trade.net.switching'); }
  try { await ensureNetwork(); pendingFlash = null; }
  catch (err) { console.error('Network switch failed:', err); pendingFlash = friendlyError(err); }
  finally { busy = false; render(); }
}

async function sendTransfer(tokenId, to) {
  const data = SEL_SAFE_TRANSFER + word(account) + word(to) + word(tokenId);
  return eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to: CREATURE_CONTRACT, data }] });
}

// --- Browse ---
async function loadListings(reset = true) {
  if (reset) { listings = []; listingsCursor = null; listingsError = false; }
  if (!reset && (!listingsCursor || listingsLoading)) return;
  listingsLoading = true; patchGrid();
  try {
    const url = reset ? LISTINGS_API : `${LISTINGS_API}?cursor=${encodeURIComponent(listingsCursor)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    if (data.ethUsd != null) ethUsd = data.ethUsd;
    if (data.fxRates) fxRates = data.fxRates;
    listings = reset ? (data.items || []) : listings.concat(data.items || []);
    listingsCursor = data.nextCursor || null;
  } catch (err) {
    console.error('Listings load failed:', err);
    if (reset) listingsError = true;
  } finally { listingsLoading = false; patchGrid(); }
}

function skeletons(n) {
  return Array.from({ length: n }, () =>
    `<div class="trade-tile trade-skel" aria-hidden="true"><div class="trade-tile-media"></div><div class="trade-tile-body"><span></span><span></span></div></div>`).join('');
}

function rarityChip(rarity) {
  return rarity ? `<span class="trade-rar" data-r="${esc(String(rarity).toLowerCase())}">${esc(rarity)}</span>` : '';
}

function tileHtml(it) {
  const fiat = fmtFiat(it.totalEth ?? it.priceEth);
  const img = it.image
    ? `<img class="trade-tile-img" src="${esc(it.image)}" alt="" loading="lazy" />`
    : `<div class="trade-tile-img trade-tile-noimg" aria-hidden="true">🐾</div>`;
  return `
    <button class="trade-tile" type="button" data-act="open" data-token="${esc(it.tokenId)}">
      <div class="trade-tile-media">${img}${rarityChip(it.rarity)}</div>
      <div class="trade-tile-body">
        <span class="trade-tile-name">${esc(it.name)}</span>
        <span class="trade-tile-price">${esc(fmtEth(it.totalEth ?? it.priceEth))}</span>
        ${fiat ? `<span class="trade-tile-usd">${esc(fiat)}</span>` : ''}
      </div>
    </button>`;
}

function gridInnerHtml() {
  if (listingsLoading && !listings.length) return skeletons(8);
  if (listingsError && !listings.length) {
    return `<div class="trade-grid-state"><p>${esc(t('trade.browse.error'))}</p>
      <button class="apply-btn-ghost" data-act="retry" type="button">${esc(t('trade.browse.retry'))}</button></div>`;
  }
  if (!listings.length) {
    return `<div class="trade-grid-state"><div class="trade-grid-state-ico" aria-hidden="true">🛒</div><p>${esc(t('trade.browse.empty'))}</p></div>`;
  }
  return listings.map(tileHtml).join('');
}

function loadMoreHtml() {
  if (!listings.length || !listingsCursor) return '';
  return `<button class="apply-btn-ghost" data-act="loadmore" type="button" ${listingsLoading ? 'disabled' : ''}>${esc(listingsLoading ? t('trade.browse.loadingMore') : t('trade.browse.loadMore'))}</button>`;
}

function patchGrid() {
  const g = root()?.querySelector('#trade-grid');
  if (g) g.innerHTML = gridInnerHtml();
  const lm = root()?.querySelector('#trade-loadmore');
  if (lm) lm.innerHTML = loadMoreHtml();
}

// --- Token detail modal ---
async function openModal(tokenId) {
  modalToken = tokenId; modalMeta = null; modalLoading = true; buyState = null;
  tokenOffers = null;
  if (offerCtx === 'modal') { offerState = null; offerCtx = null; }
  acceptState = null;
  loadTokenOffers(tokenId);
  patchModal();
  try {
    const res = await fetch(TOKEN_API + encodeURIComponent(tokenId), { headers: { Accept: 'application/json' } });
    if (res.ok) modalMeta = await res.json();
  } catch (err) { console.error('Token detail failed:', err); }
  modalLoading = false;
  if (String(modalToken) === String(tokenId)) patchModal();
}
function closeModal() {
  if (buyState && BUY_BUSY_PHASES.has(buyState.phase)) return; // don't lose an in-flight purchase
  modalToken = null; modalMeta = null; buyState = null; patchModal();
}

function modalCardHtml() {
  const it = listings.find(l => String(l.tokenId) === String(modalToken)) || {};
  const meta = modalMeta || {};
  const image = meta.image || it.image;
  const name = meta.name || it.name || `Highrise Creature #${modalToken}`;
  const img = image
    ? `<img class="trade-modal-img" src="${esc(image)}" alt="${esc(name)}" />`
    : `<div class="trade-modal-img trade-tile-noimg" aria-hidden="true">🐾</div>`;

  const allIn = it.totalEth ?? it.priceEth;
  const modalFiat = fmtFiat(allIn);
  const price = it.priceEth != null
    ? `<div class="trade-modal-price">
         <span class="trade-modal-price-eth">${esc(fmtEth(allIn))}</span>
         ${modalFiat ? `<span class="trade-modal-price-usd">${esc(modalFiat)}</span>` : ''}
         <span class="trade-modal-fees">${esc(t('trade.price.allin'))} ${tipHtml('trade.price.allin.tip')}</span>
       </div>
       ${buyAreaHtml(it)}`
    : `<div class="trade-modal-price"><span class="trade-modal-notlisted">${esc(t('trade.modal.notListed'))}</span></div>`;

  const traits = modalLoading
    ? `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.modal.loading'))}</div>`
    : (meta.attributes && meta.attributes.length
        ? `<div class="trade-modal-traits">${meta.attributes.map(a =>
            `<div class="trade-trait"><span class="trade-trait-k">${esc(a.trait)}</span><span class="trade-trait-v">${esc(a.value)}</span></div>`).join('')}</div>`
        : '');

  const owner = meta.owner ? `<div class="trade-modal-meta-row">${esc(t('trade.modal.owner'))}: <code>${esc(shortWallet(meta.owner))}</code></div>` : '';
  const idRow = `<div class="trade-modal-meta-row">${esc(t('trade.modal.tokenId'))}: <code class="trade-modal-tokenid">${esc(modalToken)}</code></div>`;
  const explorer = `${EXPLORER}/token/${CREATURE_CONTRACT}/instance/${encodeURIComponent(modalToken)}`;

  return `
    <button class="trade-modal-close" data-act="close" type="button" aria-label="${esc(t('trade.modal.close'))}">×</button>
    <div class="trade-modal-media">${img}${rarityChip(it.rarity)}</div>
    <div class="trade-modal-info">
      <h3 class="trade-modal-name">${esc(name)}</h3>
      ${price}
      ${modalOffersHtml(meta)}
      ${owner}
      ${idRow}
      ${traits}
      <a class="trade-modal-explorer" href="${esc(explorer)}" target="_blank" rel="noopener">${esc(t('trade.modal.viewExplorer'))} ↗</a>
    </div>`;
}

// --- Buy flow ---

function buyStatusHtml() {
  if (!buyState) return '';
  const STEP_KEY = {
    prepare: 'trade.buy.preparing',
    approve: 'trade.buy.approve',
    approveWait: 'trade.buy.approveWait',
    fulfill: 'trade.buy.confirm',
    fulfillWait: 'trade.buy.confirmWait',
  };
  if (buyState.phase === 'done') {
    return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.buy.done'))} `
      + `<a href="${esc(EXPLORER)}/tx/${esc(buyState.hash)}" target="_blank" rel="noopener">${esc(t('trade.status.view'))}</a></span></div>`;
  }
  if (buyState.phase === 'error') {
    return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(buyState.msg)}</span></div>`;
  }
  if (buyState.phase === 'funds') return fundsHelpHtml();
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP_KEY[buyState.phase] || 'trade.buy.preparing'))}</span></div>`;
}

// A warm, concrete "let's get your ETH ready" panel. The #1 confusion: the user HAS ETH,
// just on Ethereum mainnet, while trades settle on Immutable zkEVM. We acknowledge that
// kindly and show exactly what to do — never a blunt "0 ETH / wrong".
function fundsHelpHtml() {
  const f = buyState;
  const need = fmtEthFiat(f.need);
  const imx = fmtWeiEth(f.imxBal);
  let mainnetEth = 0;
  try { mainnetEth = f.mainnetEthWei != null ? Number(BigInt(f.mainnetEthWei)) / 1e18 : 0; } catch { mainnetEth = 0; }
  const hasMainnet = mainnetEth > 0;
  const hasGas = f.imxBal != null && Number(f.imxBal) / 1e18 >= 0.005;

  // IMX (gas) row — celebrate when they're already covered, gently note it when not.
  const imxRow = hasGas
    ? `<li class="is-ok"><span class="trade-funds-ic" aria-hidden="true">✓</span><div>${esc(t('trade.funds.imxGood'))}<br><span>${esc(t('trade.funds.have'))} ${esc(imx)} IMX</span></div></li>`
    : `<li><span class="trade-funds-ic" aria-hidden="true">•</span><div>${esc(t('trade.funds.imxNeed'))}<br><span>${esc(t('trade.funds.have'))} ${esc(imx)} IMX · ${esc(t('trade.funds.gasHint'))}</span></div></li>`;

  // The common, reassuring case: they have ETH on mainnet — it just needs to bridge over.
  if (hasMainnet) {
    // Quoted one-tap bridge (exact amount, in-panel) when available; deep-link fallback.
    let bridgeArea;
    if (f.quote === 'loading') {
      bridgeArea = `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.bridge.quote.loading'))}</div>`;
    } else if (f.quote && f.quote.tx) {
      const q = f.quote;
      const mins = q.durationSeconds ? Math.max(1, Math.ceil(q.durationSeconds / 60)) : null;
      const meta = [
        q.feeUsd != null ? t('trade.bridge.quote.fees').replace('{f}', String(q.feeUsd)) : null,
        mins != null ? t('trade.bridge.quote.mins').replace('{m}', String(mins)) : null,
        t('trade.bridge.quote.by'),
      ].filter(Boolean).join(' · ');
      const busy = bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase);
      bridgeArea = `
        <div class="trade-bridge-quote">
          <div class="trade-bridge-line">${esc(t('trade.bridge.quote.line').replace('{x}', fmtEthFiat(q.fromEth)).replace('{y}', fmtEthFiat(q.toEth)))}</div>
          <div class="trade-bridge-meta">${esc(meta)}</div>
          ${bridgeJob?.phase === 'done' ? '' : `<button class="trade-funds-btn" data-act="bridge-now" type="button" ${busy ? 'disabled' : ''}>${esc(t('trade.bridge.now'))}</button>`}
          ${bridgeStatusHtml()}
        </div>`;
    } else {
      bridgeArea = `<a class="trade-funds-btn" href="${BRIDGE_URL}" target="_blank" rel="noopener">${esc(t('trade.funds.bridgeBtn'))} ↗</a>
        <p class="trade-funds-foot">${esc(t('trade.funds.bridgeFoot'))}</p>`;
    }
    return `
      <div class="trade-funds">
        <div class="trade-funds-h"><span aria-hidden="true">💡</span> ${esc(t('trade.funds.bridgeH'))} ${tipHtml('trade.funds.bridgeP')}</div>
        <ul class="trade-funds-list">
          <li><span class="trade-funds-ic" aria-hidden="true">↗</span><div>
            <b>ETH</b> — ${esc(t('trade.funds.ethTitle'))}<br>
            <span>${esc(t('trade.funds.youHaveOnEth').replace('{x}', fmtEthFiat(weiToEth(f.mainnetEthWei))))} · ${esc(t('trade.funds.bridgeNeed').replace('{x}', need))}</span>
          </div></li>
          ${imxRow}
        </ul>
        ${bridgeArea}
      </div>`;
  }

  // No ETH detected anywhere — still gentle, just a "here's how to get set up".
  return `
    <div class="trade-funds">
      <div class="trade-funds-h"><span aria-hidden="true">💡</span> ${esc(t('trade.funds.h'))} ${tipHtml('trade.funds.intro')}</div>
      <ul class="trade-funds-list">
        <li><span class="trade-funds-ic" aria-hidden="true">•</span><div><b>ETH</b> — ${esc(t('trade.funds.forPrice'))}<br><span>${esc(t('trade.funds.need'))} ≈ <b>${esc(need)}</b> · ${esc(t('trade.funds.have'))} ${esc(fmtEthFiat(weiToEth(f.ethBal)))}</span></div></li>
        ${imxRow}
      </ul>
      <p class="trade-funds-net">${esc(t('trade.funds.net'))}</p>
      <a class="trade-funds-btn" href="${BRIDGE_URL}" target="_blank" rel="noopener">${esc(t('trade.funds.bridge'))} ↗</a>
    </div>`;
}

// Read balances (zkEVM ETH + IMX, and mainnet ETH via the server), then show the panel.
// When the user has mainnet ETH, also ask the server for an exact-output Squid quote so
// the panel can offer one-tap bridging of precisely the shortfall.
async function showFundsHelp(it) {
  const need = it.totalEth ?? it.priceEth;
  buyState = { phase: 'funds', need, ethBal: null, imxBal: null, mainnetEthWei: null, quote: 'loading' };
  patchModal();
  const [ethBal, imxBal, elsewhere] = await Promise.all([
    readErc20(IMX_ETH_TOKEN, account),
    readNative(account),
    fetch(`/api/market/creatures/eth-elsewhere/${account}`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (buyState?.phase !== 'funds') return;
  const mainnetEthWei = elsewhere?.mainnetEthWei ?? null;
  buyState = { phase: 'funds', need, ethBal, imxBal, mainnetEthWei, quote: 'loading' };
  patchModal();

  // Shortfall on zkEVM (in ETH); only quote when they hold mainnet ETH to bridge.
  const haveZk = ethBal != null ? Number(ethBal) / 1e18 : 0;
  const shortfall = Math.max(0, need - haveZk);
  let hasMainnet = false;
  try { hasMainnet = mainnetEthWei != null && BigInt(mainnetEthWei) > 0n; } catch { hasMainnet = false; }
  if (!hasMainnet || shortfall <= 0) {
    buyState.quote = null; patchModal(); return;
  }
  try {
    const res = await fetch('/api/market/creatures/bridge/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ address: account, needEth: shortfall.toFixed(18).replace(/0+$/, '').replace(/\.$/, '') }),
    });
    const q = res.ok ? await res.json() : null;
    if (buyState?.phase === 'funds') { buyState.quote = q; patchModal(); }
  } catch {
    if (buyState?.phase === 'funds') { buyState.quote = null; patchModal(); }
  }
}

// --- One-tap bridge (Squid): persistent job + live tracker ---
// The bridge outlives any one screen: the job is held module-wide AND persisted to
// localStorage, so closing the modal, switching tabs, or reloading the page never
// loses track of it — a slim banner on the Trade tab keeps reporting until it lands.
let bridgeJob = null; // {phase, hash, mins, startedAt, stage, axelarUrl, msg, needWei, quoteId, requestId, account}
const BRIDGE_STORE = 'hcc-bridge';
const BRIDGE_TERMINAL = new Set(['done', 'slow', 'error']);

function saveBridge() {
  try {
    if (bridgeJob && bridgeJob.hash) localStorage.setItem(BRIDGE_STORE, JSON.stringify(bridgeJob));
    else localStorage.removeItem(BRIDGE_STORE);
  } catch { /* private mode — tracking still works for this session */ }
}
function loadSavedBridge() {
  try {
    const raw = localStorage.getItem(BRIDGE_STORE);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j?.hash || !j.startedAt || Date.now() - j.startedAt > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(BRIDGE_STORE);
      return null;
    }
    return j;
  } catch { return null; }
}
function dismissBridge() {
  bridgeJob = null;
  try { localStorage.removeItem(BRIDGE_STORE); } catch { /* fine */ }
  patchBridgeBanner();
  patchModal();
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function bridgeLinksHtml(b) {
  if (!b?.hash) return '';
  const axelar = b.axelarUrl || `https://axelarscan.io/gmp/${b.hash}`;
  return `<a href="https://etherscan.io/tx/${esc(b.hash)}" target="_blank" rel="noopener">${esc(t('trade.bridge.etherscan'))}</a>
    · <a href="${esc(axelar)}" target="_blank" rel="noopener">${esc(t('trade.bridge.axelar'))}</a>`;
}

// Full tracker (modal funds panel): stage stepper + elapsed clock + ETA bar + links.
function bridgeTrackerHtml(b) {
  const idx = { submitted: 0, src_confirmed: 1, bridging: 1, arrived: 2 }[b.stage] ?? 0;
  const steps = ['trade.bridge.step1', 'trade.bridge.step2', 'trade.bridge.step3'].map((k, i) => {
    const state = i < idx ? 'is-done' : i === idx ? 'is-active' : '';
    const ico = i < idx ? '✓' : (i === idx ? '<span class="trade-mini-spin" aria-hidden="true"></span>' : '·');
    return `<li class="${state}"><span class="trade-track-ic">${ico}</span><span>${esc(t(k))}</span></li>`;
  }).join('');
  const minsText = b.mins ? `~${b.mins} min` : t('trade.bridge.mins.few');
  return `
    <div class="trade-track" role="status" aria-live="polite">
      <ul class="trade-track-steps">${steps}</ul>
      <div class="trade-track-bar" aria-hidden="true"><div class="trade-track-barfill" data-bridge-bar></div></div>
      <div class="trade-track-meta">
        <span><b data-bridge-elapsed>${esc(fmtElapsed(Date.now() - b.startedAt))}</b> ${esc(t('trade.bridge.elapsed'))} · ${esc(t('trade.bridge.eta'))} ${esc(minsText)}</span>
        <span>${bridgeLinksHtml(b)}</span>
      </div>
    </div>`;
}

// Slim always-visible banner (under the wallet bar) so the bridge stays in view —
// and survives — wherever the user goes. Dismissible once terminal.
function bridgeBannerHtml() {
  const b = bridgeJob;
  if (!b || (!b.hash && !BRIDGE_TERMINAL.has(b.phase))) return '';
  const stageKey = { submitted: 'trade.bridge.step1', src_confirmed: 'trade.bridge.step2', bridging: 'trade.bridge.step2', arrived: 'trade.bridge.step3' }[b.stage] || 'trade.bridge.step1';
  const dismiss = BRIDGE_TERMINAL.has(b.phase)
    ? `<button class="trade-bridgebar-x" data-act="bridge-dismiss" type="button" aria-label="${esc(t('trade.bridgebar.dismiss'))}">×</button>` : '';
  if (b.phase === 'done') {
    return `<div class="trade-bridgebar is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.bridgebar.done'))}</span><span class="trade-bridgebar-links">${bridgeLinksHtml(b)}</span>${dismiss}</div>`;
  }
  if (b.phase === 'error') {
    return `<div class="trade-bridgebar is-bad"><span aria-hidden="true">⚠</span><span>${esc(b.msg || t('trade.bridge.failed'))}</span><span class="trade-bridgebar-links">${bridgeLinksHtml(b)}</span>${dismiss}</div>`;
  }
  const slow = b.phase === 'slow' ? ` ${esc(t('trade.bridgebar.slowTag'))}` : '';
  return `
    <div class="trade-bridgebar" role="status" aria-live="polite">
      <span class="trade-mini-spin" aria-hidden="true"></span>
      <span>${esc(t('trade.bridgebar.bridging'))} — ${esc(t(stageKey))}${slow} · <b data-bridge-elapsed>${esc(fmtElapsed(Date.now() - b.startedAt))}</b>${b.mins ? ` / ~${esc(String(b.mins))} min` : ''}</span>
      <span class="trade-bridgebar-links">${bridgeLinksHtml(b)}</span>
      ${dismiss}
    </div>`;
}
function patchBridgeBanner() {
  const el = root()?.querySelector('#trade-bridgebar-slot');
  if (el) el.innerHTML = bridgeBannerHtml();
}

// 1-second UI tick for the elapsed clocks + ETA bars (panel + banner) — direct DOM
// writes, no re-render.
let bridgeTickTimer = null;
function startBridgeTicker() {
  if (bridgeTickTimer) return;
  bridgeTickTimer = setInterval(() => {
    const b = bridgeJob;
    if (!b || !['waiting', 'slow'].includes(b.phase) || !root()) { clearInterval(bridgeTickTimer); bridgeTickTimer = null; return; }
    root().querySelectorAll('[data-bridge-elapsed]').forEach(el => { el.textContent = fmtElapsed(Date.now() - b.startedAt); });
    if (b.mins) {
      const w = `${Math.min(96, ((Date.now() - b.startedAt) / (b.mins * 60000)) * 100)}%`;
      root().querySelectorAll('[data-bridge-bar]').forEach(el => { el.style.width = w; });
    }
  }, 1000);
}

function bridgeStatusHtml() {
  const b = bridgeJob;
  if (!b) return '';
  const STEP = { switch: 'trade.bridge.switch', confirm: 'trade.bridge.confirm', back: 'trade.bridge.back' };
  if (b.phase === 'waiting') return bridgeTrackerHtml(b);
  if (b.phase === 'done')  return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.bridge.done'))}</span></div>`;
  if (b.phase === 'slow') {
    return `${bridgeTrackerHtml(b)}<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t('trade.bridge.slow'))}</span></div>`;
  }
  if (b.phase === 'error') {
    return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(b.msg)} ${bridgeLinksHtml(b)}</span></div>`;
  }
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP[b.phase]))}</span></div>`;
}

function setBridgeJob(patchFields) {
  bridgeJob = { ...bridgeJob, ...patchFields };
  saveBridge();
  patchModal();
  patchBridgeBanner();
}

// The tracking loop — independent of any screen. Resumable: runs off bridgeJob alone,
// so it works identically right after sending and after a page reload mid-bridge.
async function trackBridge() {
  const job = bridgeJob;
  if (!job?.hash) return;
  startBridgeTicker();
  const needWei = BigInt(job.needWei);
  // Wait ≥25 min (or 2× ETA) from when the bridge STARTED, with a 10-min floor from
  // now so a just-resumed old job still gets a fair polling window.
  const deadline = Math.max(job.startedAt + Math.max(25 * 60 * 1000, (job.mins || 0) * 120000), Date.now() + 10 * 60 * 1000);
  let tick = 0;
  while (Date.now() < deadline) {
    if (bridgeJob !== job || job.phase !== 'waiting') return;
    const bal = await readErc20(IMX_ETH_TOKEN, job.account);
    if (bal != null && bal >= needWei) return setBridgeJob({ phase: 'done', stage: 'arrived' });
    if (tick++ % 2 === 0) { // status every ~20s — visible movement without rate pressure
      try {
        const r = await fetch(`/api/market/creatures/bridge/status?tx=${job.hash}&quoteId=${encodeURIComponent(job.quoteId || '')}&requestId=${encodeURIComponent(job.requestId || '')}`);
        if (r.ok) {
          const s = await r.json();
          if (bridgeJob !== job || job.phase !== 'waiting') return;
          if (s.stage === 'failed' || s.stage === 'failed_src') return setBridgeJob({ phase: 'error', msg: t('trade.bridge.failed'), axelarUrl: s.axelarUrl || job.axelarUrl });
          if (s.stage === 'needs_gas') return setBridgeJob({ phase: 'error', msg: t('trade.bridge.needsGas'), axelarUrl: s.axelarUrl || job.axelarUrl });
          if (s.stage !== job.stage || (s.axelarUrl && s.axelarUrl !== job.axelarUrl)) {
            setBridgeJob({ stage: s.stage, axelarUrl: s.axelarUrl || job.axelarUrl });
          }
        }
      } catch { /* transient — keep tracking */ }
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  if (bridgeJob === job && job.phase === 'waiting') setBridgeJob({ phase: 'slow' });
}

async function handleBridgeNow() {
  const f = buyState;
  const q = f?.quote;
  if (!q || q === 'loading' || !q.tx) return;
  if (bridgeJob && !BRIDGE_TERMINAL.has(bridgeJob.phase)) return; // one bridge at a time
  try {
    bridgeJob = { phase: 'switch', account, mins: null, startedAt: Date.now() };
    patchModal();
    await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
    setBridgeJob({ phase: 'confirm' });
    const hash = await eth().request({
      method: 'eth_sendTransaction',
      params: [{ from: account, to: q.tx.to, data: q.tx.data, value: q.tx.value, ...(q.tx.gas ? { gas: q.tx.gas } : {}) }],
    });
    setBridgeJob({ phase: 'back', hash });
    await ensureNetwork(); // back to Immutable zkEVM
    const mins = q.durationSeconds ? Math.max(1, Math.ceil(q.durationSeconds / 60)) : null;
    const needWei = (BigInt(Math.round((f?.need ?? 0) * 1e6)) * 10n ** 12n).toString();
    setBridgeJob({
      phase: 'waiting', hash, mins, startedAt: Date.now(), stage: 'submitted',
      axelarUrl: null, needWei, quoteId: q.quoteId || '', requestId: q.requestId || '', account,
    });
    trackBridge();
  } catch (err) {
    console.error('Bridge failed:', err);
    setBridgeJob({ phase: 'error', msg: friendlyError(err) });
  }
}

function buyAreaHtml(it) {
  if (buyState?.phase === 'done') return buyStatusHtml();
  if (account && it.seller && it.seller.toLowerCase() === account) {
    return `<p class="trade-modal-own">${esc(t('trade.buy.own'))}</p>`;
  }
  const busyNow = buyState && BUY_BUSY_PHASES.has(buyState.phase);
  let btn;
  if (!eth()) {
    btn = `<a class="trade-send trade-buy-btn" href="https://metamask.io/download/" target="_blank" rel="noopener">${esc(t('trade.install.btn'))}</a>`;
  } else if (!account) {
    btn = `<button class="trade-send trade-buy-btn" data-act="connect" type="button">${esc(t('trade.buy.connect'))}</button>`;
  } else if (!onZk()) {
    btn = `<button class="trade-send trade-buy-btn" data-act="switch" type="button">${esc(t('trade.net.switch'))}</button>`;
  } else {
    btn = `<button class="trade-send trade-buy-btn" data-act="buy" data-listing="${esc(it.listingId)}" type="button" ${busyNow ? 'disabled' : ''}>
      ${esc(t('trade.buy.btn'))} · ${esc(fmtEthFiat(it.totalEth ?? it.priceEth))}</button>`;
  }
  return `<div class="trade-buy">${btn}<p class="trade-beta-micro">${esc(t('trade.beta.micro'))}</p>${buyStatusHtml()}</div>`;
}

function setBuy(phase, extra) {
  buyState = { phase, ...extra };
  patchModal();
}

// Server prepare-error codes → friendly copy.
function buyServerError(code) {
  const KEY = {
    not_found: 'trade.err.gone', not_active: 'trade.err.gone',
    insufficient: 'trade.err.funds', rate_limited: 'trade.err.rate',
    own_listing: 'trade.buy.own',
  };
  return t(KEY[code] || 'trade.err.unavailable');
}

// Poll the wallet provider for a receipt; resolves to it (or null on timeout).
async function waitForReceipt(hash, timeoutMs = 180000) {
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

async function handleBuy(listingId) {
  if (buyState && BUY_BUSY_PHASES.has(buyState.phase)) return;
  const it = listings.find(l => l.listingId === listingId);
  if (!it) return;

  try {
    setBuy('prepare');
    const res = await fetch('/api/market/creatures/buy/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ listingId, takerAddress: account }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === 'insufficient') { await showFundsHelp(it); return; }
      setBuy('error', { msg: buyServerError(data.error) });
      return;
    }

    // Pre-flight: verify the on-chain balances OURSELVES before opening MetaMask, so a
    // real shortfall surfaces as the friendly funds panel — and any wallet-side
    // "insufficient funds" alert that still appears is a false positive (MetaMask's
    // balance reads on custom networks can lag and report 0).
    const [zkEthBal, imxBal] = await Promise.all([readErc20(IMX_ETH_TOKEN, account), readNative(account)]);
    const needWei = BigInt(Math.round((it.totalEth ?? it.priceEth) * 1e6)) * 10n ** 12n;
    if (zkEthBal != null && zkEthBal < needWei) { await showFundsHelp(it); return; }
    if (imxBal != null && imxBal === 0n) { setBuy('error', { msg: t('trade.err.gas') }); return; }

    for (const tx of (data.transactions || [])) {
      const isApproval = tx.purpose === 'APPROVAL';
      setBuy(isApproval ? 'approve' : 'fulfill');
      const hash = await eth().request({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: tx.to, data: tx.data, value: tx.value && tx.value !== '0x0' ? tx.value : undefined }],
      });
      setBuy(isApproval ? 'approveWait' : 'fulfillWait', { hash });
      const receipt = await waitForReceipt(hash);
      if (!receipt || receipt.status !== '0x1') { setBuy('error', { msg: t('trade.err.txFailed') }); return; }
      if (!isApproval) {
        setBuy('done', { hash });
        listings = listings.filter(l => l.listingId !== listingId); // it's sold — drop from the grid
        patchGrid();
        refreshBalance();
        return;
      }
    }
    // No FULFILL_ORDER transaction came back — treat as unavailable rather than charge nothing silently.
    setBuy('error', { msg: t('trade.err.unavailable') });
  } catch (err) {
    console.error('Buy failed:', err);
    setBuy('error', { msg: friendlyError(err) });
  }
}

// --- Offers (bids + collection "floor" offers) ---

async function loadCollOffers() {
  try {
    const res = await fetch('/api/market/creatures/offers/collection', { headers: { Accept: 'application/json' } });
    collOffers = res.ok ? ((await res.json()).offers || []) : [];
  } catch { collOffers = []; }
  patchCollStrip();
  patchSellView();
}
async function loadMyOffers() {
  if (!account) { myOffers = null; return; }
  try {
    const res = await fetch(`/api/market/creatures/offers/mine/${account}`, { headers: { Accept: 'application/json' } });
    myOffers = res.ok ? ((await res.json()).offers || []) : [];
  } catch { myOffers = []; }
  patchCollStrip();
}
async function loadTokenOffers(tokenId) {
  tokenOffers = null;
  try {
    const res = await fetch(`/api/market/creatures/offers/token/${encodeURIComponent(tokenId)}`, { headers: { Accept: 'application/json' } });
    const offers = res.ok ? ((await res.json()).offers || []) : [];
    if (String(modalToken) === String(tokenId)) { tokenOffers = offers; patchModal(); }
  } catch { if (String(modalToken) === String(tokenId)) { tokenOffers = []; patchModal(); } }
}

function offerStatusHtml() {
  if (!offerState) return '';
  const STEP = {
    prepare: 'trade.offer.preparing', approve: 'trade.offer.approve', approveWait: 'trade.offer.approveWait',
    sign: 'trade.offer.sign', create: 'trade.offer.create',
  };
  if (offerState.phase === 'done')  return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.offer.done'))}</span></div>`;
  if (offerState.phase === 'error') return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(offerState.msg)}</span></div>`;
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP[offerState.phase]))}</span></div>`;
}
function acceptStatusHtml() {
  if (!acceptState) return '';
  const STEP = {
    prepare: 'trade.accept.preparing', approve: 'trade.accept.approve', approveWait: 'trade.accept.approveWait',
    fulfill: 'trade.accept.confirm', fulfillWait: 'trade.accept.confirmWait',
  };
  if (acceptState.phase === 'done') {
    const link = acceptState.hash ? ` <a href="${esc(EXPLORER)}/tx/${esc(acceptState.hash)}" target="_blank" rel="noopener">${esc(t('trade.status.view'))}</a>` : '';
    return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.accept.done'))}${link}</span></div>`;
  }
  if (acceptState.phase === 'error') return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(acceptState.msg)}</span></div>`;
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP[acceptState.phase]))}</span></div>`;
}

// Offer rows for the token modal: list + accept (owner) or make-an-offer (everyone else).
function modalOffersHtml(meta) {
  const isOwner = account && meta?.owner && meta.owner === account;
  const rows = tokenOffers === null
    ? `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.offers.loading'))}</div>`
    : (tokenOffers.length
        ? `<ul class="trade-offer-list">${tokenOffers.slice(0, 3).map(o => `
            <li>
              <span class="trade-offer-price">${esc(fmtEthFiat(o.priceEth))}</span>
              <span class="trade-offer-meta">${esc(t('trade.offers.net').replace('{x}', fmtEthFiat(o.netEth)))} · ${esc(t('trade.offers.from'))} <code>${esc(shortWallet(o.from))}</code></span>
              ${isOwner ? `<button class="trade-offer-accept" data-act="accept-offer" data-offer="${esc(o.offerId)}" type="button" ${acceptBusyId ? 'disabled' : ''}>${esc(acceptBusyId === o.offerId ? t('trade.accept.busy') : t('trade.offers.accept'))}</button>` : ''}
            </li>`).join('')}</ul>`
        : `<p class="trade-offers-none">${esc(t('trade.offers.none'))}</p>`);

  const makeBusy = offerState && OFFER_BUSY.has(offerState.phase);
  const makeForm = !isOwner && account && onZk()
    ? `<form class="trade-offer-form" id="trade-offer-form" data-token="${esc(modalToken)}" novalidate>
        <input id="trade-offer-price" type="text" inputmode="decimal" placeholder="${esc(t('trade.offers.make.ph'))}" autocomplete="off" />
        <button class="trade-offer-btn" type="submit" ${makeBusy ? 'disabled' : ''}>${esc(t('trade.offers.make.btn'))}</button>
      </form>`
    : '';

  return `
    <div class="trade-offers">
      <h4 class="trade-offers-h">${esc(t('trade.offers.h'))}</h4>
      ${rows}
      ${isOwner ? acceptStatusHtml() : ''}
      ${makeForm}
      ${offerCtx === 'modal' ? offerStatusHtml() : ''}
    </div>`;
}

// Collection-offer strip on the Buy tab: top standing offer + place-your-own + manage yours.
function collStripHtml() {
  const top = collOffers?.[0];
  const makeBusy = offerState && OFFER_BUSY.has(offerState.phase);
  const mineRows = (myOffers && myOffers.length)
    ? `<div class="trade-myoffers">
        <span class="trade-myoffers-h">${esc(t('trade.coll.mine.h'))}</span>
        ${myOffers.map(o => `
          <span class="trade-myoffer-chip">
            ${esc(o.collection ? t('trade.coll.chipAny') : `#…${String(o.tokenId).slice(-4)}`)} · ${esc(fmtEthFiat(o.priceEth))}
            <button data-act="cancel-offer" data-offer="${esc(o.offerId)}" type="button" aria-label="${esc(t('trade.coll.cancel'))}" ${acceptBusyId ? 'disabled' : ''}>×</button>
          </span>`).join('')}
      </div>`
    : '';
  return `
    <div class="trade-colloffer" id="trade-colloffer">
      <div class="trade-colloffer-row">
        <div class="trade-colloffer-info">
          <span class="trade-colloffer-label">${esc(t('trade.coll.top'))} ${tipHtml('trade.coll.make.p')}</span>
          <span class="trade-colloffer-price">${top ? esc(fmtEthFiat(top.priceEth)) : esc(t('trade.coll.none'))}</span>
        </div>
        ${account && onZk() ? `
          <form class="trade-offer-form is-inline" id="trade-coll-offer-form" novalidate>
            <input id="trade-coll-offer-price" type="text" inputmode="decimal" placeholder="${esc(t('trade.offers.make.ph'))}" autocomplete="off" />
            <button class="trade-offer-btn" type="submit" ${makeBusy ? 'disabled' : ''}>${esc(t('trade.coll.make.btn'))}</button>
          </form>` : `<span class="trade-colloffer-hint">${esc(t('trade.coll.connectHint'))}</span>`}
      </div>
      ${offerCtx === 'browse' ? offerStatusHtml() : ''}
      ${mineRows}
    </div>`;
}
function patchCollStrip() {
  const el = root()?.querySelector('#trade-colloffer');
  if (el) el.outerHTML = collStripHtml();
}

// Instant-sell card on the Sell tab: sell the picked Creature into the top standing offer.
function instantSellHtml() {
  const top = collOffers?.[0];
  if (!top) return '';
  const busy = acceptState && ACCEPT_BUSY.has(acceptState.phase);
  return `
    <div class="trade-instant">
      <div class="trade-instant-head">
        <span class="trade-instant-ico" aria-hidden="true">⚡</span>
        <div>
          <b>${esc(t('trade.instant.h'))} </b>${tipHtml('trade.instant.tip')}
          <p>${esc(t('trade.instant.line').replace('{x}', fmtEthFiat(top.priceEth)).replace('{y}', fmtEthFiat(top.netEth)))}</p>
        </div>
      </div>
      <button class="trade-send trade-instant-btn" data-act="instant-sell" data-offer="${esc(top.offerId)}" type="button" ${!sellSel || busy ? 'disabled' : ''}>
        ${esc(t('trade.instant.btn').replace('{x}', fmtEthFiat(top.netEth)))}</button>
      ${offerCtx !== 'modal' ? acceptStatusHtml() : ''}
    </div>`;
}

function offerServerError(code) {
  const KEY = {
    insufficient: 'trade.err.offerFunds', bad_price: 'trade.err.badPrice',
    rate_limited: 'trade.err.rate', own_listing: 'trade.err.ownOffer',
    not_found: 'trade.err.offerGone', not_active: 'trade.err.offerGone',
  };
  return t(KEY[code] || 'trade.err.unavailable');
}

function setOffer(phase, extra) { offerState = { phase, ...extra }; patchModal(); patchCollStrip(); }
function setAccept(phase, extra) { acceptState = { phase, ...extra }; patchModal(); patchSellView(); }

// Place an offer: prepare → (one-time ERC20 approval) → sign typed data → create.
async function handleMakeOffer(tokenId, priceRaw, ctx) {
  if (offerState && OFFER_BUSY.has(offerState.phase)) return;
  offerCtx = ctx;
  const price = (priceRaw || '').trim().replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,18})?$/.test(price) || Number(price) <= 0) return setOffer('error', { msg: t('trade.err.badPrice') });

  try {
    setOffer('prepare');
    const res = await fetch('/api/market/creatures/offer/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, priceEth: price, ...(tokenId != null ? { tokenId } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setOffer('error', { msg: offerServerError(data.error) });

    let signature = null;
    for (const action of (data.actions || [])) {
      if (action.type === 'TRANSACTION') {
        setOffer('approve');
        const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to: action.to, data: action.data, value: action.value && action.value !== '0x0' ? action.value : undefined }] });
        setOffer('approveWait');
        const receipt = await waitForReceipt(hash);
        if (!receipt || receipt.status !== '0x1') return setOffer('error', { msg: t('trade.err.txFailed') });
      } else if (action.type === 'SIGNABLE') {
        setOffer('sign');
        signature = await signTypedData(action.typedData);
      }
    }
    if (!signature) return setOffer('error', { msg: t('trade.err.unavailable') });

    setOffer('create');
    const createRes = await fetch('/api/market/creatures/offer/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderComponents: data.orderComponents, orderHash: data.orderHash, signature, collection: tokenId == null }),
    });
    const created = await createRes.json().catch(() => ({}));
    if (!createRes.ok) return setOffer('error', { msg: offerServerError(created.error) });

    setOffer('done');
    loadMyOffers();
    if (tokenId != null) loadTokenOffers(tokenId); else loadCollOffers();
  } catch (err) {
    console.error('Make offer failed:', err);
    setOffer('error', { msg: friendlyError(err) });
  }
}

// Accept an offer (sell a Creature into it): prepare → (NFT approval) → fill → receipt.
async function handleAcceptOffer(offerId, tokenId) {
  if (acceptBusyId) return;
  acceptBusyId = offerId;
  try {
    setAccept('prepare');
    const res = await fetch('/api/market/creatures/offer/accept/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ offerId, takerAddress: account, ...(tokenId != null ? { tokenId } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setAccept('error', { msg: offerServerError(data.error) }); return; }

    for (const tx of (data.transactions || [])) {
      const isApproval = tx.purpose === 'APPROVAL';
      setAccept(isApproval ? 'approve' : 'fulfill');
      const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to: tx.to, data: tx.data, value: tx.value && tx.value !== '0x0' ? tx.value : undefined }] });
      setAccept(isApproval ? 'approveWait' : 'fulfillWait', { hash });
      const receipt = await waitForReceipt(hash);
      if (!receipt || receipt.status !== '0x1') { setAccept('error', { msg: t('trade.err.txFailed') }); return; }
      if (!isApproval) {
        setAccept('done', { hash });
        sellSel = null;
        refreshBalance();
        loadSellerData();
        loadCollOffers();
        if (modalToken) loadTokenOffers(modalToken);
        return;
      }
    }
    setAccept('error', { msg: t('trade.err.unavailable') });
  } catch (err) {
    console.error('Accept offer failed:', err);
    setAccept('error', { msg: friendlyError(err) });
  } finally {
    acceptBusyId = null;
    patchModal(); patchSellView(); patchCollStrip();
  }
}

// Cancel one of your own offers (gasless: sign the cancel payload).
async function handleCancelOffer(offerId) {
  if (acceptBusyId) return;
  acceptBusyId = offerId; patchCollStrip();
  try {
    const prepRes = await fetch('/api/market/creatures/cancel/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderIds: [offerId], accountAddress: account }),
    });
    const prep = await prepRes.json().catch(() => ({}));
    if (!prepRes.ok) throw Object.assign(new Error('prepare'), { friendly: offerServerError(prep.error) });
    const signature = await signTypedData(prep.typedData);
    const subRes = await fetch('/api/market/creatures/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderIds: [offerId], accountAddress: account, signature }),
    });
    if (!subRes.ok) throw Object.assign(new Error('submit'), { friendly: offerServerError((await subRes.json().catch(() => ({}))).error) });
    myOffers = (myOffers || []).filter(o => o.offerId !== offerId);
    loadCollOffers();
  } catch (err) {
    console.error('Cancel offer failed:', err);
    pendingFlash = err.friendly || friendlyError(err);
  } finally {
    acceptBusyId = null;
    if (pendingFlash) render(); else patchCollStrip();
  }
}

function modalHtml() {
  return `
    <div id="trade-modal" class="trade-modal" ${modalToken ? '' : 'hidden'} role="dialog" aria-modal="true" aria-label="${esc(t('trade.modal.aria'))}">
      <div class="trade-modal-backdrop" data-act="close"></div>
      <div class="trade-modal-card">${modalToken ? modalCardHtml() : ''}</div>
    </div>`;
}
function patchModal() {
  const m = root()?.querySelector('#trade-modal');
  if (!m) return;
  m.hidden = !modalToken;
  document.body.classList.toggle('trade-modal-open', !!modalToken);
  m.querySelector('.trade-modal-card').innerHTML = modalToken ? modalCardHtml() : '';
  // Focus the dialog on open only — status repaints during a buy must not steal focus.
  if (modalToken && !m.contains(document.activeElement)) m.querySelector('.trade-modal-close')?.focus();
}

// --- Wallet bar + actions ---
function flashBanner() {
  if (!pendingFlash) return '';
  const m = pendingFlash; pendingFlash = null;
  return `<div class="apply-alert" role="alert"><span aria-hidden="true">⚠</span><span>${esc(m)}</span></div>`;
}

function walletBarHtml() {
  if (!eth()) {
    return `<div class="trade-bar">
      <span class="trade-bar-msg">${esc(t('trade.bar.install'))}</span>
      <a class="trade-mm-btn is-sm" href="https://metamask.io/download/" target="_blank" rel="noopener">
        <img class="trade-mm-logo" src="${METAMASK_IMG}" alt="" /><span>${esc(t('trade.install.btn'))}</span></a>
    </div>`;
  }
  if (!account) {
    return `<div class="trade-bar">
      <span class="trade-bar-msg">${esc(t('trade.bar.connectPrompt'))}</span>
      <button class="trade-mm-btn is-sm" data-act="connect" type="button" ${busy ? 'disabled' : ''}>
        <img class="trade-mm-logo" src="${METAMASK_IMG}" alt="" /><span>${esc(busy ? t('trade.connecting') : t('trade.connect.btn'))}</span></button>
    </div>`;
  }
  const net = onZk()
    ? `<span class="trade-net is-ok">${esc(t('trade.net.ok'))}</span>`
    : `<span class="trade-net is-bad">${esc(t('trade.net.bad'))}</span>`;
  // Live on-chain balances straight from the RPC — the user's ground truth when a
  // wallet UI mis-reports (e.g. MetaMask's phantom "insufficient IMX" on custom nets).
  const bal = onZk()
    ? `<span class="trade-bar-bal">${esc(t('trade.balance.label'))}: <b id="trade-bal">—</b></span>
       <span class="trade-bar-bal">ETH: <b id="trade-bal-eth">—</b></span>
       <span class="trade-bar-bal">IMX: <b id="trade-bal-imx">—</b></span>`
    : '';
  return `<div class="trade-bar is-connected">
    <img class="trade-mm-dot" src="${METAMASK_IMG}" alt="" />
    <code class="trade-addr" title="${esc(account)}">${esc(shortWallet(account))}</code>
    ${net}${bal}
    <button class="apply-logout" data-act="disconnect" type="button">${esc(t('trade.disconnect'))}</button>
  </div>`;
}

function browseHtml() {
  return `<section class="trade-browse">
    <div class="trade-browse-head">
      <div>
        <h3 class="trade-browse-h">${esc(t('trade.browse.h'))}</h3>
        <p class="trade-browse-sub">${esc(t('trade.browse.sub'))}</p>
      </div>
      <div class="trade-browse-actions">
        <select class="seg-select trade-currency" id="trade-currency" aria-label="${esc(t('trade.currency.aria'))}">
          ${CURRENCIES.map(c => `<option value="${c}" ${currency === c ? 'selected' : ''}>${c.toUpperCase()}</option>`).join('')}
        </select>
        <button class="apply-btn-ghost trade-refresh" data-act="refresh" type="button">${esc(t('trade.refresh'))}</button>
      </div>
    </div>
    ${collStripHtml()}
    <div class="trade-grid" id="trade-grid">${gridInnerHtml()}</div>
    <div class="trade-loadmore" id="trade-loadmore">${loadMoreHtml()}</div>
  </section>`;
}

// --- Seller hub (my listings + sell + transfer) ---

async function loadSellerData() {
  if (!account || !onZk() || sellerLoading) return;
  sellerLoading = true;
  try {
    const [o, m] = await Promise.all([
      fetch(`/api/market/creatures/owned/${account}`).then(r => r.ok ? r.json() : { items: [] }),
      fetch(`/api/market/creatures/mine/${account}`).then(r => r.ok ? r.json() : { items: [] }),
    ]);
    owned = o.items || [];
    mine = m.items || [];
  } catch (err) {
    console.error('Seller data failed:', err);
    owned = owned || []; mine = mine || [];
  } finally {
    sellerLoading = false;
    patchSellView();
  }
}

function sellStatusHtml() {
  if (!sellState) return '';
  const STEP_KEY = {
    prepare: 'trade.sell.preparing',
    approve: 'trade.sell.approve',
    approveWait: 'trade.sell.approveWait',
    sign: 'trade.sell.sign',
    create: 'trade.sell.create',
  };
  if (sellState.phase === 'done') {
    return `<div class="trade-status is-ok"><span aria-hidden="true">✓</span><span>${esc(t('trade.sell.done'))}</span></div>`;
  }
  if (sellState.phase === 'error') {
    return `<div class="trade-status is-error"><span aria-hidden="true">⚠</span><span>${esc(sellState.msg)}</span></div>`;
  }
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP_KEY[sellState.phase]))}</span></div>`;
}

function myListingsHtml() {
  if (!mine || !mine.length) return '';
  return `
    <div class="trade-mine" id="trade-mine">
      <h4 class="trade-form-h">${esc(t('trade.mine.h'))}</h4>
      <div class="trade-mine-row">
        ${mine.map(l => `
          <div class="trade-mine-card">
            ${l.image ? `<img src="${esc(l.image)}" alt="" loading="lazy" />` : '<div class="trade-tile-noimg">🐾</div>'}
            <div class="trade-mine-info">
              <span class="trade-mine-name">${esc(l.name)}</span>
              <span class="trade-mine-price">${esc(fmtEthFiat(l.priceEth))}</span>
            </div>
            <button class="trade-mine-cancel" data-act="cancel-listing" data-listing="${esc(l.listingId)}" type="button"
              ${cancelBusy ? 'disabled' : ''}>${esc(cancelBusy === l.listingId ? t('trade.mine.cancelling') : t('trade.mine.cancel'))}</button>
          </div>`).join('')}
      </div>
    </div>`;
}

function sellPickerHtml() {
  if (owned === null) return `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${esc(t('trade.sell.loadingOwned'))}</div>`;
  const listedIds = new Set((mine || []).map(l => String(l.tokenId)));
  const sellable = owned.filter(o => !listedIds.has(String(o.tokenId)));
  if (!sellable.length) return `<p class="trade-form-p">${esc(t('trade.sell.none'))}</p>`;
  return `
    <div class="trade-pick" role="listbox" aria-label="${esc(t('trade.sell.pickAria'))}">
      ${sellable.map(o => `
        <button class="trade-pick-tile ${String(sellSel) === String(o.tokenId) ? 'is-sel' : ''}" type="button"
          role="option" aria-selected="${String(sellSel) === String(o.tokenId)}"
          data-act="sell-pick" data-token="${esc(o.tokenId)}" title="${esc(o.name)}">
          ${o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy" />` : '<div class="trade-tile-noimg">🐾</div>'}
          <span>${esc(o.name.replace('Highrise Creature ', ''))}</span>
        </button>`).join('')}
    </div>`;
}

// Segmented Buy / Sell / Transfer control (reuses the Market panel's .seg pattern).
function tradeTabsHtml() {
  const TABS = [['buy', 'trade.tab.buy'], ['sell', 'trade.tab.sell'], ['transfer', 'trade.tab.transfer']];
  return `<div class="seg trade-tabs" role="tablist" aria-label="${esc(t('trade.tabs.aria'))}">
    ${TABS.map(([id, key]) => `
      <button type="button" role="tab" class="seg-btn ${tradeTab === id ? 'is-active' : ''}"
        aria-selected="${tradeTab === id}" data-act="trade-tab" data-tab="${id}">${esc(t(key))}</button>`).join('')}
  </div>`;
}

// Wallet gate for the Sell / Transfer tabs (Buy browsing needs no wallet).
function walletGateHtml() {
  if (!eth()) {
    return `<div class="apply-state-box">
      <div class="apply-state-ico" aria-hidden="true">🦊</div>
      <p>${esc(t('trade.bar.install'))}</p>
      <a class="trade-mm-btn is-sm" href="https://metamask.io/download/" target="_blank" rel="noopener" style="margin-top:16px">
        <img class="trade-mm-logo" src="${METAMASK_IMG}" alt="" /><span>${esc(t('trade.install.btn'))}</span></a>
    </div>`;
  }
  if (!account) {
    return `<div class="apply-state-box">
      <div class="apply-state-ico" aria-hidden="true">🔐</div>
      <p>${esc(t('trade.bar.connectPrompt'))}</p>
      <button class="trade-mm-btn is-sm" data-act="connect" type="button" ${busy ? 'disabled' : ''} style="margin-top:16px">
        <img class="trade-mm-logo" src="${METAMASK_IMG}" alt="" /><span>${esc(busy ? t('trade.connecting') : t('trade.connect.btn'))}</span></button>
    </div>`;
  }
  return `<div class="apply-state-box">
    <div class="apply-state-ico" aria-hidden="true">🔀</div>
    <h3>${esc(t('trade.net.wrong.h'))}</h3>
    <p>${esc(t('trade.net.wrong.p'))}</p>
    <button class="apply-btn-ghost" data-act="switch" type="button">${esc(t('trade.net.switch'))}</button>
  </div>`;
}

function sellViewHtml() {
  if (!account || !onZk()) return walletGateHtml();
  const sellBusy = sellState && SELL_BUSY_PHASES.has(sellState.phase);
  return `
    ${myListingsHtml()}
    ${instantSellHtml()}
    <form class="trade-form" id="trade-sell-form" novalidate>
      <h4 class="trade-form-h">${esc(t('trade.sell.h'))} ${tipHtml('trade.sell.p')}</h4>
      ${sellPickerHtml()}
      <label class="trade-field"><span>${esc(t('trade.sell.price'))}</span>
        <input id="trade-sell-price" type="text" inputmode="decimal" placeholder="${esc(t('trade.sell.price.ph'))}" autocomplete="off" /></label>
      <button class="trade-send" id="trade-sell-submit" type="submit" ${sellBusy || !sellSel ? 'disabled' : ''}>
        ${esc(t('trade.sell.btn'))} <span aria-hidden="true">→</span></button>
      <div id="trade-sell-status" role="status" aria-live="polite">${sellStatusHtml()}</div>
    </form>`;
}

function transferViewHtml() {
  if (!account || !onZk()) return walletGateHtml();
  return `
    <form class="trade-form" id="trade-transfer-form" novalidate>
      <h4 class="trade-form-h">${esc(t('trade.transfer.h'))} ${tipHtml('trade.transfer.p')}</h4>
      <label class="trade-field"><span>${esc(t('trade.field.tokenId'))}</span>
        <input id="trade-token-id" type="text" inputmode="numeric" placeholder="${esc(t('trade.field.tokenId.ph'))}" autocomplete="off" /></label>
      <label class="trade-field"><span>${esc(t('trade.field.recipient'))}</span>
        <input id="trade-to" type="text" placeholder="0x…" autocomplete="off" spellcheck="false" /></label>
      <button class="trade-send" id="trade-send" type="submit">${esc(t('trade.transfer.btn'))} <span aria-hidden="true">→</span></button>
      <div class="trade-status" id="trade-status" role="status" aria-live="polite"></div>
    </form>`;
}

function viewHtml() {
  if (tradeTab === 'sell')     return `<section class="trade-actions" id="trade-view">${sellViewHtml()}</section>`;
  if (tradeTab === 'transfer') return `<section class="trade-actions" id="trade-view">${transferViewHtml()}</section>`;
  return `<div id="trade-view">${browseHtml()}</div>`;
}

// Re-render the active Sell view in place, preserving the typed price — a picker
// click or a cancelled listing must never wipe what the user entered.
function patchSellView() {
  const view = root()?.querySelector('#trade-view');
  if (!view || tradeTab !== 'sell') return;
  const price = view.querySelector('#trade-sell-price')?.value;
  view.innerHTML = sellViewHtml();
  const input = view.querySelector('#trade-sell-price');
  if (input && price) input.value = price;
}
function patchSellStatus() {
  const st = root()?.querySelector('#trade-sell-status');
  if (st) st.innerHTML = sellStatusHtml();
  const btn = root()?.querySelector('#trade-sell-submit');
  if (btn) btn.disabled = !!(sellState && SELL_BUSY_PHASES.has(sellState.phase)) || !sellSel;
}
function setSell(phase, extra) { sellState = { phase, ...extra }; patchSellStatus(); }

// Sign a server-built EIP-712 payload with the connected wallet.
function signTypedData(typedData) {
  return eth().request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typedData)] });
}

function sellServerError(code) {
  const KEY = {
    insufficient: 'trade.err.notOwner', bad_price: 'trade.err.badPrice',
    bad_token: 'trade.err.badId', rate_limited: 'trade.err.rate',
  };
  return t(KEY[code] || 'trade.err.unavailable');
}

async function handleSell(form) {
  if (sellState && SELL_BUSY_PHASES.has(sellState.phase)) return;
  const priceRaw = (form.querySelector('#trade-sell-price').value || '').trim().replace(',', '.');
  if (!sellSel) return setSell('error', { msg: t('trade.err.noSel') });
  if (!/^\d{1,6}(\.\d{1,18})?$/.test(priceRaw) || Number(priceRaw) <= 0) {
    return setSell('error', { msg: t('trade.err.badPrice') });
  }

  try {
    setSell('prepare');
    const res = await fetch('/api/market/creatures/sell/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ makerAddress: account, tokenId: sellSel, priceEth: priceRaw }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setSell('error', { msg: sellServerError(data.error) });

    let signature = null;
    for (const action of (data.actions || [])) {
      if (action.type === 'TRANSACTION') { // one-time collection approval
        setSell('approve');
        const hash = await eth().request({
          method: 'eth_sendTransaction',
          params: [{ from: account, to: action.to, data: action.data, value: action.value && action.value !== '0x0' ? action.value : undefined }],
        });
        setSell('approveWait', { hash });
        const receipt = await waitForReceipt(hash);
        if (!receipt || receipt.status !== '0x1') return setSell('error', { msg: t('trade.err.txFailed') });
      } else if (action.type === 'SIGNABLE') {
        setSell('sign');
        signature = await signTypedData(action.typedData);
      }
    }
    if (!signature) return setSell('error', { msg: t('trade.err.unavailable') });

    setSell('create');
    const createRes = await fetch('/api/market/creatures/sell/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderComponents: data.orderComponents, orderHash: data.orderHash, signature }),
    });
    const created = await createRes.json().catch(() => ({}));
    if (!createRes.ok) return setSell('error', { msg: sellServerError(created.error) });

    setSell('done');
    sellSel = null;
    form.reset();
    loadSellerData();      // refresh "my listings" + picker
    loadListings(true);    // the new listing appears in browse
  } catch (err) {
    console.error('Sell failed:', err);
    setSell('error', { msg: friendlyError(err) });
  }
}

async function handleCancelListing(listingId) {
  if (cancelBusy) return;
  cancelBusy = listingId; patchSellView();
  try {
    const prepRes = await fetch('/api/market/creatures/cancel/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderIds: [listingId], accountAddress: account }),
    });
    const prep = await prepRes.json().catch(() => ({}));
    if (!prepRes.ok) throw Object.assign(new Error('prepare'), { friendly: sellServerError(prep.error) });

    const signature = await signTypedData(prep.typedData);

    const subRes = await fetch('/api/market/creatures/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ orderIds: [listingId], accountAddress: account, signature }),
    });
    const sub = await subRes.json().catch(() => ({}));
    if (!subRes.ok) throw Object.assign(new Error('submit'), { friendly: sellServerError(sub.error) });

    mine = (mine || []).filter(l => l.listingId !== listingId);
    loadListings(true); // drop it from browse too
  } catch (err) {
    console.error('Cancel failed:', err);
    pendingFlash = err.friendly || friendlyError(err);
  } finally {
    cancelBusy = null;
    if (pendingFlash) render(); else patchSellView();
  }
}

async function handleTransferSubmit(form) {
  const status = form.querySelector('#trade-status');
  const btn    = form.querySelector('#trade-send');
  const fail = m => { status.className = 'trade-status is-error'; status.innerHTML = `<span aria-hidden="true">⚠</span><span>${esc(m)}</span>`; };
  const info = m => { status.className = 'trade-status is-info';  status.innerHTML = `<span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(m)}</span>`; };
  const done = (msg, hash) => {
    status.className = 'trade-status is-ok';
    status.innerHTML = `<span aria-hidden="true">✓</span><span>${esc(msg)} <a href="${esc(EXPLORER)}/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(t('trade.status.view'))}</a></span>`;
  };

  if (btn.disabled) return;
  const tokenId = (form.querySelector('#trade-token-id').value || '').trim();
  const to      = (form.querySelector('#trade-to').value || '').trim().toLowerCase();
  if (!/^\d+$/.test(tokenId)) return fail(t('trade.err.badId'));
  if (!IS_ADDR.test(to))      return fail(t('trade.err.badAddr'));
  if (to === account)         return fail(t('trade.err.self'));
  if (to === ZERO)            return fail(t('trade.err.zero'));

  btn.disabled = true;
  try {
    info(t('trade.status.checking'));
    const owner = await ownerOf(tokenId);
    if (owner === null)    { fail(t('trade.err.noToken'));  btn.disabled = false; return; }
    if (owner !== account) { fail(t('trade.err.notOwner')); btn.disabled = false; return; }
    info(t('trade.status.confirm'));
    const hash = await sendTransfer(tokenId, to);
    done(t('trade.status.sent'), hash);
    form.reset();
    refreshBalance();
  } catch (err) {
    console.error('Transfer failed:', err);
    fail(friendlyError(err));
  } finally { btn.disabled = false; }
}

async function refreshBalance() {
  const el = root()?.querySelector('#trade-bal');
  if (!el) return;
  const [bal, zkEth, imx] = await Promise.all([readBalance(), readErc20(IMX_ETH_TOKEN, account), readNative(account)]);
  el.textContent = bal == null ? '—' : String(bal);
  const ethEl = root()?.querySelector('#trade-bal-eth');
  if (ethEl) ethEl.textContent = fmtWeiEth(zkEth);
  const imxEl = root()?.querySelector('#trade-bal-imx');
  if (imxEl) imxEl.textContent = fmtWeiEth(imx);
}

// --- Render + events ---
function render() {
  const el = root();
  if (!el) return;
  el.setAttribute('aria-busy', 'false');
  el.innerHTML = `${flashBanner()}${walletBarHtml()}<div id="trade-mmwarn-slot">${walletNoticeHtml()}</div><div id="trade-bridgebar-slot">${bridgeBannerHtml()}</div>${tradeTabsHtml()}${viewHtml()}${modalHtml()}`;
  ensureDelegation();
  if (account && onZk()) {
    refreshBalance();
    if (owned === null && !sellerLoading) loadSellerData();
    if (myOffers === null) loadMyOffers();
  }
}

function onClick(e) {
  const target = e.target.closest('[data-act]');
  if (!target) return;
  switch (target.dataset.act) {
    case 'open':       return openModal(target.dataset.token);
    case 'close':      return closeModal();
    case 'buy':        return handleBuy(target.dataset.listing);
    case 'trade-tab':
      if (tradeTab === target.dataset.tab) return;
      tradeTab = target.dataset.tab;
      render();
      if (tradeTab === 'sell' && account && onZk() && owned === null && !sellerLoading) loadSellerData();
      return;
    case 'sell-pick':
      sellSel = String(sellSel) === String(target.dataset.token) ? null : target.dataset.token;
      sellState = null;
      return patchSellView();
    case 'cancel-listing': return handleCancelListing(target.dataset.listing);
    case 'accept-offer':   return handleAcceptOffer(target.dataset.offer);
    case 'instant-sell':   return sellSel != null && handleAcceptOffer(target.dataset.offer, sellSel);
    case 'cancel-offer':   return handleCancelOffer(target.dataset.offer);
    case 'bridge-now':     return handleBridgeNow();
    case 'bridge-dismiss': return dismissBridge();
    case 'mmwarn-dismiss':
      try { localStorage.setItem('hcc-mmwarn-' + mmBuggyVersion, '1'); } catch { /* fine */ }
      return patchWalletNotice();
    case 'connect':    return connect();
    case 'disconnect': account = null; resetSellerState(); return render();
    case 'switch':     return switchNetwork(target);
    case 'loadmore':   return loadListings(false);
    case 'retry':      return loadListings(true);
    case 'refresh':    return loadListings(true);
  }
}
function onSubmit(e) {
  if (e.target?.id === 'trade-transfer-form') { e.preventDefault(); handleTransferSubmit(e.target); }
  if (e.target?.id === 'trade-sell-form')     { e.preventDefault(); handleSell(e.target); }
  if (e.target?.id === 'trade-offer-form') {
    e.preventDefault();
    handleMakeOffer(e.target.dataset.token, e.target.querySelector('#trade-offer-price')?.value, 'modal');
  }
  if (e.target?.id === 'trade-coll-offer-form') {
    e.preventDefault();
    handleMakeOffer(null, e.target.querySelector('#trade-coll-offer-price')?.value, 'browse');
  }
}
function onChange(e) {
  if (e.target?.id !== 'trade-currency') return;
  currency = e.target.value;
  try { localStorage.setItem('hcc-trade-cur', currency); } catch { /* private mode — fine */ }
  patchGrid();
  if (modalToken) patchModal();
}
function resetSellerState() {
  owned = null; mine = null; sellSel = null; sellState = null; cancelBusy = null;
  myOffers = null; offerState = null; offerCtx = null; acceptState = null; acceptBusyId = null;
}
function ensureDelegation() {
  const el = root();
  if (!el || el._hccDelegated) return;
  el._hccDelegated = true;
  el.addEventListener('click', onClick);
  el.addEventListener('submit', onSubmit);
  el.addEventListener('change', onChange);
}

let escWired = false;
function wireEsc() {
  if (escWired) return; escWired = true;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalToken) closeModal(); });
}

function wireProviderEvents() {
  const p = eth();
  if (!p || p._hccTradeWired) return;
  p._hccTradeWired = true;
  p.on?.('accountsChanged', accs => { account = (accs[0] || '').toLowerCase() || null; resetSellerState(); render(); });
  p.on?.('chainChanged',   cid  => { chainId = cid; resetSellerState(); render(); });
}

export async function loadMarketplace() {
  loadedOnce = true;
  try { const c = localStorage.getItem('hcc-trade-cur'); if (c && CURRENCIES.includes(c)) currency = c; } catch { /* fine */ }
  wireEsc();
  wireTips();
  wireProviderEvents();
  detectWalletBug();
  if (eth()) {
    try {
      const accs = await eth().request({ method: 'eth_accounts' });
      account = (accs[0] || '').toLowerCase() || null;
      if (account) chainId = await eth().request({ method: 'eth_chainId' });
    } catch { /* leave disconnected */ }
  }
  // Resume a bridge that was in flight when the page was last closed — the user can
  // navigate away or reload without ever losing sight of their money.
  const saved = loadSavedBridge();
  if (saved) {
    bridgeJob = saved;
    if (saved.phase === 'waiting' || saved.phase === 'slow') {
      bridgeJob.phase = 'waiting';
      trackBridge();
    }
  }
  render();
  loadListings(true);
  loadCollOffers();
}

// Re-render from in-memory state on language switch (no refetch).
export function rerenderMarketplace() {
  if (loadedOnce && root()) render();
}
