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

// Modal state
let modalToken = null;
let modalMeta = null;
let modalLoading = false;

// Buy state — survives modal re-renders so a language switch or balance refresh can't
// wipe an in-flight purchase status. {phase, msg?, hash?}; null = idle.
let buyState = null;
const BUY_BUSY_PHASES = new Set(['prepare', 'approve', 'approveWait', 'fulfill', 'fulfillWait']);

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
function fmtUsd(eth) {
  if (ethUsd == null) return '';
  return `≈ $${Math.round(Number(eth) * ethUsd).toLocaleString()}`;
}

// Map a wallet/provider error to a friendly, actionable message — never a raw revert.
function friendlyError(err) {
  const code = err?.code;
  const msg  = (err?.message || '').toLowerCase();
  if (code === 4001 || /user rejected|user denied|rejected the request/.test(msg)) return t('trade.err.rejected');
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
  const img = it.image
    ? `<img class="trade-tile-img" src="${esc(it.image)}" alt="" loading="lazy" />`
    : `<div class="trade-tile-img trade-tile-noimg" aria-hidden="true">🐾</div>`;
  return `
    <button class="trade-tile" type="button" data-act="open" data-token="${esc(it.tokenId)}">
      <div class="trade-tile-media">${img}${rarityChip(it.rarity)}</div>
      <div class="trade-tile-body">
        <span class="trade-tile-name">${esc(it.name)}</span>
        <span class="trade-tile-price">${esc(fmtEth(it.priceEth))}</span>
        ${ethUsd ? `<span class="trade-tile-usd">${esc(fmtUsd(it.priceEth))}</span>` : ''}
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
  modalToken = tokenId; modalMeta = null; modalLoading = true; buyState = null; patchModal();
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

  const price = it.priceEth != null
    ? `<div class="trade-modal-price">
         <span class="trade-modal-price-eth">${esc(fmtEth(it.priceEth))}</span>
         ${ethUsd ? `<span class="trade-modal-price-usd">${esc(fmtUsd(it.priceEth))}</span>` : ''}
         <span class="trade-modal-fees">${esc(t('trade.price.total'))} ${esc(fmtEth(it.totalEth ?? it.priceEth))}</span>
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
  return `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${esc(t(STEP_KEY[buyState.phase]))}</span></div>`;
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
      ${esc(t('trade.buy.btn'))} · ${esc(fmtEth(it.priceEth))}</button>`;
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
    if (!res.ok) { setBuy('error', { msg: buyServerError(data.error) }); return; }

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
  const bal = onZk() ? `<span class="trade-bar-bal">${esc(t('trade.balance.label'))}: <b id="trade-bal">—</b></span>` : '';
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
      <button class="apply-btn-ghost trade-refresh" data-act="refresh" type="button">${esc(t('trade.refresh'))}</button>
    </div>
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
    patchHub();
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
              <span class="trade-mine-price">${esc(fmtEth(l.priceEth))}</span>
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

function hubHtml() {
  if (!account) return '';
  if (!onZk()) {
    return `<section class="trade-actions" id="trade-hub">
      <div class="apply-state-box">
        <div class="apply-state-ico" aria-hidden="true">🔀</div>
        <h3>${esc(t('trade.net.wrong.h'))}</h3>
        <p>${esc(t('trade.net.wrong.p'))}</p>
        <button class="apply-btn-ghost" data-act="switch" type="button">${esc(t('trade.net.switch'))}</button>
      </div>
    </section>`;
  }
  const sellBusy = sellState && SELL_BUSY_PHASES.has(sellState.phase);
  return `<section class="trade-actions trade-hub" id="trade-hub">
    ${myListingsHtml()}
    <div class="trade-hub-grid">
      <form class="trade-form" id="trade-sell-form" novalidate>
        <h4 class="trade-form-h">${esc(t('trade.sell.h'))}</h4>
        <p class="trade-form-p">${esc(t('trade.sell.p'))}</p>
        ${sellPickerHtml()}
        <label class="trade-field"><span>${esc(t('trade.sell.price'))}</span>
          <input id="trade-sell-price" type="text" inputmode="decimal" placeholder="${esc(t('trade.sell.price.ph'))}" autocomplete="off" /></label>
        <button class="trade-send" id="trade-sell-submit" type="submit" ${sellBusy || !sellSel ? 'disabled' : ''}>
          ${esc(t('trade.sell.btn'))} <span aria-hidden="true">→</span></button>
        <div id="trade-sell-status" role="status" aria-live="polite">${sellStatusHtml()}</div>
      </form>
      <form class="trade-form" id="trade-transfer-form" novalidate>
        <h4 class="trade-form-h">${esc(t('trade.transfer.h'))}</h4>
        <p class="trade-form-p">${esc(t('trade.transfer.p'))}</p>
        <label class="trade-field"><span>${esc(t('trade.field.tokenId'))}</span>
          <input id="trade-token-id" type="text" inputmode="numeric" placeholder="${esc(t('trade.field.tokenId.ph'))}" autocomplete="off" /></label>
        <label class="trade-field"><span>${esc(t('trade.field.recipient'))}</span>
          <input id="trade-to" type="text" placeholder="0x…" autocomplete="off" spellcheck="false" /></label>
        <button class="trade-send" id="trade-send" type="submit">${esc(t('trade.transfer.btn'))} <span aria-hidden="true">→</span></button>
        <div class="trade-status" id="trade-status" role="status" aria-live="polite"></div>
      </form>
    </div>
  </section>`;
}

function patchHub() {
  const hub = root()?.querySelector('#trade-hub');
  if (hub) hub.outerHTML = hubHtml();
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
  cancelBusy = listingId; patchHub();
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
    if (pendingFlash) render(); else patchHub();
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
  const bal = await readBalance();
  el.textContent = bal == null ? '—' : String(bal);
}

// --- Render + events ---
function render() {
  const el = root();
  if (!el) return;
  el.setAttribute('aria-busy', 'false');
  el.innerHTML = `${flashBanner()}${walletBarHtml()}${browseHtml()}${hubHtml()}${modalHtml()}`;
  ensureDelegation();
  if (account && onZk()) {
    refreshBalance();
    if (owned === null && !sellerLoading) loadSellerData();
  }
}

function onClick(e) {
  const target = e.target.closest('[data-act]');
  if (!target) return;
  switch (target.dataset.act) {
    case 'open':       return openModal(target.dataset.token);
    case 'close':      return closeModal();
    case 'buy':        return handleBuy(target.dataset.listing);
    case 'sell-pick':
      sellSel = String(sellSel) === String(target.dataset.token) ? null : target.dataset.token;
      sellState = null;
      return patchHub();
    case 'cancel-listing': return handleCancelListing(target.dataset.listing);
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
}
function resetSellerState() {
  owned = null; mine = null; sellSel = null; sellState = null; cancelBusy = null;
}
function ensureDelegation() {
  const el = root();
  if (!el || el._hccDelegated) return;
  el._hccDelegated = true;
  el.addEventListener('click', onClick);
  el.addEventListener('submit', onSubmit);
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
  wireEsc();
  wireProviderEvents();
  if (eth()) {
    try {
      const accs = await eth().request({ method: 'eth_accounts' });
      account = (accs[0] || '').toLowerCase() || null;
      if (account) chainId = await eth().request({ method: 'eth_chainId' });
    } catch { /* leave disconnected */ }
  }
  render();
  loadListings(true);
}

// Re-render from in-memory state on language switch (no refetch).
export function rerenderMarketplace() {
  if (loadedOnce && root()) render();
}
