// Guide demos — interactive, animated replays of the live marketplace inside the
// Guides › Marketplace walkthrough. Instead of videos/screenshots (which rot and speak
// one language), each demo mirrors the real .trade-* markup with fixture data and a
// scripted ghost cursor. No network, no wallet — the DEMO badge, fake prices, and a
// stand-in wallet card keep it honest.
//
// Interaction model (owner feedback 2026-07-04): the demo NEVER advances on its own.
// Entering a step shows a title card over the blurred stage, plays that step's
// animation once, and settles; the user moves with the numbered step pills, Back /
// Next, the edge chevrons, or a horizontal swipe. Steps show one at a time in the
// rail under the stage. Reduced motion skips animations entirely — each step jumps
// straight to its settled scene, so the pills become a pure stepper.
//
// Mount point: <div class="gdemo" data-gdemo="trading-creatures"></div>
// Wiring: initGuideDemos() once at boot, rerenderGuideDemos() after language switches.
import { t } from './i18n.js';
// The same icon set the real marketplace draws with. These replays copy its markup on
// purpose, so they have to copy its icons too or the guide stops matching the screen.
import { ico } from './market/core/icons.js';

const motionOK = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const rep = (key, subs) =>
  Object.entries(subs).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key));

// --- Fixture data & art -------------------------------------------------------------
// Deliberately fake but plausible: recognizable numbers, brand-palette art. Inline SVG
// blobs (not CDN images) so a guide demo can never show a broken image.

function creatureSvg(color, seed = 0) {
  const earL = 24 - (seed % 3) * 2;
  const earR = 56 + (seed % 4) * 2;
  return `<svg class="gdemo-art" viewBox="0 0 80 72" aria-hidden="true" style="color:${color}">
    <ellipse cx="${earL}" cy="20" rx="7" ry="11" fill="currentColor" opacity=".85" transform="rotate(-14 ${earL} 20)"/>
    <ellipse cx="${earR}" cy="20" rx="7" ry="11" fill="currentColor" opacity=".85" transform="rotate(14 ${earR} 20)"/>
    <ellipse cx="40" cy="42" rx="27" ry="23" fill="currentColor"/>
    <ellipse cx="40" cy="49" rx="18" ry="12" fill="rgba(255,255,255,.14)"/>
    <circle cx="31" cy="38" r="5.4" fill="#0F1014"/><circle cx="49" cy="38" r="5.4" fill="#0F1014"/>
    <circle cx="32.8" cy="36.2" r="1.9" fill="#fff"/><circle cx="50.8" cy="36.2" r="1.9" fill="#fff"/>
    <path d="M35 50 Q40 54 45 50" stroke="#0F1014" stroke-width="2.4" fill="none" stroke-linecap="round"/>
  </svg>`;
}

// Squat slime blob — headpiece varies by seed (horn / antenna / none), like the real
// Slime trait system.
function slimeSvg(color, seed = 0) {
  const head = seed % 3 === 0
    ? `<path d="M40 20 L35 30 L45 30 Z" fill="currentColor" opacity=".85"/>`
    : seed % 3 === 1
      ? `<path d="M40 30 Q42 22 38 16" stroke="currentColor" stroke-width="2.4" fill="none" opacity=".85"/><circle cx="38" cy="14" r="3" fill="currentColor" opacity=".85"/>`
      : '';
  return `<svg class="gdemo-art" viewBox="0 0 80 72" aria-hidden="true" style="color:${color}">
    ${head}
    <ellipse cx="40" cy="48" rx="27" ry="19" fill="currentColor"/>
    <ellipse cx="40" cy="54" rx="19" ry="10" fill="rgba(255,255,255,.14)"/>
    <circle cx="32" cy="45" r="4.8" fill="#0F1014"/><circle cx="48" cy="45" r="4.8" fill="#0F1014"/>
    <circle cx="33.5" cy="43.5" r="1.7" fill="#fff"/><circle cx="49.5" cy="43.5" r="1.7" fill="#fff"/>
    <path d="M36 55 Q40 58 44 55" stroke="#0F1014" stroke-width="2.2" fill="none" stroke-linecap="round"/>
  </svg>`;
}

// Real collection artwork and identities (fetched 2026-07-05); prices stay deliberately
// fictional — the DEMO badge owns that. Colors seed the SVG-blob fallback if an image
// ever fails to load.
const CR_IMG = n => `https://cdn-production.joinhighrise.com/hccimgs/${n}`;
const FIX_CREATURES = [
  { name: 'Creature #9453', img: CR_IMG('9453.png'), c: '#51FFA5', eth: '0.058 ETH', fiat: '≈ $143',   r: 'Epic',      rank: 29 },
  { name: 'Creature #6110', img: CR_IMG('6110.png'), c: '#8561FF', eth: '0.061 ETH', fiat: '≈ $150',   r: 'Epic',      rank: 721 },
  { name: 'Creature #3503', img: CR_IMG('3503.png'), c: '#FFF95F', eth: '0.064 ETH', fiat: '≈ $158',   r: 'Epic',      rank: 722 },
  { name: 'Creature #1702', img: CR_IMG('1702.png'), c: '#0DA6FC', eth: '0.066 ETH', fiat: '≈ $163',   r: 'Epic',      rank: 723 },
  { name: 'Creature #1093', img: CR_IMG('1093.gif'), c: '#FF9900', eth: '0.42 ETH',  fiat: '≈ $1,034', r: 'Legendary', rank: 25 },
  { name: 'Creature #1501', img: CR_IMG('1501.gif'), c: '#FF5B95', eth: '0.55 ETH',  fiat: '≈ $1,354', r: 'Legendary', rank: 26 },
];

// Real parcels + their attached Slimes, art rendered by our own /land/pet endpoint.
const PET_IMG = (x, y) => `/api/market/land/pet/${x}/${y}`;
const FIX_SLIMES = [
  { nick: 'Fleby',    coords: '(200, 135)', img: PET_IMG(200, 135), c: '#51FFA5', eth: '0.185 ETH', fiat: '≈ $455', rank: 25 },
  { nick: 'Wootch',   coords: '(167, 164)', img: PET_IMG(167, 164), c: '#8561FF', eth: '0.190 ETH', fiat: '≈ $468', rank: 28 },
  { nick: 'Hawoo',    coords: '(176, 170)', img: PET_IMG(176, 170), c: '#FFF95F', eth: '0.210 ETH', fiat: '≈ $517', rank: 30 },
  { nick: 'Twiwoff',  coords: '(168, 145)', img: PET_IMG(168, 145), c: '#0DA6FC', eth: '0.240 ETH', fiat: '≈ $591', rank: 601 },
  { nick: 'Flidoff',  coords: '(170, 148)', img: PET_IMG(170, 148), c: '#FF9900', eth: '0.280 ETH', fiat: '≈ $689', rank: 602 },
  { nick: 'Cocoting', coords: '(196, 130)', img: PET_IMG(196, 130), c: '#FF5B95', eth: '0.350 ETH', fiat: '≈ $862', rank: 604 },
];

// Real artwork with an inline-SVG blob fallback — a broken image can never appear in a
// guide. The delegated error handler in createDemo swaps failures for the blob.
function artImg(f, kind, seed, cls) {
  return `<img class="${cls}" src="${f.img}" alt="" loading="lazy" data-gd-fb="${kind}|${f.c}|${seed}" />`;
}

const DEMO_ADDR = '0xA3f4…C9F2';
// A well-formed 42-char pair for the transfer demo: same address, but the "pasted"
// one carries a broken EIP-55 case so the checksum check visibly saves the day.
const ADDR_BAD  = '0x8bA1f109551bD432803012645Ac136ddd64dba72';
const ADDR_GOOD = '0x8bA1f109551bD432803012645Ac136ddd64DBA72';

// --- Shared builders (mirror js/marketplace.js render shapes) ------------------------

function barOffHtml() {
  return `<div class="trade-bar gdemo-bar">
    <span class="trade-bar-msg">${t('trade.bar.connectPrompt')}</span>
    <button class="trade-mm-btn is-sm" data-gd="connect" type="button" tabindex="-1">
      <img class="trade-mm-logo" src="/img/brands/metamask.svg" alt="" /><span>${t('trade.connect.btn')}</span></button>
  </div>`;
}

// Connected wallet bar; `coll` picks the network chip + balance set. Pass '—' values
// for the just-connected, balances-still-loading state. opts.cashout adds the live
// bar's 💸 Cash out pill (the cash-out scenarios click it).
function barOnHtml(coll, { eth = '—', imx = '—', count = '—' } = {}, opts = {}) {
  const land = coll === 'land';
  const bals = land
    ? `<span class="trade-bar-bal">${ico('map', 13)} <b>${count}</b></span>
       <span class="trade-bar-bal">ETH <b data-gd="bal-eth">${eth}</b></span>`
    : `<span class="trade-bar-bal">${ico('paw', 13)} <b>${count}</b></span>
       <span class="trade-bar-bal">ETH <b data-gd="bal-eth">${eth}</b></span>
       <span class="trade-bar-bal">IMX <b>${imx}</b></span>`;
  const cash = opts.cashout
    ? `<button class="trade-cashout-pill" data-gd="cashpill" type="button" tabindex="-1"><span aria-hidden="true">${ico('fundsOut', 15)}</span> ${t('trade.cashout.barBtn')}</button>`
    : '';
  return `<div class="trade-bar is-connected gdemo-bar">
    <img class="trade-mm-dot" src="/img/brands/metamask.svg" alt="" />
    <code class="trade-addr">${DEMO_ADDR}</code>
    <span class="trade-net is-ok"><span class="trade-net-full">${t(land ? 'trade.net.eth' : 'trade.net.ok')}</span></span>
    <span class="trade-bar-bals">${bals}</span>
    ${cash}
  </div>`;
}

// Stand-in wallet card — we can't render the real extension, but the fox mark says
// which wallet this stands for. Non-wallet variants (card checkout) pass icon: 'dot'.
function walletMockHtml({ title, rows, confirm, icon = 'fox' } = {}) {
  const mark = icon === 'fox'
    ? `<img class="gdemo-wallet-fox" src="/img/brands/metamask.svg" alt="" />`
    : `<i aria-hidden="true"></i>`;
  return `<div class="gdemo-wallet">
    <div class="gdemo-wallet-head">${mark}<span data-gd="wtitle">${title || t('gm.demo.w.title')}</span></div>
    <div data-gd="wrows">${walletRowsHtml(rows || [])}</div>
    <div class="gdemo-wallet-btns">
      <button type="button" tabindex="-1">${t('gm.demo.w.reject')}</button>
      <button type="button" class="is-confirm" data-gd="wconfirm" tabindex="-1"><span data-gd="wok">${confirm || t('gm.demo.w.confirm')}</span></button>
    </div>
  </div>`;
}
function walletRowsHtml(rows) {
  return rows.map(([l, v]) => `<div class="gdemo-wallet-row"><span>${l}</span><b>${v}</b></div>`).join('');
}

function successHtml({ art, h, p, rcpt = true }) {
  return `<div class="gdemo-success">
    <span class="gdemo-spark" style="--sx:28%;--sy:30%;--sc:var(--hr-primary)"></span>
    <span class="gdemo-spark" style="--sx:70%;--sy:24%;--sc:var(--hr-banana);--sd:.35s"></span>
    <span class="gdemo-spark" style="--sx:22%;--sy:66%;--sc:var(--hr-secondary);--sd:.7s"></span>
    <span class="gdemo-spark" style="--sx:76%;--sy:62%;--sc:var(--hr-alert);--sd:1.05s"></span>
    <div class="gdemo-success-art">${art}</div>
    <h4>${h}</h4>
    <p>${p}</p>
    ${rcpt ? `<span class="gdemo-rcpt">${t('trade.status.view')} ${ico('external', 12)}</span>` : ''}
  </div>`;
}

// Status rows reuse the live .trade-status shapes + live trade.* copy, so the demo
// always says exactly what the real marketplace says.
const row = {
  ok:   txt => `<div class="trade-status is-ok"><span aria-hidden="true">${ico('check', 17)}</span><span>${txt}</span></div>`,
  info: txt => `<div class="trade-status is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${txt}</span></div>`,
  err:  txt => `<div class="trade-status is-error"><span aria-hidden="true">${ico('alert', 17)}</span><span>${txt}</span></div>`,
};

const spedChip = () => `<span class="gdemo-sped">${t('gm.demo.spedUp')}</span>`;
const pop = html => `<div class="gdemo-pop">${html}</div>`;

// =====================================================================================
// TRADING — shared skeleton for Creatures (zkEVM) and LAND (Ethereum / OpenSea)
// =====================================================================================

function makeTradingSpec(cfg) {
  return {
    title: cfg.title,
    steps: [
      { label: 'gm.demo.beat.browse', cap: cfg.caps[0] },
      { label: 'gm.demo.beat.open',   cap: cfg.caps[1] },
      { label: 'gm.demo.beat.buy',    cap: cfg.caps[2] },
      { label: 'gm.demo.beat.yours',  cap: cfg.caps[3] },
    ],
    stageHtml() {
      return cfg.barHtml() + cfg.filtersHtml()
        + `<div class="trade-grid gdemo-grid">${cfg.tilesHtml()}</div>`
        + cfg.modalHtml() + walletMockHtml({ rows: cfg.walletRows() })
        + successHtml(cfg.success());
    },
    endState(ctx, b) {
      const { stage } = ctx;
      stage.classList.toggle('m-open', b >= 1);
      stage.classList.remove('w-open');
      stage.classList.toggle('s-open', b >= 3);
      stage.querySelector('[data-gd="chip"]')?.classList.toggle('is-on', b >= 0);
      stage.querySelectorAll('.gdemo-tile').forEach(el => el.classList.remove('is-hov', 'is-press'));
      const status = stage.querySelector('[data-gd="status"]');
      if (status) {
        status.innerHTML = b === 2 ? row.ok(t(cfg.fundsKey)) + row.info(t('trade.buy.confirmWait'))
          : b >= 3 ? row.ok(t(cfg.fundsKey)) + row.ok(t('trade.buy.done'))
          : '';
      }
    },
    async choreo(ctx, b) {
      const { stage, go, click, sleep, ok, say } = ctx;
      const tiles = stage.querySelectorAll('.gdemo-tile');
      if (b === 0) {
        await say('gm.demo.n.browse');
        await sleep(500); if (!ok()) return;
        await go(tiles[1]); if (!ok()) return;
        tiles[1].classList.add('is-hov'); await sleep(650); if (!ok()) return;
        tiles[1].classList.remove('is-hov');
        await go(tiles[2]); if (!ok()) return;
        tiles[2].classList.add('is-hov'); await sleep(650); if (!ok()) return;
        tiles[2].classList.remove('is-hov');
        await say('gm.demo.n.filter');
        const chip = stage.querySelector('[data-gd="chip"]');
        await go(chip, 800); if (!ok()) return;
        await click(chip); if (!ok()) return;
        chip.classList.add('is-on');
        await sleep(700);
      } else if (b === 1) {
        await say('gm.demo.n.open');
        await sleep(300); if (!ok()) return;
        await go(tiles[0], 850); if (!ok()) return;
        tiles[0].classList.add('is-hov'); await sleep(450); if (!ok()) return;
        await click(tiles[0]); if (!ok()) return;
        tiles[0].classList.remove('is-hov');
        stage.classList.add('m-open');
        await sleep(900);
      } else if (b === 2) {
        const buy = stage.querySelector('[data-gd="buy"]');
        const status = stage.querySelector('[data-gd="status"]');
        await say('gm.demo.n.buy');
        await sleep(400); if (!ok()) return;
        await go(buy, 850); if (!ok()) return;
        await click(buy); if (!ok()) return;
        await say('gm.demo.n.check');
        status.innerHTML = row.ok(t(cfg.fundsKey)); await sleep(750); if (!ok()) return;
        status.innerHTML = row.ok(t(cfg.fundsKey)) + row.info(t('trade.buy.confirm'));
        await say('gm.demo.n.walletBuy');
        stage.classList.add('w-open');
        const wc = stage.querySelector('[data-gd="wconfirm"]');
        await go(wc, 800); if (!ok()) return;
        await sleep(400); if (!ok()) return;
        await click(wc); if (!ok()) return;
        stage.classList.remove('w-open');
        await say('gm.demo.n.wait');
        status.innerHTML = row.ok(t(cfg.fundsKey)) + row.info(t('trade.buy.confirmWait'));
        await sleep(800);
      } else if (b === 3) {
        const status = stage.querySelector('[data-gd="status"]');
        await say('gm.demo.n.wait');
        await sleep(700); if (!ok()) return;
        status.innerHTML = row.ok(t(cfg.fundsKey)) + row.ok(t('trade.buy.done'));
        await sleep(650); if (!ok()) return;
        await say('');
        stage.classList.add('s-open');
      }
    },
  };
}

const TRADING_CREATURES = makeTradingSpec({
  title: 'gm.demo.title.tradingCreatures',
  caps: ['gm.demo.cap.browse', 'gm.demo.cap.open', 'gm.demo.cap.buy', 'gm.demo.cap.yours'],
  fundsKey: 'gm.demo.funds',
  barHtml: () => barOnHtml('creatures', { eth: '0.084', imx: '12.4', count: 3 }),
  filtersHtml: () => `<div class="gdemo-filters">
    <button type="button" class="trade-flt-rchip" data-r="epic" data-gd="chip" tabindex="-1">
      <span class="trade-flt-rdot" aria-hidden="true"></span>Epic<span class="trade-flt-n">231</span></button>
    <button type="button" class="trade-flt-rchip" data-r="legendary" tabindex="-1">
      <span class="trade-flt-rdot" aria-hidden="true"></span>Legendary<span class="trade-flt-n">16</span></button>
    <span class="gdemo-count">${rep('trade.filter.countAll', { n: 247 })}</span>
  </div>`,
  tilesHtml: () => FIX_CREATURES.map((f, i) => `<div class="trade-tile gdemo-tile" data-gd-tile="${i}">
    <div class="trade-tile-media">${artImg(f, 'creature', i, 'trade-tile-img')}<span class="trade-rank">#${f.rank}</span><span class="trade-rar" data-r="${f.r.toLowerCase()}">${f.r}</span></div>
    <div class="trade-tile-body">
      <span class="trade-tile-name">${f.name}</span>
      <span class="trade-tile-price">${f.eth}</span>
      <span class="trade-tile-usd">${f.fiat}</span>
    </div>
  </div>`).join(''),
  modalHtml: () => `<div class="gdemo-modal">
    <div class="trade-modal-card gdemo-card">
      <div class="trade-modal-media">${artImg(FIX_CREATURES[0], 'creature', 0, 'trade-modal-img')}
        <span class="trade-rank">#29</span><span class="trade-rar" data-r="epic">Epic</span></div>
      <div class="trade-modal-info">
        <h4 class="trade-modal-name">Creature #9453</h4>
        <div class="trade-modal-rank">${rep('trade.modal.rank', { r: 29, t: '11,111' })}</div>
        <div class="trade-modal-price">
          <span class="trade-modal-price-eth">0.0621 ETH</span>
          <span class="trade-modal-price-usd">≈ $153</span>
          <span class="trade-modal-fees">${t('trade.price.allin')}</span>
        </div>
        <div class="trade-buy">
          <button class="trade-send trade-buy-btn" data-gd="buy" type="button" tabindex="-1">${t('trade.buy.btn')} · 0.0621 ETH</button>
          <div class="gdemo-status" data-gd="status"></div>
        </div>
        <div class="trade-modal-traits gdemo-traits">
          <div class="trade-trait"><span class="trade-trait-k">Head Accessory</span><span class="trade-trait-v">Pastel Striped Witch Hat</span></div>
          <div class="trade-trait"><span class="trade-trait-k">Hair</span><span class="trade-trait-v">White V Bangs</span></div>
        </div>
      </div>
    </div>
  </div>`,
  walletRows: () => [
    [t('gm.demo.w.network'), 'Immutable zkEVM'],
    [t('gm.demo.w.amount'), '0.0621 ETH'],
    [t('gm.demo.w.gas'), '~0.0002 IMX'],
  ],
  success: () => ({
    art: artImg(FIX_CREATURES[0], 'creature', 0, 'gdemo-medal-img'),
    h: t('trade.buy.done'),
    p: t('gm.demo.done.p'),
  }),
});

const TRADING_LAND = makeTradingSpec({
  title: 'gm.demo.title.tradingLand',
  caps: ['gm.demo.la.cap.browse', 'gm.demo.la.cap.open', 'gm.demo.la.cap.buy', 'gm.demo.la.cap.yours'],
  fundsKey: 'gm.demo.la.funds',
  barHtml: () => barOnHtml('land', { eth: '0.31', count: 2 }),
  filtersHtml: () => `<div class="gdemo-filters">
    <button type="button" class="trade-flt-rchip" data-tier="premium" data-gd="chip" tabindex="-1">
      <span class="trade-flt-rdot" aria-hidden="true"></span>Premium<span class="trade-flt-pct">9%</span></button>
    <button type="button" class="trade-flt-rchip" data-tier="standard" tabindex="-1">
      <span class="trade-flt-rdot" aria-hidden="true"></span>Standard<span class="trade-flt-pct">91%</span></button>
    <span class="gdemo-count">${rep('trade.filter.countAllLand', { n: 21 })}</span>
  </div>`,
  tilesHtml: () => FIX_SLIMES.map((f, i) => `<div class="trade-tile gdemo-tile" data-gd-tile="${i}">
    <div class="trade-tile-media">${artImg(f, 'slime', i, 'trade-tile-img is-pet')}<span class="trade-rank">#${f.rank}</span></div>
    <div class="trade-tile-body">
      <span class="trade-tile-name">${f.nick}</span>
      <span class="trade-tile-sub">LAND ${f.coords}</span>
      <span class="trade-tile-price">${f.eth}</span>
      <span class="trade-tile-usd">${f.fiat}</span>
    </div>
  </div>`).join(''),
  modalHtml: () => `<div class="gdemo-modal">
    <div class="trade-modal-card gdemo-card">
      <div class="trade-modal-media">${artImg(FIX_SLIMES[0], 'slime', 0, 'trade-modal-img')}<span class="trade-rank">#25</span></div>
      <div class="trade-modal-info">
        <h4 class="trade-modal-name">Fleby</h4>
        <div class="trade-modal-rank">${rep('trade.modal.rankSlime', { r: 25, t: '2,972' })}</div>
        <div class="trade-modal-meta-row">${t('trade.land.parcel')}: <code>LAND (200, 135)</code></div>
        <div class="trade-modal-price">
          <span class="trade-modal-price-eth">0.185 ETH</span>
          <span class="trade-modal-price-usd">≈ $455</span>
          <span class="trade-modal-fees">${t('trade.price.allin')}</span>
        </div>
        <div class="trade-buy">
          <button class="trade-send trade-buy-btn" data-gd="buy" type="button" tabindex="-1">${t('trade.buy.btn')} · 0.185 ETH</button>
          <p class="trade-beta-micro">${t('trade.land.gasMicro')}</p>
          <div class="gdemo-status" data-gd="status"></div>
        </div>
        <div class="trade-modal-traits gdemo-traits">
          <div class="trade-trait"><span class="trade-trait-k">Headpiece</span><span class="trade-trait-v">Light It Up Antenna</span></div>
          <div class="trade-trait"><span class="trade-trait-k">Tier</span><span class="trade-trait-v">Premium</span></div>
        </div>
      </div>
    </div>
  </div>`,
  walletRows: () => [
    [t('gm.demo.w.network'), 'Ethereum'],
    [t('gm.demo.w.amount'), '0.185 ETH'],
    [t('gm.demo.w.gas'), '~0.0009 ETH'],
  ],
  success: () => ({
    art: artImg(FIX_SLIMES[0], 'slime', 0, 'gdemo-medal-img is-pet'),
    h: t('trade.buy.done'),
    p: t('gm.demo.la.done.p'),
  }),
});

// =====================================================================================
// FUNDING — a deep dive. Funding is a DIAGNOSIS, not a sequence: the real panels meet
// six different starting points. Each is its own scenario in the picker, mirroring the
// live fundsHelpHtml (can-bridge vs acquire branches), gasHelpHtml, and cashoutHtml.
// All copy assumes zero crypto knowledge — every term explains itself once.
// =====================================================================================

function buylineHtml(f, kind, name, price) {
  return `<div class="gdemo-buyline">
    <span class="gdemo-buyline-art">${artImg(f, kind, 0, kind === 'slime' ? 'gdemo-buyline-img is-pet' : 'gdemo-buyline-img')}</span>
    <div class="gdemo-buyline-t"><b>${name}</b><span>${price}</span></div>
    <button class="trade-send gdemo-buyline-btn" data-gd="buy" type="button" tabindex="-1">${t('trade.buy.btn')}</button>
  </div>`;
}
const crBuyline = () => buylineHtml(FIX_CREATURES[0], 'creature', 'Creature #9453', '0.0621 ETH · ≈ $153');
const laBuyline = () => buylineHtml(FIX_SLIMES[0], 'slime', 'Fleby — LAND (200, 135)', '0.185 ETH · ≈ $455');

const loadingHtml = () => `<div class="trade-modal-loading"><span class="trade-mini-spin" aria-hidden="true"></span> ${t('trade.bridge.quote.loading')}</div>`;
const bchip = (img, name) => `<span class="trade-bchip"><img src="/img/brands/${img}.png" alt="" width="14" height="14">${name}</span>`;
const bcoin = (img, gas) => `<span class="trade-bcoin trade-bcoin-${img}">
  <img src="/img/brands/${img}.png" alt="" width="30" height="30">${gas ? `<span class="trade-bcoin-spark" aria-hidden="true">${ico('fuel', 12)}</span>` : ''}</span>`;

function quoteAreaHtml({ x, y, fees, mins, gas }) {
  return `<div class="trade-bridge-quote">
    <div class="trade-bridge-line">${rep(gas ? 'trade.gas.bridge.line' : 'trade.bridge.quote.line', { x, y })}</div>
    <div class="trade-bridge-meta">${rep('trade.bridge.quote.fees', { f: fees })} · ${rep('trade.bridge.quote.mins', { m: mins })} · ${t('trade.bridge.quote.by')}</div>
    <button class="trade-funds-btn" data-gd="bridgenow" type="button" tabindex="-1">${t(gas ? 'trade.gas.bridge.now' : 'trade.bridge.now')}</button>
  </div>`;
}

function crossCardHtml({ title, from = 'eth', to = 'eth', gasSpark = false, active, clock,
  send, recv, routeFrom = 'Ethereum', routeFromImg = 'eth', routeTo = 'Immutable',
  routeToImg = 'immutable', eta = '~17',
  stepKeys = ['trade.bridge.step1', 'trade.bridge.step2', 'trade.bridge.step3'] }) {
  const steps = stepKeys.map((k, i) => {
    const cls = i < active ? 'is-done' : i === active ? 'is-active' : '';
    const ic = i < active ? ico('check', 13) : i === active ? '<span class="trade-mini-spin" aria-hidden="true"></span>' : '·';
    return `<div class="trade-bstep ${cls}"><span class="trade-bstep-dot">${ic}</span><span class="trade-bstep-lbl">${t(k)}</span></div>`;
  }).join('');
  return `<div class="trade-bcard" role="status">
    <div class="trade-bcard-hd">
      <div class="trade-bpair" aria-hidden="true">${bcoin(from)}<span class="trade-bpair-arrow">→</span>${bcoin(to, gasSpark)}</div>
      <h4>${title} ${spedChip()}</h4>
      <p>${t('trade.bridge.card.sub')}</p>
    </div>
    <div class="trade-bcard-body">
      <div class="trade-bsteps"><span class="trade-bsteps-fill" style="width:${active * 33.4}%"></span>${steps}</div>
      <div class="trade-brows">
        <div class="trade-brow"><span class="trade-brow-ic" aria-hidden="true">↔</span><span class="trade-brow-lbl">${t('trade.bridge.row.sendrecv')}</span><span class="trade-brow-val">${send} <span class="trade-brow-sep">→</span> <span class="trade-brow-to">${recv}</span></span></div>
        <div class="trade-brow"><span class="trade-brow-ic" aria-hidden="true">${ico('chain', 15)}</span><span class="trade-brow-lbl">${t('trade.bridge.row.route')}</span><span class="trade-brow-val">${bchip(routeFromImg, routeFrom)}<span class="trade-brow-sep">→</span>${bchip(routeToImg, routeTo)}</span></div>
        <div class="trade-brow"><span class="trade-brow-ic" aria-hidden="true">◷</span><span class="trade-brow-lbl">${t('trade.bridge.row.time')}</span><span class="trade-brow-val"><b data-gd="clock">${clock}</b> ${t('trade.bridge.elapsed')} <span class="trade-brow-sep">→</span> <span class="trade-brow-to">${eta} ${t('trade.bridge.min')}</span></span></div>
      </div>
    </div></div>`;
}

function doneCardHtml({ h, recv, on = 'Immutable', onImg = 'immutable', took = '16m 40s' }) {
  return `<div class="trade-bcard is-ok" role="status">
    <div class="trade-bcard-hd"><div class="trade-bcard-badge" aria-hidden="true">${ico('check', 20)}</div><h4>${h}</h4></div>
    <div class="trade-bcard-body">
      <div class="trade-brows">
        <div class="trade-brow"><span class="trade-brow-ic" aria-hidden="true">${ico('check', 15)}</span><span class="trade-brow-lbl">${t('trade.bridge.row.received')}</span><span class="trade-brow-val"><span class="trade-brow-to">${recv}</span></span></div>
        <div class="trade-brow"><span class="trade-brow-ic" aria-hidden="true">${ico('chain', 15)}</span><span class="trade-brow-lbl">${t('trade.bridge.row.on')}</span><span class="trade-brow-val">${bchip(onImg, on)}</span></div>
        <div class="trade-brow"><span class="trade-brow-ic" aria-hidden="true">◷</span><span class="trade-brow-lbl">${t('trade.bridge.row.took')}</span><span class="trade-brow-val"><b>${took}</b> ${spedChip()}</span></div>
      </div>
    </div></div>`;
}

// Swap the shared wallet-mock's contents (checkout vs bridge confirm vs sign).
function setMock(stage, { title, rows, confirm, paidRow }) {
  const wt = stage.querySelector('[data-gd="wtitle"]');
  if (wt && title) wt.textContent = title;
  const wr = stage.querySelector('[data-gd="wrows"]');
  if (wr) wr.innerHTML = paidRow ? row.ok(paidRow) : walletRowsHtml(rows || []);
  const wk = stage.querySelector('[data-gd="wok"]');
  if (wk && confirm) wk.textContent = confirm;
}

// --- Scenario 1 (Creatures): right coin, wrong network — the classic bridge ---------

const FUND_QUOTE = { x: '0.0655 ETH (≈ $161)', y: '0.0648 ETH (≈ $159)', fees: '0.09', mins: 17 };

function fundsPanelHtml(quote) {
  return `<div class="trade-funds">
    <div class="trade-funds-h"><span aria-hidden="true">${ico('bulb', 18)}</span> ${t('trade.funds.bridgeH')}</div>
    <ul class="trade-funds-list">
      <li><span class="trade-funds-ic" aria-hidden="true">${ico('external', 12)}</span><div>
        <b>ETH</b> — ${t('trade.funds.ethTitle')}<br>
        <span>${rep('trade.funds.youHaveOnEth', { x: '0.08 ETH (≈ $197)' })} · ${rep('trade.funds.bridgeNeed', { x: '0.0655 ETH' })}</span>
      </div></li>
      <li class="is-ok"><span class="trade-funds-ic" aria-hidden="true">${ico('check', 12)}</span><div>${t('trade.funds.imxGood')}<br><span>${t('trade.funds.have')} 12.4 IMX</span></div></li>
    </ul>
    <div data-gd="quotearea">${quote ? quoteAreaHtml(FUND_QUOTE) : loadingHtml()}</div>
  </div>`;
}

const FUND_BRIDGE = {
  title: 'gm.demo.title.fundingCreatures',
  steps: [
    { label: 'gm.demo.beat.short',  cap: 'gm.demo.fund.cap.short' },
    { label: 'gm.demo.beat.quote',  cap: 'gm.demo.fund.cap.quote' },
    { label: 'gm.demo.beat.bridge', cap: 'gm.demo.fund.cap.bridge' },
    { label: 'gm.demo.beat.landed', cap: 'gm.demo.fund.cap.landed' },
  ],
  stageHtml() {
    return `<div data-gd="bar">${barOnHtml('creatures', { eth: '0', imx: '12.4', count: 3 })}</div>`
      + crBuyline()
      + `<div class="gdemo-panel" data-gd="panel"></div>`
      + walletMockHtml({ rows: [
          [t('gm.demo.w.network'), 'Ethereum'],
          [t('gm.demo.w.amount'), '0.0655 ETH'],
          [t('gm.demo.w.route'), 'Squid → Immutable'],
        ] });
  },
  endState(ctx, b) {
    const { stage } = ctx;
    stage.classList.remove('w-open');
    stage.querySelector('[data-gd="bar"]').innerHTML =
      barOnHtml('creatures', { eth: b >= 3 ? '0.065' : '0', imx: '12.4', count: 3 });
    stage.querySelector('[data-gd="panel"]').innerHTML =
      b < 0 ? '' :
      b === 0 ? fundsPanelHtml(false) :
      b === 1 ? fundsPanelHtml(true) :
      b === 2 ? crossCardHtml({ title: t('trade.bridgebar.bridging'), active: 1, clock: '8:24', send: '0.0655', recv: '~0.0648 ETH' }) :
      doneCardHtml({ h: t('trade.bridge.done'), recv: '0.0648 ETH' });
  },
  async choreo(ctx, b) {
    const { stage, go, click, sleep, ok, tick, say } = ctx;
    const panel = stage.querySelector('[data-gd="panel"]');
    if (b === 0) {
      const buy = stage.querySelector('[data-gd="buy"]');
      await say('gm.demo.n.buy');
      await sleep(400); if (!ok()) return;
      await go(buy, 850); if (!ok()) return;
      await click(buy); if (!ok()) return;
      await say('gm.demo.n.check');
      panel.innerHTML = pop(fundsPanelHtml(false));
      await sleep(900);
    } else if (b === 1) {
      await say('gm.demo.n.quote');
      await sleep(900); if (!ok()) return;
      panel.innerHTML = fundsPanelHtml(true);
      await sleep(900);
    } else if (b === 2) {
      const now = stage.querySelector('[data-gd="bridgenow"]');
      await go(now, 850); if (!ok()) return;
      await click(now); if (!ok()) return;
      await say('gm.demo.n.walletMove');
      stage.classList.add('w-open');
      const wc = stage.querySelector('[data-gd="wconfirm"]');
      await go(wc, 800); if (!ok()) return;
      await sleep(400); if (!ok()) return;
      await click(wc); if (!ok()) return;
      stage.classList.remove('w-open');
      await say('gm.demo.n.crossing');
      panel.innerHTML = pop(crossCardHtml({ title: t('trade.bridgebar.bridging'), active: 0, clock: '0:04', send: '0.0655', recv: '~0.0648 ETH' }));
      await sleep(900); if (!ok()) return;
      panel.innerHTML = crossCardHtml({ title: t('trade.bridgebar.bridging'), active: 1, clock: '0:31', send: '0.0655', recv: '~0.0648 ETH' });
      await tick(stage.querySelector('[data-gd="clock"]'), ['1:02', '2:48', '5:15', '8:24'], 500);
    } else if (b === 3) {
      await say('gm.demo.n.crossing');
      await tick(stage.querySelector('[data-gd="clock"]'), ['11:36', '14:52', '16:40'], 420); if (!ok()) return;
      panel.innerHTML = crossCardHtml({ title: t('trade.bridgebar.bridging'), active: 2, clock: '16:40', send: '0.0655', recv: '~0.0648 ETH' });
      await sleep(800); if (!ok()) return;
      await say('gm.demo.n.landed');
      panel.innerHTML = pop(doneCardHtml({ h: t('trade.bridge.done'), recv: '0.0648 ETH' }));
      stage.querySelector('[data-gd="bar"]').innerHTML = barOnHtml('creatures', { eth: '0.065', imx: '12.4', count: 3 });
      await sleep(1100);
    }
  },
};

// --- Scenarios 2-4 (Creatures): acquire — zero / short / split ----------------------
// Mirrors the live acquire branch: card checkout lands ETH on Ethereum, then one tap
// bridges it to Immutable zkEVM. Same skeleton, different numbers and notes.

function acquirePanelHtml(o) {
  const zk = o.zkHave ? ` · ${t('trade.funds.have')} ${o.zkHave} ${t('trade.funds.onZk')}` : '';
  const main = o.mainHave ? ` · ${rep('trade.funds.plusOnEth', { x: o.mainHave })}` : '';
  const note = o.splitNote
    ? `<p class="trade-funds-net">${rep('trade.funds.notEnoughToBridge', { x: o.mainHave, y: o.cardAmt })}</p>` : '';
  return `<div class="trade-funds">
    <div class="trade-funds-h"><span aria-hidden="true">${ico('bulb', 18)}</span> ${t('trade.funds.h')}</div>
    <ul class="trade-funds-list">
      <li><span class="trade-funds-ic" aria-hidden="true">•</span><div>
        <b>ETH</b> — ${t('trade.funds.forPrice')}<br>
        <span>${t('trade.funds.need')} ≈ <b>0.0621 ETH (≈ $153)</b>${zk}${main}</span>
      </div></li>
      <li><span class="trade-funds-ic" aria-hidden="true">•</span><div>${t('trade.funds.imxNeed')}<br><span>${t('trade.funds.have')} 12.4 IMX · ${t('trade.funds.gasHint')}</span></div></li>
    </ul>
    ${note}
    <p class="trade-funds-net">${t('trade.onramp.net')}</p>
    <button class="trade-funds-btn" data-gd="onramp" type="button" tabindex="-1">${t('trade.onramp.btn')} ${ico('card', 15)}</button>
    <p class="trade-funds-foot">${t('trade.onramp.fundsFoot')}</p>
  </div>`;
}

function makeAcquireScenario(o) {
  // o: { title, caps[4], barStart, barEnd, panel, cardRows, quote, crossSend, crossRecv, doneRecv }
  const checkout = () => ({ title: t('gm.demo.onramp.title'), rows: o.cardRows(), confirm: t('gm.demo.onramp.pay') });
  const bridgeMock = () => ({ title: t('gm.demo.w.title'), rows: [
    [t('gm.demo.w.network'), 'Ethereum'],
    [t('gm.demo.w.amount'), o.crossSend + ' ETH'],
    [t('gm.demo.w.route'), 'Squid → Immutable'],
  ], confirm: t('gm.demo.w.confirm') });
  return {
    title: o.title,
    steps: [
      { label: 'gm.demo.beat.check',  cap: o.caps[0] },
      { label: 'gm.demo.beat.topup',  cap: o.caps[1] },
      { label: 'gm.demo.beat.bridge', cap: o.caps[2] },
      { label: 'gm.demo.beat.landed', cap: o.caps[3] },
    ],
    stageHtml() {
      return `<div data-gd="bar">${barOnHtml('creatures', o.barStart)}</div>`
        + crBuyline()
        + `<div class="gdemo-panel" data-gd="panel"></div>`
        + walletMockHtml({ ...checkout(), icon: 'dot' });
    },
    endState(ctx, b) {
      const { stage } = ctx;
      stage.classList.toggle('w-open', b === 1);
      setMock(stage, b === 1 ? { ...checkout(), paidRow: t('gm.demo.onramp.paid') } : checkout());
      stage.querySelector('[data-gd="bar"]').innerHTML =
        barOnHtml('creatures', b >= 3 ? o.barEnd : o.barStart);
      stage.querySelector('[data-gd="panel"]').innerHTML =
        b < 0 ? '' :
        b <= 1 ? acquirePanelHtml(o.panel) :
        b === 2 ? crossCardHtml({ title: t('trade.bridgebar.bridging'), active: 1, clock: '7:12', send: o.crossSend, recv: o.crossRecv }) :
        doneCardHtml({ h: t('trade.bridge.done'), recv: o.doneRecv });
    },
    async choreo(ctx, b) {
      const { stage, go, click, sleep, ok, tick, say } = ctx;
      const panel = stage.querySelector('[data-gd="panel"]');
      if (b === 0) {
        const buy = stage.querySelector('[data-gd="buy"]');
        await say('gm.demo.n.buy');
        await sleep(400); if (!ok()) return;
        await go(buy, 850); if (!ok()) return;
        await click(buy); if (!ok()) return;
        await say('gm.demo.n.check');
        panel.innerHTML = pop(acquirePanelHtml(o.panel));
        await sleep(900);
      } else if (b === 1) {
        setMock(stage, checkout());
        await say('gm.demo.n.card');
        const btn = stage.querySelector('[data-gd="onramp"]');
        await go(btn, 850); if (!ok()) return;
        await click(btn); if (!ok()) return;
        await say('gm.demo.n.pay');
        stage.classList.add('w-open');
        const wc = stage.querySelector('[data-gd="wconfirm"]');
        await go(wc, 900); if (!ok()) return;
        await sleep(500); if (!ok()) return;
        await click(wc); if (!ok()) return;
        await say('gm.demo.n.paid');
        setMock(stage, { paidRow: t('gm.demo.onramp.paid') });
        await sleep(900);
      } else if (b === 2) {
        await say('gm.demo.n.quote');
        panel.innerHTML = loadingHtml();
        await sleep(900); if (!ok()) return;
        panel.innerHTML = pop(quoteAreaHtml(o.quote));
        setMock(stage, bridgeMock());
        const now = stage.querySelector('[data-gd="bridgenow"]');
        await go(now, 900); if (!ok()) return;
        await click(now); if (!ok()) return;
        await say('gm.demo.n.walletMove');
        stage.classList.add('w-open');
        const wc = stage.querySelector('[data-gd="wconfirm"]');
        await go(wc, 800); if (!ok()) return;
        await sleep(400); if (!ok()) return;
        await click(wc); if (!ok()) return;
        stage.classList.remove('w-open');
        await say('gm.demo.n.crossing');
        panel.innerHTML = pop(crossCardHtml({ title: t('trade.bridgebar.bridging'), active: 1, clock: '0:42', send: o.crossSend, recv: o.crossRecv }));
        await tick(stage.querySelector('[data-gd="clock"]'), ['2:10', '4:55', '7:12'], 480);
      } else if (b === 3) {
        await say('gm.demo.n.crossing');
        await tick(stage.querySelector('[data-gd="clock"]'), ['11:02', '15:26', '16:31'], 420); if (!ok()) return;
        panel.innerHTML = crossCardHtml({ title: t('trade.bridgebar.bridging'), active: 2, clock: '16:31', send: o.crossSend, recv: o.crossRecv });
        await sleep(800); if (!ok()) return;
        await say('gm.demo.n.landed');
        panel.innerHTML = pop(doneCardHtml({ h: t('trade.bridge.done'), recv: o.doneRecv, took: '16m 31s' }));
        stage.querySelector('[data-gd="bar"]').innerHTML = barOnHtml('creatures', o.barEnd);
        await sleep(1100);
      }
    },
  };
}

const FUND_ZERO = makeAcquireScenario({
  title: 'gm.demo.title.fund.zero',
  caps: ['gm.demo.fund.zero.c1', 'gm.demo.fund.zero.c2', 'gm.demo.fund.zero.c3', 'gm.demo.fund.zero.c4'],
  barStart: { eth: '0', imx: '0', count: 0 },
  barEnd: { eth: '0.067', imx: '0', count: 0 },
  panel: { zkHave: '', mainHave: '' },
  cardRows: () => [
    [t('gm.demo.onramp.buyRow'), '0.07 ETH ≈ $172'],
    [t('gm.demo.onramp.toRow'), DEMO_ADDR],
    [t('gm.demo.onramp.payRow'), t('gm.demo.onramp.methods')],
  ],
  quote: { x: '0.068 ETH (≈ $167)', y: '0.0672 ETH (≈ $165)', fees: '0.09', mins: 17 },
  crossSend: '0.068', crossRecv: '~0.0672 ETH', doneRecv: '0.0672 ETH',
});

const FUND_SHORT = makeAcquireScenario({
  title: 'gm.demo.title.fund.short',
  caps: ['gm.demo.fund.short.c1', 'gm.demo.fund.short.c2', 'gm.demo.fund.short.c3', 'gm.demo.fund.short.c4'],
  barStart: { eth: '0.05', imx: '12.4', count: 3 },
  barEnd: { eth: '0.0645', imx: '12.4', count: 3 },
  panel: { zkHave: '0.05 ETH (≈ $123)', mainHave: '' },
  cardRows: () => [
    [t('gm.demo.onramp.buyRow'), '0.015 ETH ≈ $37'],
    [t('gm.demo.onramp.toRow'), DEMO_ADDR],
    [t('gm.demo.onramp.payRow'), t('gm.demo.onramp.methods')],
  ],
  quote: { x: '0.0148 ETH (≈ $36)', y: '0.0145 ETH (≈ $36)', fees: '0.07', mins: 17 },
  crossSend: '0.0148', crossRecv: '~0.0145 ETH', doneRecv: '0.0145 ETH',
});

const FUND_SPLIT = makeAcquireScenario({
  title: 'gm.demo.title.fund.split',
  caps: ['gm.demo.fund.split.c1', 'gm.demo.fund.split.c2', 'gm.demo.fund.split.c3', 'gm.demo.fund.split.c4'],
  barStart: { eth: '0.01', imx: '12.4', count: 3 },
  barEnd: { eth: '0.071', imx: '12.4', count: 3 },
  panel: { zkHave: '0.01 ETH (≈ $25)', mainHave: '0.03 ETH (≈ $74)', splitNote: true, cardAmt: '0.033 ETH (≈ $81)' },
  cardRows: () => [
    [t('gm.demo.onramp.buyRow'), '0.033 ETH ≈ $81'],
    [t('gm.demo.onramp.toRow'), DEMO_ADDR],
    [t('gm.demo.onramp.payRow'), t('gm.demo.onramp.methods')],
  ],
  quote: { x: '0.062 ETH (≈ $153)', y: '0.061 ETH (≈ $150)', fees: '0.09', mins: 17 },
  crossSend: '0.062', crossRecv: '~0.061 ETH', doneRecv: '0.061 ETH',
});

// --- Scenario 5 (Creatures): wrong coin — ETH but no IMX gas ------------------------

const GAS_QUOTE = { x: '0.002 ETH (≈ $5)', y: '4.9 IMX', fees: '0.04', mins: 1, gas: true };

function gasPanelHtml(quote) {
  return `<div class="trade-funds trade-gas">
    <div class="trade-funds-h"><span aria-hidden="true">${ico('fuel', 18)}</span> ${t('trade.gas.h')}</div>
    <ul class="trade-funds-list">
      <li><span class="trade-funds-ic" aria-hidden="true">•</span><div>
        <b>IMX</b> — ${t('trade.gas.imxLine')}<br>
        <span>${t('trade.funds.have')} 0 IMX · ${t('trade.funds.gasHint')}</span>
      </div></li>
    </ul>
    <p class="trade-funds-net">${t('trade.gas.bridgeNote')}</p>
    <div data-gd="quotearea">${quote ? quoteAreaHtml(GAS_QUOTE) : loadingHtml()}</div>
  </div>`;
}

const FUND_GAS = {
  title: 'gm.demo.title.fund.gas',
  steps: [
    { label: 'gm.demo.beat.check',  cap: 'gm.demo.fund.gas.c1' },
    { label: 'gm.demo.beat.swap',   cap: 'gm.demo.fund.gas.c2' },
    { label: 'gm.demo.beat.landed', cap: 'gm.demo.fund.gas.c3' },
  ],
  stageHtml() {
    return `<div data-gd="bar">${barOnHtml('creatures', { eth: '0.084', imx: '0', count: 3 })}</div>`
      + crBuyline()
      + `<div class="gdemo-panel" data-gd="panel"></div>`
      + walletMockHtml({ rows: [
          [t('gm.demo.w.network'), 'Ethereum'],
          [t('gm.demo.w.amount'), '0.002 ETH'],
          [t('gm.demo.w.route'), 'Squid → Immutable'],
        ] });
  },
  endState(ctx, b) {
    const { stage } = ctx;
    stage.classList.remove('w-open');
    stage.querySelector('[data-gd="bar"]').innerHTML =
      barOnHtml('creatures', { eth: '0.084', imx: b >= 2 ? '4.9' : '0', count: 3 });
    stage.querySelector('[data-gd="panel"]').innerHTML =
      b < 0 ? '' :
      b === 0 ? gasPanelHtml(true) :
      b === 1 ? crossCardHtml({ title: t('trade.gas.bridgebar.bridging'), to: 'imx', gasSpark: true, active: 1, clock: '0:38', send: '0.002 ETH', recv: '~4.9 IMX', eta: '~1' }) :
      doneCardHtml({ h: t('trade.gas.bridge.done'), recv: '4.9 IMX', took: '1m 04s' });
  },
  async choreo(ctx, b) {
    const { stage, go, click, sleep, ok, tick, say } = ctx;
    const panel = stage.querySelector('[data-gd="panel"]');
    if (b === 0) {
      const buy = stage.querySelector('[data-gd="buy"]');
      await say('gm.demo.n.buy');
      await sleep(400); if (!ok()) return;
      await go(buy, 850); if (!ok()) return;
      await click(buy); if (!ok()) return;
      await say('gm.demo.n.check');
      panel.innerHTML = pop(gasPanelHtml(false));
      await sleep(900); if (!ok()) return;
      panel.innerHTML = gasPanelHtml(true);
      await sleep(700);
    } else if (b === 1) {
      await say('gm.demo.n.swap');
      const now = stage.querySelector('[data-gd="bridgenow"]');
      await go(now, 850); if (!ok()) return;
      await click(now); if (!ok()) return;
      await say('gm.demo.n.walletMove');
      stage.classList.add('w-open');
      const wc = stage.querySelector('[data-gd="wconfirm"]');
      await go(wc, 800); if (!ok()) return;
      await sleep(400); if (!ok()) return;
      await click(wc); if (!ok()) return;
      stage.classList.remove('w-open');
      await say('gm.demo.n.crossing');
      panel.innerHTML = pop(crossCardHtml({ title: t('trade.gas.bridgebar.bridging'), to: 'imx', gasSpark: true, active: 1, clock: '0:07', send: '0.002 ETH', recv: '~4.9 IMX', eta: '~1' }));
      await tick(stage.querySelector('[data-gd="clock"]'), ['0:19', '0:38'], 500);
    } else if (b === 2) {
      await say('gm.demo.n.crossing');
      await tick(stage.querySelector('[data-gd="clock"]'), ['0:52', '1:04'], 450); if (!ok()) return;
      await say('gm.demo.n.landed');
      panel.innerHTML = pop(doneCardHtml({ h: t('trade.gas.bridge.done'), recv: '4.9 IMX', took: '1m 04s' }));
      stage.querySelector('[data-gd="bar"]').innerHTML = barOnHtml('creatures', { eth: '0.084', imx: '4.9', count: 3 });
      await sleep(1100);
    }
  },
};

// --- Scenario 6 (Creatures) + LAND cash-out: sale proceeds → real money -------------

function cashSheetHtml(land) {
  if (land) {
    const stepKeys = ['trade.cashout.land.step1', 'trade.cashout.land.step2'];
    return `<div class="gdemo-safety">
      <div class="trade-safety-card gdemo-safety-card">
        <span class="apply-pill">${t('trade.cashout.badge')}</span>
        <h3 class="trade-safety-h">${t('trade.cashout.guide.h')}</h3>
        <div class="trade-cashout-warn"><span aria-hidden="true">${ico('alert', 19)}</span><p>${t('trade.cashout.land.warn')}</p></div>
        <ol class="trade-cashout-steps">${stepKeys.map((k, i) =>
          `<li><span class="trade-cashout-num">${i + 1}</span><span>${t(k)}</span></li>`).join('')}</ol>
        <div class="trade-safety-actions">
          <button class="trade-send trade-safety-ok" data-gd="cashact" type="button" tabindex="-1">${t('trade.cashout.land.unwrapBtn')}</button>
        </div>
      </div>
    </div>`;
  }
  // Creatures: the in-site Move screen — same wallet on both sides, amount, live quote.
  const hop = (net, img, sub) => `
    <div class="trade-cashout-hop">
      <img class="trade-cashout-hop-mm" src="/img/brands/metamask.svg" alt="" width="26" height="26">
      <span class="trade-cashout-hop-tx"><b>${t(net)} · ${DEMO_ADDR}</b><span>${t(sub)}</span></span>
      <span class="trade-bchip"><img src="${img}" alt="" width="14" height="14">${img.includes('eth') ? 'Ethereum' : 'Immutable zkEVM'}</span>
    </div>`;
  return `<div class="gdemo-safety">
    <div class="trade-safety-card gdemo-safety-card">
      <span class="apply-pill">${t('trade.cashout.badge')}</span>
      <h3 class="trade-safety-h">${t('trade.cashout.move.h')}</h3>
      <p class="trade-safety-p">${t('trade.cashout.move.p')}</p>
      <div class="trade-cashout-route">
        ${hop('trade.cashout.move.from', '/img/brands/immutable.png', 'trade.cashout.move.fromSub')}
        <div class="trade-cashout-hop-arrow" aria-hidden="true">↓</div>
        ${hop('trade.cashout.move.to', '/img/brands/eth.png', 'trade.cashout.move.toSub')}
      </div>
      <div class="trade-cashout-amtrow">
        <span class="trade-cashout-amt" style="text-align:left">0.0585</span>
        <span class="trade-cashout-unit">ETH</span>
        <span class="trade-cashout-max">${t('trade.cashout.move.max')}</span>
      </div>
      <p class="trade-cashout-balline">${t('trade.cashout.move.bal').replace('{x}', '0.0585 ETH')}</p>
      <div class="trade-bridge-quote" style="text-align:left">
        <div class="trade-bridge-line">${t('trade.cashout.move.quoteLine').replace('{y}', '0.0579 ETH')}</div>
        <div class="trade-bridge-meta">${t('trade.bridge.quote.fees').replace('{f}', '0.23')} · ${t('trade.cashout.move.mins')} · ${t('trade.bridge.quote.by')}</div>
        <button class="trade-funds-btn" data-gd="cashact" type="button" tabindex="-1">${t('trade.cashout.move.btn')}</button>
      </div>
    </div>
  </div>`;
}

// The dedicated Cash out walkthrough (Guides › Marketplace › step 6): the full in-site
// move, every tap shown — sold → open Cash out → the two MetaMask confirmations →
// crossing (with the real out-direction tracker) → landed on Ethereum → exchange.
// Deliberately slower and wordier than the funding demos: this is the step people
// arrive at scared of losing real money, so the captions do the calming.
// Times mirror a real cash-out (executed in 1m 12s) — this direction is FAST; only
// the mainnet→zkEVM funding direction waits on Ethereum finality.
const OUT_STEP_KEYS = ['trade.bridge.step1.out', 'trade.bridge.step2.out', 'trade.bridge.step3'];
const cashCross = (active, clock) => crossCardHtml({
  title: t('trade.cashout.move.bridging'), active, clock, eta: '~2',
  send: '0.0585 ETH', recv: '~0.0579 ETH',
  routeFrom: 'Immutable', routeFromImg: 'immutable', routeTo: 'Ethereum', routeToImg: 'eth',
  stepKeys: OUT_STEP_KEYS,
});
const cashApproveMock = () => ({
  title: t('gm.demo.cash2.w.approveT'),
  rows: [
    [t('gm.demo.w.network'), 'Immutable zkEVM'],
    [t('gm.demo.w.action'), t('gm.demo.cash2.w.allow')],
    [t('gm.demo.w.gas'), '~0.0002 IMX'],
  ],
  confirm: t('gm.demo.w.confirm'),
});
const cashMoveMock = () => ({
  title: t('gm.demo.cash2.w.moveT'),
  rows: [
    [t('gm.demo.w.network'), 'Immutable zkEVM'],
    [t('gm.demo.w.amount'), '0.0585 ETH'],
    [t('gm.demo.w.route'), 'Squid → Ethereum'],
    [t('gm.demo.w.gas'), '~1.6 IMX (≈ $0.23)'],
  ],
  confirm: t('gm.demo.w.confirm'),
});

const CASH_MOVE = {
  title: 'gm.demo.title.fund.cash',
  steps: [
    { label: 'gm.demo.beat.sold',    cap: 'gm.demo.cash2.c1' },
    { label: 'gm.demo.beat.open',    cap: 'gm.demo.cash2.c2' },
    { label: 'gm.demo.beat.confirm', cap: 'gm.demo.cash2.c3' },
    { label: 'gm.demo.beat.cross',   cap: 'gm.demo.cash2.c4' },
    // "Landed", not "To bank": the beat ends with the ETH on Ethereum and hands off to
    // the "Where to sell your ETH" section below the demo. No bank appears on stage.
    { label: 'gm.demo.beat.landed',  cap: 'gm.demo.cash2.c5' },
  ],
  stageHtml() {
    return `<div data-gd="bar">${barOnHtml('creatures', { eth: '0.0585', imx: '12.4', count: 2 }, { cashout: true })}</div>`
      + `<div class="gdemo-panel" data-gd="panel"></div>`
      + cashSheetHtml(false)
      + walletMockHtml(cashApproveMock());
  },
  endState(ctx, b) {
    const { stage } = ctx;
    stage.classList.toggle('safety-open', b === 1);
    stage.classList.remove('w-open');
    setMock(stage, b >= 2 ? cashMoveMock() : cashApproveMock());
    stage.querySelector('[data-gd="bar"]').innerHTML =
      barOnHtml('creatures', { eth: b >= 2 ? '0' : '0.0585', imx: '12.4', count: 2 }, { cashout: true });
    stage.querySelector('[data-gd="panel"]').innerHTML =
      b <= 0 ? (b === 0 ? row.ok(t('gm.demo.sold.cr')) : '') :
      b === 1 ? '' :
      b === 2 ? cashCross(0, '0:12') :
      b === 3 ? cashCross(1, '0:58') :
      doneCardHtml({ h: t('trade.cashout.move.done'), recv: '0.0579 ETH', on: 'Ethereum', onImg: 'eth', took: '1m 12s' })
        + row.ok(t('gm.demo.cash2.next'));
  },
  async choreo(ctx, b) {
    const { stage, go, click, sleep, ok, tick, say } = ctx;
    const panel = stage.querySelector('[data-gd="panel"]');
    if (b === 0) {
      await say('gm.demo.n.sold');
      await sleep(700); if (!ok()) return;
      panel.innerHTML = pop(row.ok(t('gm.demo.sold.cr')));
      await sleep(900);
    } else if (b === 1) {
      // Open Cash out → the move screen: your own wallet on both sides, amount, quote.
      await say('gm.demo.n.cashguide');
      const pill = stage.querySelector('[data-gd="cashpill"]');
      await go(pill, 900); if (!ok()) return;
      await click(pill); if (!ok()) return;
      panel.innerHTML = '';
      stage.classList.add('safety-open');
      await say('gm.demo.n.readwarn');
      await sleep(2000); if (!ok()) return;
    } else if (b === 2) {
      // The two MetaMask taps: a one-time allowance, then the move itself.
      stage.classList.add('safety-open');
      const act = stage.querySelector('[data-gd="cashact"]');
      await go(act, 900); if (!ok()) return;
      await click(act); if (!ok()) return;
      stage.classList.remove('safety-open');
      await say('gm.demo.n.approve');
      setMock(stage, cashApproveMock());
      stage.classList.add('w-open');
      const wc = stage.querySelector('[data-gd="wconfirm"]');
      await go(wc, 900); if (!ok()) return;
      await sleep(600); if (!ok()) return;
      await click(wc); if (!ok()) return;
      await say('gm.demo.n.walletMove');
      setMock(stage, cashMoveMock());
      await sleep(1100); if (!ok()) return;
      await go(wc, 500); if (!ok()) return;
      await click(wc); if (!ok()) return;
      stage.classList.remove('w-open');
      await say('gm.demo.n.crossing');
      stage.querySelector('[data-gd="bar"]').innerHTML =
        barOnHtml('creatures', { eth: '0', imx: '12.4', count: 2 }, { cashout: true });
      panel.innerHTML = pop(cashCross(0, '0:04'));
      await tick(stage.querySelector('[data-gd="clock"]'), ['0:08', '0:12'], 500);
    } else if (b === 3) {
      await say('gm.demo.n.crossing');
      panel.innerHTML = cashCross(1, '0:21');
      await tick(stage.querySelector('[data-gd="clock"]'), ['0:34', '0:47', '0:58'], 520);
    } else if (b === 4) {
      await say('gm.demo.n.crossing');
      await tick(stage.querySelector('[data-gd="clock"]'), ['1:05', '1:12'], 450); if (!ok()) return;
      await say('gm.demo.n.landed');
      panel.innerHTML = pop(
        doneCardHtml({ h: t('trade.cashout.move.done'), recv: '0.0579 ETH', on: 'Ethereum', onImg: 'eth', took: '1m 12s' })
        + row.ok(t('gm.demo.cash2.next')));
      await sleep(1100);
    }
  },
};

// --- LAND scenarios ------------------------------------------------------------------

function landAcquirePanelHtml(short) {
  return (short ? row.err(t('gm.demo.la.short')) : '')
    + `<div class="trade-funds">
      <p class="trade-funds-net">${t('gm.demo.onramp.landNet')}</p>
      <button class="trade-funds-btn" data-gd="onramp" type="button" tabindex="-1">${t('trade.onramp.btn')} ${ico('card', 15)}</button>
    </div>`;
}

function makeLandAcquireScenario(o) {
  // o: { title, caps[3], short, barStart, barEnd, cardAmt, tickVals }
  const checkout = () => ({ title: t('gm.demo.onramp.title'), rows: [
    [t('gm.demo.onramp.buyRow'), o.cardAmt],
    [t('gm.demo.onramp.toRow'), DEMO_ADDR],
    [t('gm.demo.onramp.payRow'), t('gm.demo.onramp.methods')],
  ], confirm: t('gm.demo.onramp.pay') });
  return {
    title: 'gm.demo.title.fundingLand',
    steps: [
      { label: 'gm.demo.beat.check', cap: o.caps[0] },
      { label: 'gm.demo.beat.topup', cap: o.caps[1] },
      { label: 'gm.demo.beat.ready', cap: o.caps[2] },
    ],
    stageHtml() {
      return `<div data-gd="bar">${barOnHtml('land', o.barStart)}</div>`
        + laBuyline()
        + `<div class="gdemo-panel" data-gd="panel"></div>`
        + walletMockHtml({ ...checkout(), icon: 'dot' });
    },
    endState(ctx, b) {
      const { stage } = ctx;
      stage.classList.toggle('w-open', b === 1);
      setMock(stage, b === 1 ? { ...checkout(), paidRow: t('gm.demo.onramp.paid') } : checkout());
      stage.querySelector('[data-gd="bar"]').innerHTML =
        barOnHtml('land', b >= 2 ? o.barEnd : o.barStart);
      stage.querySelector('[data-gd="panel"]').innerHTML =
        b < 0 ? '' :
        b <= 1 ? landAcquirePanelHtml(o.short) :
        row.ok(t('gm.demo.readyBuy'));
    },
    async choreo(ctx, b) {
      const { stage, go, click, sleep, ok, tick, say } = ctx;
      const panel = stage.querySelector('[data-gd="panel"]');
      if (b === 0) {
        const buy = stage.querySelector('[data-gd="buy"]');
        await say('gm.demo.n.buy');
        await sleep(400); if (!ok()) return;
        await go(buy, 850); if (!ok()) return;
        await click(buy); if (!ok()) return;
        await say('gm.demo.n.check');
        panel.innerHTML = pop(landAcquirePanelHtml(o.short));
        await sleep(900);
      } else if (b === 1) {
        await say('gm.demo.n.card');
        const btn = stage.querySelector('[data-gd="onramp"]');
        await go(btn, 850); if (!ok()) return;
        await click(btn); if (!ok()) return;
        await say('gm.demo.n.pay');
        stage.classList.add('w-open');
        const wc = stage.querySelector('[data-gd="wconfirm"]');
        await go(wc, 900); if (!ok()) return;
        await sleep(500); if (!ok()) return;
        await click(wc); if (!ok()) return;
        await say('gm.demo.n.paid');
        setMock(stage, { paidRow: t('gm.demo.onramp.paid') });
        await sleep(900);
      } else if (b === 2) {
        await say('gm.demo.n.balances');
        await sleep(500); if (!ok()) return;
        await tick(stage.querySelector('[data-gd="bal-eth"]'), o.tickVals, 420); if (!ok()) return;
        await say('gm.demo.n.landed');
        panel.innerHTML = pop(row.ok(t('gm.demo.readyBuy')));
        await sleep(1000);
      }
    },
  };
}

const FUNDLA_SHORT = makeLandAcquireScenario({
  caps: ['gm.demo.fundla.cap.check', 'gm.demo.fundla.cap.topup', 'gm.demo.fundla.cap.ready'],
  short: true,
  barStart: { eth: '0.02', count: 2 }, barEnd: { eth: '0.19', count: 2 },
  cardAmt: '0.17 ETH ≈ $420', tickVals: ['0.06', '0.12', '0.19'],
});

const FUNDLA_ZERO = makeLandAcquireScenario({
  caps: ['gm.demo.fundla.zero.c1', 'gm.demo.fundla.zero.c2', 'gm.demo.fundla.zero.c3'],
  short: false,
  barStart: { eth: '0', count: 0 }, barEnd: { eth: '0.195', count: 0 },
  cardAmt: '0.195 ETH ≈ $480', tickVals: ['0.07', '0.14', '0.195'],
});

const FUNDLA_CASHOUT = {
  title: 'gm.demo.title.fundla.cash',
  steps: [
    { label: 'gm.demo.beat.sold',   cap: 'gm.demo.fundla.cash.c1' },
    { label: 'gm.demo.beat.unwrap', cap: 'gm.demo.fundla.cash.c2' },
    { label: 'gm.demo.beat.send',   cap: 'gm.demo.fundla.cash.c3' },
  ],
  stageHtml() {
    return `<div data-gd="bar">${barOnHtml('land', { eth: '0.02', count: 1 }, { cashout: true })}</div>`
      + `<div class="gdemo-panel" data-gd="panel"></div>`
      + cashSheetHtml(true)
      + walletMockHtml({ rows: [
          [t('gm.demo.w.network'), 'Ethereum'],
          [t('gm.demo.w.action'), t('gm.demo.w.unwrapAction')],
          [t('gm.demo.w.gas'), '~0.0004 ETH'],
        ] });
  },
  endState(ctx, b) {
    const { stage } = ctx;
    stage.classList.remove('safety-open', 'w-open');
    stage.querySelector('[data-gd="bar"]').innerHTML =
      barOnHtml('land', { eth: b >= 1 ? '0.196' : '0.02', count: 1 }, { cashout: true });
    stage.querySelector('[data-gd="panel"]').innerHTML =
      b < 0 ? '' :
      b === 0 ? row.ok(t('gm.demo.sold.la')) :
      b === 1 ? row.ok(t('gm.demo.cash.unwrapped')) :
      row.ok(t('gm.demo.cash.unwrapped')) + row.ok(t('gm.demo.cash.done'));
  },
  async choreo(ctx, b) {
    const { stage, go, click, sleep, ok, say } = ctx;
    const panel = stage.querySelector('[data-gd="panel"]');
    if (b === 0) {
      await say('gm.demo.n.sold');
      await sleep(700); if (!ok()) return;
      panel.innerHTML = pop(row.ok(t('gm.demo.sold.la')));
      await sleep(900);
    } else if (b === 1) {
      await say('gm.demo.n.cashguide');
      const pill = stage.querySelector('[data-gd="cashpill"]');
      await go(pill, 900); if (!ok()) return;
      await click(pill); if (!ok()) return;
      stage.classList.add('safety-open');
      await say('gm.demo.n.readwarn');
      await sleep(2600); if (!ok()) return;
      await say('gm.demo.n.unwrap'); // the instruction narrates BEFORE the tap it describes
      const act = stage.querySelector('[data-gd="cashact"]');
      await go(act, 800); if (!ok()) return;
      await click(act); if (!ok()) return;
      stage.classList.remove('safety-open');
      await say('gm.demo.n.walletMove');
      stage.classList.add('w-open');
      const wc = stage.querySelector('[data-gd="wconfirm"]');
      await go(wc, 800); if (!ok()) return;
      await sleep(400); if (!ok()) return;
      await click(wc); if (!ok()) return;
      stage.classList.remove('w-open');
      await say('gm.demo.n.wait');
      panel.innerHTML = pop(row.info(t('gm.demo.sending')));
      await sleep(1000); if (!ok()) return;
      panel.innerHTML = row.ok(t('gm.demo.cash.unwrapped'));
      stage.querySelector('[data-gd="bar"]').innerHTML =
        barOnHtml('land', { eth: '0.196', count: 1 }, { cashout: true });
      await sleep(800);
    } else if (b === 2) {
      await sleep(800); if (!ok()) return;
      panel.innerHTML = row.ok(t('gm.demo.cash.unwrapped')) + pop(row.ok(t('gm.demo.cash.done')));
    }
  },
};

// Cash-out moved to its own walkthrough step (Guides › Marketplace › 6, demos
// 'cashout-creatures'/'cashout-land') — funding keeps the getting-money-IN scenarios.
const FUNDING_CREATURES = {
  scenarios: [
    { label: 'gm.demo.scen.cr.bridge',  spec: FUND_BRIDGE },
    { label: 'gm.demo.scen.cr.zero',    spec: FUND_ZERO },
    { label: 'gm.demo.scen.cr.short',   spec: FUND_SHORT },
    { label: 'gm.demo.scen.cr.split',   spec: FUND_SPLIT },
    { label: 'gm.demo.scen.cr.gas',     spec: FUND_GAS },
  ],
};

const FUNDING_LAND = {
  scenarios: [
    { label: 'gm.demo.scen.la.short',   spec: FUNDLA_SHORT },
    { label: 'gm.demo.scen.la.zero',    spec: FUNDLA_ZERO },
  ],
};

// =====================================================================================
// MOVING — transfer with live recipient safety checks (Creatures zkEVM / LAND mainnet)
// =====================================================================================

function makeMovingSpec(coll) {
  const land = coll === 'land';
  const k = suffix => land ? `${suffix}.land` : suffix;
  const owned = land
    ? FIX_SLIMES.slice(0, 3).map((f, i) => ({ art: artImg(f, 'slime', i, 'is-pet'), label: `${f.nick} — ${f.coords}` }))
    : FIX_CREATURES.slice(0, 3).map((f, i) => ({ art: artImg(f, 'creature', i, ''), label: f.name.replace('Creature ', '') }));
  // Mirrors the live transferCheckHtml row markup (.trade-check-row, not .trade-status).
  // `art` is built markup, not a glyph — and NOT called `ico`, which would shadow the icon
  // helper for anything later added to this body.
  const checkRow = (kind, art, txt) =>
    `<div class="trade-check-row is-${kind}"><span aria-hidden="true">${art}</span><span>${txt}</span></div>`;
  const checksOk = () =>
    checkRow('ok', ico('check', 15), t('trade.check.checksumOk'))
    + checkRow('ok', ico('check', 15), t(k('trade.check.active')))
    + checkRow('ok', ico('check', 15), rep(k('trade.check.holds'), { n: land ? 1 : 2 }));

  return {
    title: land ? 'gm.demo.title.movingLand' : 'gm.demo.title.movingCreatures',
    steps: [
      { label: 'gm.demo.beat.pick',   cap: land ? 'gm.demo.movela.cap.pick' : 'gm.demo.move.cap.pick' },
      { label: 'gm.demo.beat.paste',  cap: land ? 'gm.demo.movela.cap.paste' : 'gm.demo.move.cap.paste' },
      { label: 'gm.demo.beat.checks', cap: land ? 'gm.demo.movela.cap.checks' : 'gm.demo.move.cap.checks' },
      { label: 'gm.demo.beat.send',   cap: land ? 'gm.demo.movela.cap.send' : 'gm.demo.move.cap.send' },
    ],
    stageHtml() {
      return (land ? barOnHtml('land', { eth: '0.31', count: 2 }) : barOnHtml('creatures', { eth: '0.084', imx: '12.4', count: 3 }))
        + `<div class="trade-workbench gdemo-wb">
          <div class="trade-wb-main">
            <h4 class="trade-form-h">${t(k('trade.transfer.h'))}</h4>
            <span class="trade-field-label">${t(k('trade.transfer.pick'))}</span>
            <div class="trade-pick gdemo-pick">
              ${owned.map((o, i) => `<button class="trade-pick-tile" data-gd-pick="${i}" type="button" tabindex="-1">${o.art}<span>${o.label}</span></button>`).join('')}
            </div>
          </div>
          <div class="trade-wb-side">
            <div class="trade-form">
              <label class="trade-field"><span>${t(k('trade.field.recipient'))}</span>
                <input class="gdemo-addr" data-gd="addr" type="text" placeholder="0x…" readonly tabindex="-1" /></label>
              <div data-gd="checks"></div>
              <button class="trade-send" data-gd="send" type="button" tabindex="-1" disabled>${t(k('trade.transfer.btn'))} <span aria-hidden="true">→</span></button>
              <div class="gdemo-status" data-gd="status"></div>
            </div>
          </div>
        </div>`
        + walletMockHtml({ rows: [
            [t('gm.demo.w.network'), land ? 'Ethereum' : 'Immutable zkEVM'],
            [t('gm.demo.w.item'), land ? 'LAND (167, 164)' : 'Creature #6110'],
            [t('gm.demo.w.gas'), land ? '~0.0011 ETH' : '~0.0002 IMX'],
          ] });
    },
    endState(ctx, b) {
      const { stage } = ctx;
      stage.classList.remove('w-open');
      stage.querySelectorAll('[data-gd-pick]').forEach((el, i) =>
        el.classList.toggle('is-sel', b >= 0 && i === 1));
      const addr = stage.querySelector('[data-gd="addr"]');
      addr.value = b === 1 ? ADDR_BAD : b >= 2 ? ADDR_GOOD : '';
      const checks = stage.querySelector('[data-gd="checks"]');
      checks.innerHTML =
        b === 1 ? `<div class="trade-check-row is-err"><span aria-hidden="true">${ico('block', 15)}</span><span>${t('trade.check.checksumBad')}</span></div>`
        : b >= 2 ? checksOk()
        : '';
      const send = stage.querySelector('[data-gd="send"]');
      send.disabled = b < 2;
      const status = stage.querySelector('[data-gd="status"]');
      status.innerHTML = b >= 3
        ? row.ok(`${t('gm.demo.sent')} <span class="gdemo-fauxlink">${t('trade.status.view')} ${ico('external', 12)}</span>`)
        : '';
    },
    async choreo(ctx, b) {
      const { stage, go, click, sleep, ok, type, say } = ctx;
      const addr = stage.querySelector('[data-gd="addr"]');
      const checks = stage.querySelector('[data-gd="checks"]');
      if (b === 0) {
        await say('gm.demo.n.pick');
        const tile = stage.querySelector('[data-gd-pick="1"]');
        await sleep(400); if (!ok()) return;
        await go(tile, 900); if (!ok()) return;
        await click(tile); if (!ok()) return;
        tile.classList.add('is-sel');
        await sleep(700);
      } else if (b === 1) {
        await say('gm.demo.n.paste');
        await go(addr, 850); if (!ok()) return;
        await type(addr, ADDR_BAD); if (!ok()) return;
        await say('gm.demo.n.checking');
        checks.innerHTML = `<div class="trade-check-row is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${t(k('trade.check.checking'))}</span></div>`;
        await sleep(900); if (!ok()) return;
        await say('gm.demo.n.badaddr');
        checks.innerHTML = pop(`<div class="trade-check-row is-err"><span aria-hidden="true">${ico('block', 15)}</span><span>${t('trade.check.checksumBad')}</span></div>`);
        await sleep(1200);
      } else if (b === 2) {
        await say('gm.demo.n.retype');
        await go(addr, 700); if (!ok()) return;
        await type(addr, ADDR_GOOD); if (!ok()) return;
        await say('gm.demo.n.checking');
        checks.innerHTML = `<div class="trade-check-row is-info"><span class="trade-mini-spin" aria-hidden="true"></span><span>${t(k('trade.check.checking'))}</span></div>`;
        await sleep(900); if (!ok()) return;
        await say('gm.demo.n.green');
        checks.innerHTML = pop(checksOk());
        stage.querySelector('[data-gd="send"]').disabled = false;
        await sleep(1000);
      } else if (b === 3) {
        const send = stage.querySelector('[data-gd="send"]');
        const status = stage.querySelector('[data-gd="status"]');
        await say('gm.demo.n.send');
        await go(send, 850); if (!ok()) return;
        await click(send); if (!ok()) return;
        await say('gm.demo.n.walletSend');
        stage.classList.add('w-open');
        const wc = stage.querySelector('[data-gd="wconfirm"]');
        await go(wc, 800); if (!ok()) return;
        await sleep(400); if (!ok()) return;
        await click(wc); if (!ok()) return;
        stage.classList.remove('w-open');
        await say('gm.demo.n.sending');
        status.innerHTML = row.info(t('gm.demo.sending'));
        await sleep(1100); if (!ok()) return;
        status.innerHTML = row.ok(`${t('gm.demo.sent')} <span class="gdemo-fauxlink">${t('trade.status.view')} ${ico('external', 12)}</span>`);
      }
    },
  };
}

// =====================================================================================
// SETUP — connect → safety primer → network → ready (Creatures zkEVM / LAND mainnet)
// =====================================================================================

function makeSetupSpec(coll) {
  const land = coll === 'land';
  const netName = land ? t('trade.net.eth') : t('trade.net.ok');

  const safetyHtml = () => `<div class="gdemo-safety" data-gd="safety">
    <div class="trade-safety-card gdemo-safety-card">
      <span class="apply-pill">${t('trade.safety.badge')}</span>
      <h3 class="trade-safety-h">${t('trade.safety.h')}</h3>
      <ul class="trade-safety-rules">
        ${[['shield', 1], ['chat', 2], ['search', 3], ['chain', 4]].map(([art, i], idx) => `
          <li style="--i:${idx}"><span class="trade-safety-ico" aria-hidden="true">${ico(art, 24)}</span>
          <div><b>${t(`trade.safety.r${i}h`)}</b></div></li>`).join('')}
      </ul>
      <div class="trade-safety-track" aria-hidden="true"><div class="trade-safety-barfill" data-gd="sbar" style="width:0%"></div></div>
      <div class="trade-safety-actions">
        <button class="trade-send trade-safety-ok" data-gd="sok" type="button" tabindex="-1" disabled>${t('trade.safety.ok')} · 30s</button>
      </div>
      <p class="gdemo-safety-sped">${spedChip()}</p>
    </div>
  </div>`;

  return {
    title: land ? 'gm.demo.title.setupLand' : 'gm.demo.title.setupCreatures',
    steps: [
      { label: 'gm.demo.beat.connect', cap: land ? 'gm.demo.setup.cap.connectLand' : 'gm.demo.setup.cap.connect' },
      { label: 'gm.demo.beat.safety',  cap: 'gm.demo.setup.cap.safety' },
      { label: 'gm.demo.beat.network', cap: land ? 'gm.demo.setup.cap.networkLand' : 'gm.demo.setup.cap.network' },
      { label: 'gm.demo.beat.ready',   cap: land ? 'gm.demo.setup.cap.readyLand' : 'gm.demo.setup.cap.ready' },
    ],
    stageHtml() {
      const tiles = (land ? FIX_SLIMES : FIX_CREATURES).slice(0, 3).map((f, i) => `
        <div class="trade-tile gdemo-tile is-dim">
          <div class="trade-tile-media">${artImg(f, land ? 'slime' : 'creature', i, land ? 'trade-tile-img is-pet' : 'trade-tile-img')}</div>
          <div class="trade-tile-body"><span class="trade-tile-name">${land ? f.nick : f.name}</span>
          <span class="trade-tile-price">${f.eth}</span></div>
        </div>`).join('');
      return `<div data-gd="bar">${barOffHtml()}</div>`
        + `<div class="gdemo-panel" data-gd="panel"></div>`
        + `<div class="trade-grid gdemo-grid">${tiles}</div>`
        + safetyHtml()
        + walletMockHtml({ rows: [
            [t('gm.demo.w.site'), t('gm.demo.w.thisSite')],
            [t('gm.demo.w.action'), t('gm.demo.w.connectAcct')],
            [t('gm.demo.w.network'), land ? netName : `+ ${netName}`],
          ], confirm: t('gm.demo.w.approve') });
    },
    // endState = a CLEAN base (no transient overlay), so a loop reset never leaves a
    // stale sheet from the previous step. Each step's own overlay is opened by its
    // choreo; `settle` adds it for jumps / reduced motion where choreo doesn't run.
    endState(ctx, b) {
      const { stage } = ctx;
      stage.classList.remove('safety-open', 'w-open');
      const bar = stage.querySelector('[data-gd="bar"]');
      bar.innerHTML = b >= 3
        ? barOnHtml(coll, land ? { eth: '0.31', count: 2 } : { eth: '0.084', imx: '12.4', count: 3 })
        : barOffHtml();
      stage.querySelectorAll('.gdemo-tile').forEach(el => el.classList.toggle('is-dim', b < 3));
      const sbar = stage.querySelector('[data-gd="sbar"]'); if (sbar) sbar.style.width = '0%';
      const sok = stage.querySelector('[data-gd="sok"]');
      if (sok) { sok.disabled = true; sok.textContent = `${t('trade.safety.ok')} · 30s`; }
      const panel = stage.querySelector('[data-gd="panel"]');
      panel.innerHTML = b >= 3 ? row.ok(t(land ? 'gm.demo.setup.doneLand' : 'gm.demo.setup.done')) : '';
    },
    settle(ctx, b) {
      this.endState(ctx, b);
      const { stage } = ctx;
      if (b === 1) {
        stage.classList.add('safety-open');
        const sbar = stage.querySelector('[data-gd="sbar"]'); if (sbar) sbar.style.width = '100%';
        const sok = stage.querySelector('[data-gd="sok"]');
        if (sok) { sok.disabled = false; sok.textContent = t('trade.safety.ok'); }
      } else if (b === 2) {
        stage.classList.add('w-open');
      }
    },
    async choreo(ctx, b) {
      const { stage, go, click, sleep, ok, tick, say } = ctx;
      // Each step touches ONLY its own screen. The result of a tap (the NEXT screen)
      // is never shown here — it's the next step's subject — so no play, first or
      // looped, ever bleeds one step's UI into another.
      if (b === 0) {
        // Connect screen: just tap Connect MetaMask.
        await say('gm.demo.n.connect');
        const btn = stage.querySelector('[data-gd="connect"]');
        await sleep(300); if (!ok()) return;
        await go(btn); if (!ok()) return;
        await click(btn); if (!ok()) return;
        await sleep(500);
      } else if (b === 1) {
        // Safety screen: the sheet is this step's subject — read the rules, wait out
        // the timer, tap "I've got it". The wallet it unlocks belongs to step 3.
        stage.classList.add('safety-open');
        const sbar = stage.querySelector('[data-gd="sbar"]');
        const sok = stage.querySelector('[data-gd="sok"]');
        if (sbar) sbar.style.width = '0%';
        if (sok) { sok.disabled = true; }
        await say('gm.demo.n.timer');
        await sleep(300); if (!ok()) return;
        if (sbar) sbar.style.width = '100%'; // CSS transition sweeps it
        await tick(sok, ['3s', '2s', '1s'].map(s => `${t('trade.safety.ok')} · ${s}`), 600); if (!ok()) return;
        sok.textContent = t('trade.safety.ok');
        sok.disabled = false;
        await go(sok); if (!ok()) return;
        await click(sok); if (!ok()) return;
        await sleep(500);
      } else if (b === 2) {
        // Wallet screen: approve the connection + network. The bar coming online is
        // the "Ready" screen — step 4's subject, not shown here.
        stage.classList.add('w-open');
        await say('gm.demo.n.walletConnect');
        const wc = stage.querySelector('[data-gd="wconfirm"]');
        await sleep(300); if (!ok()) return;
        await go(wc); if (!ok()) return;
        await click(wc); if (!ok()) return;
        await sleep(500);
      } else if (b === 3) {
        // A reveal step (no tap): balances stream in. Watch, don't loop.
        await say('gm.demo.n.balances');
        const bar = stage.querySelector('[data-gd="bar"]');
        await sleep(500); if (!ok()) return;
        bar.innerHTML = barOnHtml(coll, land ? { eth: '0.31', count: '—' } : { eth: '0.084', imx: '—', count: '—' });
        await sleep(450); if (!ok()) return;
        bar.innerHTML = barOnHtml(coll, land ? { eth: '0.31', count: 2 } : { eth: '0.084', imx: '12.4', count: 3 });
        stage.querySelector('[data-gd="panel"]').innerHTML =
          pop(row.ok(t(land ? 'gm.demo.setup.doneLand' : 'gm.demo.setup.done')));
        await sleep(900);
      }
    },
  };
}

// =====================================================================================
// IN-GAME — link the wallet on highrise.game, sign, enjoy the perks
// =====================================================================================

function makeIngameSpec(coll) {
  const land = coll === 'land';
  const art = land
    ? artImg(FIX_SLIMES[0], 'slime', 0, 'gdemo-medal-img is-pet')
    : artImg(FIX_CREATURES[0], 'creature', 0, 'gdemo-medal-img');
  // One parallel perk list for both collections — only the first line is
  // collection-specific; Coins, drops and Discord access are shared club perks.
  const perkKeys = [
    land ? 'gm.demo.perks.la1' : 'gm.demo.perks.cr1',
    'gm.demo.perks.coins',
    'gm.demo.perks.drops',
    'gm.demo.perks.chat',
  ];
  const capBase = land ? 'gm.game.la' : 'gm.game.cr';

  const appHtml = linked => `<div class="gdemo-app">
    <div class="gdemo-app-head"><img class="gdemo-app-logo" src="/img/brands/highrise.png" alt="" />highrise.game · Settings</div>
    <div class="gdemo-app-row is-dim"><span>Account</span></div>
    <div class="gdemo-app-row is-dim"><span>Notifications</span></div>
    <div class="gdemo-app-row">
      <span>Wallet</span>
      ${linked
        ? `<span class="gdemo-app-linked">${ico('check', 13)} <code>${DEMO_ADDR}</code> · ${t('gm.demo.linked')}</span>`
        : `<button class="trade-mm-btn is-sm" data-gd="hrconnect" type="button" tabindex="-1">
            <img class="trade-mm-logo" src="/img/brands/metamask.svg" alt="" /><span>Connect MetaMask Wallet</span></button>`}
    </div>
  </div>`;

  return {
    title: land ? 'gm.demo.title.ingameLand' : 'gm.demo.title.ingameCreatures',
    steps: [
      { label: 'gm.demo.beat.link',  cap: `${capBase}.s1` },
      { label: 'gm.demo.beat.sign',  cap: `${capBase}.s2` },
      { label: 'gm.demo.beat.enjoy', cap: `${capBase}.s3` },
    ],
    stageHtml() {
      return `<div class="gdemo-panel" data-gd="app">${appHtml(false)}</div>`
        + walletMockHtml({
            title: t('gm.demo.w.sign'),
            rows: [
              [t('gm.demo.w.origin'), 'highrise.game'],
              [t('gm.demo.w.message'), t('gm.demo.w.proveMsg')],
              [t('gm.demo.w.cost'), t('gm.demo.w.free')],
            ],
            confirm: t('gm.demo.w.signBtn'),
          })
        + `<div class="gdemo-perks" data-gd="perks">
            <div class="gdemo-success-art">${art}</div>
            <h4>${t('gm.demo.perks.h')}</h4>
            <div class="gdemo-perkchips">${perkKeys.map(k2 => `<span>${ico('check', 13)} ${t(k2)}</span>`).join('')}</div>
            <span class="gdemo-spark" style="--sx:24%;--sy:26%;--sc:var(--hr-primary)"></span>
            <span class="gdemo-spark" style="--sx:74%;--sy:30%;--sc:var(--hr-banana);--sd:.4s"></span>
            <span class="gdemo-spark" style="--sx:70%;--sy:66%;--sc:var(--hr-secondary);--sd:.8s"></span>
          </div>`;
    },
    endState(ctx, b) {
      const { stage } = ctx;
      stage.classList.toggle('w-open', b === 0);
      stage.classList.toggle('perks-open', b >= 2);
      stage.querySelector('[data-gd="app"]').innerHTML = appHtml(b >= 1);
    },
    async choreo(ctx, b) {
      const { stage, go, click, sleep, ok, say } = ctx;
      if (b === 0) {
        await say('gm.demo.n.applink');
        const btn = stage.querySelector('[data-gd="hrconnect"]');
        await sleep(400); if (!ok()) return;
        await go(btn, 900); if (!ok()) return;
        await click(btn); if (!ok()) return;
        await say('gm.demo.n.sign');
        stage.classList.add('w-open');
        await sleep(700);
      } else if (b === 1) {
        await say('gm.demo.n.sign');
        const wc = stage.querySelector('[data-gd="wconfirm"]');
        await sleep(400); if (!ok()) return;
        await go(wc, 850); if (!ok()) return;
        await click(wc); if (!ok()) return;
        stage.classList.remove('w-open');
        stage.querySelector('[data-gd="app"]').innerHTML = pop(appHtml(true));
        await sleep(700);
      } else if (b === 2) {
        await sleep(600); if (!ok()) return;
        stage.classList.add('perks-open');
      }
    },
  };
}

const DEMOS = {
  'trading-creatures': TRADING_CREATURES,
  'trading-land': TRADING_LAND,
  'funding-creatures': FUNDING_CREATURES,
  'funding-land': FUNDING_LAND,
  'cashout-creatures': CASH_MOVE,
  'cashout-land': FUNDLA_CASHOUT,
  'moving-creatures': makeMovingSpec('creatures'),
  'moving-land': makeMovingSpec('land'),
  'setup-creatures': makeSetupSpec('creatures'),
  'setup-land': makeSetupSpec('land'),
  'ingame-creatures': makeIngameSpec('creatures'),
  'ingame-land': makeIngameSpec('land'),
};

// --- Frame + driver -----------------------------------------------------------------

const CHEVRON = dir => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
  <path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"
    d="${dir < 0 ? 'M14.5 6 9 12l5.5 6' : 'M9.5 6 15 12l-5.5 6'}"/></svg>`;

function frameHtml(spec) {
  return `<div class="gdemo-chrome">
      <span class="gdemo-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="gdemo-title">${t(spec.title)}</span>
      <span class="gdemo-badge">${t('gm.demo.badge')}</span>
    </div>
    <div class="gdemo-stagewrap">
      <div class="gdemo-stage" aria-hidden="true">${spec.stageHtml()}
        <div class="gdemo-cursor" data-gd="cursor" aria-hidden="true"></div>
        <div class="gdemo-intro" data-gd="intro">
          <span class="gdemo-intro-eye" data-gd="intro-eye"></span>
          <span class="gdemo-intro-h" data-gd="intro-h"></span>
        </div>
      </div>
      <button class="gdemo-nav is-prev" data-gd="navprev" type="button" aria-label="${t('gm.demo.back')}">${CHEVRON(-1)}</button>
      <button class="gdemo-nav is-next" data-gd="navnext" type="button" aria-label="${t('gm.demo.next')}">${CHEVRON(1)}</button>
    </div>
    <div class="gdemo-substrip"><span class="gdemo-sub" data-gd="sub"></span></div>
    <div class="gdemo-rail">
      <div class="gdemo-railtop">
        <span class="gdemo-beats" data-gd="beats" role="group" aria-label="${t('gm.demo.beatsAria')}"></span>
        <span class="gdemo-ctrl">
          <button class="gdemo-replay" data-gd="replay" type="button" title="${t('gm.demo.replay')}" aria-label="${t('gm.demo.replay')}">↻</button>
          <button class="gdemo-back" data-gd="back" type="button">← ${t('gm.demo.back')}</button>
          <button class="gdemo-next" data-gd="next" type="button">${t('gm.demo.next')} →</button>
        </span>
      </div>
      <div class="gdemo-steptext">
        <span class="gdemo-stepeye" data-gd="stepeye"></span>
        <p class="gdemo-captext" data-gd="cap" aria-live="polite"></p>
      </div>
    </div>`;
}

// `host` defaults to the mount; scenario demos pass an inner element so the scenario
// bar above survives rebuilds. Visibility is always judged on the whole mount.
function createDemo(mount, spec, host = mount, opts = {}) {
  // `auto` = first-visit guided tour: after each step settles, the next one starts on
  // its own — exactly once through. Any user interaction (pills, Next/Back, chevrons,
  // swipe, replay) or finishing the tour hands control over to the manual model for good.
  const inst = { gen: 0, step: 0, visible: false, started: false, dirty: false, auto: true };
  let stage, cursor, capEl, eyeEl, beatsEl, backBtn, nextBtn, replayBtn, navPrev, navNext,
    intro, introEye, introH, subEl;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let primed = false;   // has the cursor appeared at origin A yet this run?

  // Origin A — a fixed lower-left spot, so every gesture reads as the same journey.
  function originA() {
    const s = stage.getBoundingClientRect();
    return { x: s.width * 0.13, y: s.height * 0.84 };
  }
  function place(x, y, instant) {
    if (!cursor) return;
    if (instant) cursor.classList.add('is-instant');
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    if (instant) { void cursor.offsetWidth; cursor.classList.remove('is-instant'); }
  }
  function moveCursor(el) {
    if (!el || !cursor) return;
    const s = stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    place(r.left - s.left + r.width / 2 - 11, r.top - s.top + r.height / 2 - 11, false);
  }
  function hideCursor() { cursor?.classList.remove('is-shown'); primed = false; }
  function tapPulse() {
    if (!cursor) return;
    cursor.classList.remove('is-click');
    void cursor.offsetWidth;
    cursor.classList.add('is-click');
  }
  const ctx = {
    get stage() { return stage; },
    sleep,
    ok: () => false, // replaced per run
    // Glide to a target. The FIRST go() of a run reveals the cursor at origin A and
    // pauses a beat, so the move always reads as a clean A → B journey (~0.5s).
    async go(el, ms = 520) {
      if (!el || !cursor) return;
      if (!primed) {
        const a = originA();
        place(a.x, a.y, true);
        cursor.classList.add('is-shown');
        primed = true;
        await sleep(280); if (!ctx.ok()) return;
      }
      moveCursor(el);
      await sleep(ms);
    },
    // Arrive, hold ~1s so the eye lands on the target, then one clean tap.
    async click(el) {
      ctx.clicked = true;
      await sleep(950); if (!ctx.ok()) return;
      tapPulse();
      el?.classList.add('is-press');
      await sleep(220);
      el?.classList.remove('is-press');
      await sleep(320);
    },
    // Typewriter into an input's value; chunked so long addresses stay quick.
    async type(el, text, msPerTick = 26) {
      if (!el) return;
      el.value = '';
      for (let i = 3; i < text.length; i += 3) {
        el.value = text.slice(0, i);
        await sleep(msPerTick);
        if (!ctx.ok()) return;
      }
      el.value = text;
    },
    // Sequential text updates (clocks, countdowns). A step that ticks is a "watch"
    // step — a timeline to observe, not a gesture — so it plays once and never loops.
    async tick(el, values, ms = 380) {
      ctx.usedTick = true;
      for (const v of values) {
        if (!ctx.ok()) return;
        if (el) el.textContent = v;
        await sleep(ms);
      }
    },
    // Live subtitle narrating the current micro-action. Reading-speed aware: every line
    // earns a minimum on-screen time from its word count, and the NEXT say() awaits it —
    // so the choreography paces itself to the reader, and no caption can blink away.
    // ('' fades the bar, also only after the current line was readable.) The rail caption
    // stays the accessible text (the stage is aria-hidden), so this never double-speaks.
    async say(key) {
      if (!subEl) return;
      const remain = subShownAt + subMinMs - Date.now();
      if (remain > 0) { await sleep(remain); if (!ctx.ok()) return; }
      if (!key) { subEl.classList.remove('is-in'); subMinMs = 0; return; }
      const text = t(key);
      // On a repeat loop the caption is already understood — keep it steady and don't
      // block the tight gesture with a full re-read.
      if (ctx.looping && subEl.textContent === text) { subShownAt = Date.now(); subMinMs = 500; return; }
      subEl.textContent = text;
      subEl.classList.remove('is-in');
      void subEl.offsetWidth; // restart the entrance so each new line visibly pops
      subEl.classList.add('is-in');
      subShownAt = Date.now();
      subMinMs = ctx.looping ? 700 : Math.min(6800, Math.max(1800, 800 + text.split(/\s+/).length * 240));
    },
  };
  let subShownAt = 0, subMinMs = 0;
  // Instant, unconditional reset — used between steps where the scene rebuilds anyway.
  function clearSub() {
    subEl?.classList.remove('is-in');
    subShownAt = 0;
    subMinMs = 0;
  }

  // The cursor never rests on an actionable step: after the first play it re-runs the
  // step's own gesture on a loop — reset the scene, cursor back to origin A, glide to
  // the target, hold, tap — so "where do I go and what do I press" is drilled by honest
  // repetition. Watch steps (a timeline to observe) and pure reveals don't loop.
  async function loopStep(g, b) {
    ctx.looping = true;
    while (g === inst.gen) {
      await sleep(1100);                       // rest a beat on the finished result
      if (g !== inst.gen) break;
      spec.endState(ctx, b - 1);               // reset the scene to before this step
      hideCursor();                            // cursor vanishes; next go() re-enters at A
      await sleep(300);
      if (g !== inst.gen) break;
      ctx.ok = () => g === inst.gen;
      ctx.clicked = false; ctx.usedTick = false;
      await spec.choreo(ctx, b);               // replay the gesture from A
    }
    ctx.looping = false;
  }

  function syncRail() {
    const b = inst.step;
    const total = spec.steps.length;
    beatsEl.querySelectorAll('.gdemo-beat').forEach((d, i) => {
      d.classList.toggle('is-on', i === b);
      d.classList.toggle('is-done', i < b);
      d.setAttribute('aria-pressed', String(i === b));
    });
    eyeEl.textContent = t('gm.demo.step').replace('{n}', String(b + 1)).replace('{t}', String(total))
      + ' · ' + t(spec.steps[b].label);
    capEl.textContent = t(spec.steps[b].cap);
    backBtn.disabled = b === 0;
    nextBtn.textContent = b === total - 1 ? `↻ ${t('gm.demo.restart')}` : `${t('gm.demo.next')} →`;
    // Edge chevrons show only where there IS a previous/next step to go to.
    navPrev.hidden = b === 0;
    navNext.hidden = b === total - 1;
  }

  function setCue(on) {
    navNext.classList.toggle('is-cue', on);
    nextBtn.classList.toggle('is-cue', on);
  }

  // Title card over the blurred scene: "STEP n OF t / <Label>", holds a beat, fades,
  // and only then does the choreography start. Cancelled cleanly by any step change.
  async function playIntro(b, g) {
    introEye.textContent = t('gm.demo.step')
      .replace('{n}', String(b + 1)).replace('{t}', String(spec.steps.length));
    introH.textContent = t(spec.steps[b].label);
    intro.classList.add('is-in');
    await sleep(1500);
    intro.classList.remove('is-in');
    if (g !== inst.gen) return false;
    await sleep(380); // let the blur clear before the cursor moves
    return g === inst.gen;
  }

  // Enter a step: settle the PREVIOUS step's scene, introduce the step with its title
  // card, then play this step's animation once (skipped under reduced motion or
  // off-screen — the settled scene shows instead). When the animation finishes, the
  // Next affordances pulse: "your move".
  async function enterStep(b) {
    const g = ++inst.gen;
    inst.step = b;
    setCue(false);
    syncRail();
    if (motionOK() && inst.visible) {
      spec.endState(ctx, b - 1);
      clearSub();                       // fresh step starts clean under its title card
      hideCursor();                     // cursor is absent until the gesture calls go()
      ctx.clicked = false; ctx.usedTick = false; ctx.looping = false;
      inst.dirty = true;
      ctx.ok = () => g === inst.gen;
      if (!await playIntro(b, g)) return;
      await spec.choreo(ctx, b);
      if (g !== inst.gen) return;
      inst.dirty = false;
      // The last narration line PERSISTS on the settled scene — vanishing text was the
      // #1 readability complaint. The next step (or a jump) clears it.
    } else {
      // Reduced motion / off-screen: show the step's representative scene (settle opens
      // the step's own overlay where endState is only a clean base).
      (spec.settle ? spec.settle(ctx, b) : spec.endState(ctx, b));
      clearSub();
      hideCursor();
      inst.dirty = false;
      inst.auto = false; // reduced motion / off-screen: never tour
    }
    setCue(true);
    // A step that ended in a tap (and isn't a watch/timeline step) keeps demonstrating
    // its gesture on a loop until the user moves on. Recorded during the choreo above.
    const loopable = motionOK() && inst.visible && ctx.clicked && !ctx.usedTick;
    // First-visit tour: linger on the settled scene — at least 1.6s, and never less
    // than the final narration line still needs to be read — then continue on its own.
    if (inst.auto && motionOK() && inst.visible) {
      if (b < spec.steps.length - 1) {
        await sleep(Math.max(1600, subShownAt + subMinMs - Date.now()));
        if (g !== inst.gen || !inst.auto) return;
        enterStep(b + 1);
        return;
      }
      inst.auto = false; // tour done — fall through and loop the last step in place
    }
    if (loopable) loopStep(g, b);
    else hideCursor(); // a non-looping settled step shows no stray cursor
  }

  function build() {
    host.innerHTML = frameHtml(spec);
    stage     = host.querySelector('.gdemo-stage');
    cursor    = host.querySelector('[data-gd="cursor"]');
    capEl     = host.querySelector('[data-gd="cap"]');
    eyeEl     = host.querySelector('[data-gd="stepeye"]');
    beatsEl   = host.querySelector('[data-gd="beats"]');
    backBtn   = host.querySelector('[data-gd="back"]');
    nextBtn   = host.querySelector('[data-gd="next"]');
    replayBtn = host.querySelector('[data-gd="replay"]');
    navPrev   = host.querySelector('[data-gd="navprev"]');
    navNext   = host.querySelector('[data-gd="navnext"]');
    intro     = host.querySelector('[data-gd="intro"]');
    introEye  = host.querySelector('[data-gd="intro-eye"]');
    introH    = host.querySelector('[data-gd="intro-h"]');
    subEl     = host.querySelector('[data-gd="sub"]');
    spec.steps.forEach((st, i) => {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'gdemo-beat';
      d.innerHTML = `<span class="gdemo-beat-n" aria-hidden="true">${i + 1}</span>${t(st.label)}`;
      d.setAttribute('aria-pressed', String(i === inst.step));
      d.addEventListener('click', () => { inst.auto = false; enterStep(i); });
      beatsEl.appendChild(d);
    });
    // Any explicit navigation ends the first-visit tour — the user is driving now.
    const goPrev = () => { inst.auto = false; if (inst.step > 0) enterStep(inst.step - 1); };
    const goNext = () => { inst.auto = false; enterStep((inst.step + 1) % spec.steps.length); };
    backBtn.addEventListener('click', goPrev);
    nextBtn.addEventListener('click', goNext);
    replayBtn.addEventListener('click', () => { inst.auto = false; enterStep(inst.step); });
    navPrev.addEventListener('click', goPrev);
    navNext.addEventListener('click', goNext);

    // Swipe between steps: horizontal pointer gestures on the stage (touch-first, but
    // a mouse drag works too). Vertical intent is left alone so page scroll survives —
    // touch-action: pan-y on the wrap does the same for the browser's gesture handling.
    const wrap = host.querySelector('.gdemo-stagewrap');
    let swipe = null;
    // A mouse drag must not start a text selection that bleeds into the page around
    // the demo (the wrap itself is already user-select: none).
    wrap.addEventListener('mousedown', e => e.preventDefault());
    wrap.addEventListener('pointerdown', e => {
      swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
    });
    wrap.addEventListener('pointerup', e => {
      if (!swipe || e.pointerId !== swipe.id) { swipe = null; return; }
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) goNext(); else goPrev();
      }
    });
    wrap.addEventListener('pointercancel', () => { swipe = null; });

    // Before the first play, rest on the untouched scene — the step's own animation is
    // what changes it. After that (e.g. a language-switch rebuild), rest on the settled
    // scene of the current step.
    spec.endState(ctx, inst.started ? inst.step : inst.step - 1);
    syncRail();

    // "Next guide" button, dropped beside the demo's own controls so "Watch again" and
    // "Up next" sit together. It proxies the card's real footer CTA (already wired by
    // app.js), so all step navigation stays in one place. Re-created on every build, so
    // it survives scenario switches and language rebuilds.
    if (opts.nextBtn) {
      const ctrl = host.querySelector('.gdemo-ctrl');
      if (ctrl) {
        const proxy = document.createElement('button');
        proxy.type = 'button';
        proxy.className = 'gdemo-nextguide';
        proxy.innerHTML = opts.nextBtn.innerHTML;
        proxy.addEventListener('click', () => opts.nextBtn.click());
        ctrl.appendChild(proxy);
      }
    }
  }
  build();

  // First scroll-in plays step 1 once a quarter of the demo is visible. Only a FULLY
  // off-screen demo cancels a running animation — a user driving Next/swipe while the
  // demo pokes past the fold must never have their step killed mid-play (leaving and
  // coming back replays the interrupted step so the scene never rests half-done).
  let io = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(entries => {
      const e = entries[0];
      inst.visible = e.isIntersecting;
      if (e.isIntersecting && e.intersectionRatio >= 0.25 && (!inst.started || inst.dirty)) {
        inst.started = true;
        enterStep(inst.step);
      } else if (!e.isIntersecting) {
        inst.gen++; // cancel any running choreography
      }
    }, { threshold: [0, 0.26] });
    io.observe(mount);
  } else {
    inst.visible = true;
    inst.started = true;
    enterStep(inst.step);
  }

  inst.rerender = () => {
    inst.gen++;
    build();
    // If the first-visit tour is still meant to be running — on screen and not yet taken
    // over by the user — (re)start it. The initial i18n rerender fires just as the observer
    // kicks off step one, so without this the freshly-started tour is torn down and the demo
    // sits frozen until Next/Replay (the deep-link/reload freeze). A settled or user-driven
    // demo (auto=false) rebuilds rested, so a mid-read language switch still never replays.
    if (inst.auto && inst.visible && motionOK()) enterStep(inst.step);
  };
  inst.destroy = () => {
    inst.gen++;
    io?.disconnect();
  };
  return inst;
}

// A demo with a "pick your situation" bar: each scenario is a full spec played in the
// same frame. Selecting one is an explicit "show me this" — it auto-tours once, then
// the manual model applies as usual.
function createScenarioDemo(mount, multi, opts = {}) {
  const outer = { active: 0, inner: null };

  function build() {
    mount.innerHTML = `
      <div class="gdemo-scenbar">
        <span class="gdemo-scenlbl">${t('gm.demo.scen.pick')}</span>
        <span class="gdemo-scens" role="group" aria-label="${t('gm.demo.scen.pick')}"></span>
      </div>
      <div class="gdemo-scenhost"></div>`;
    const chipsEl = mount.querySelector('.gdemo-scens');
    multi.scenarios.forEach((sc, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gdemo-scen';
      b.textContent = t(sc.label);
      b.setAttribute('aria-pressed', String(i === outer.active));
      b.addEventListener('click', () => select(i));
      chipsEl.appendChild(b);
    });
    syncChips();
  }
  function syncChips() {
    mount.querySelectorAll('.gdemo-scen').forEach((b, i) => {
      b.classList.toggle('is-on', i === outer.active);
      b.setAttribute('aria-pressed', String(i === outer.active));
    });
  }
  function select(i) {
    outer.active = i;
    syncChips();
    outer.inner?.destroy();
    const host = mount.querySelector('.gdemo-scenhost');
    host.innerHTML = '';
    outer.inner = createDemo(mount, multi.scenarios[i].spec, host, opts);
  }
  build();
  select(0);

  outer.rerender = () => {
    outer.inner?.destroy();
    build();
    select(outer.active);
  };
  return outer;
}

const instances = [];

export function initGuideDemos() {
  document.querySelectorAll('[data-gdemo]').forEach(mount => {
    const spec = DEMOS[mount.dataset.gdemo];
    if (!spec || mount.dataset.gdInit) return;
    mount.dataset.gdInit = '1';
    // A failed image (CDN change, offline) swaps back to the inline blob art — a guide
    // demo must never show a broken image. Capture phase: error events don't bubble.
    mount.addEventListener('error', e => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG' || !img.dataset.gdFb) return;
      const [kind, color, seed] = img.dataset.gdFb.split('|');
      const holder = document.createElement('span');
      holder.innerHTML = kind === 'slime' ? slimeSvg(color, Number(seed)) : creatureSvg(color, Number(seed));
      img.replaceWith(holder.firstElementChild);
    }, true);
    // Give the demo its card's forward CTA so it can show an "up next" button beside its
    // own "Watch again" control; then hide the original footer button it proxies. (Two
    // demos per card share one footer, so each just proxies the same wired button.)
    const card = mount.closest('.wt-panel');
    const nextBtn = card && card.querySelector('.gm-cardfoot [data-wt-cta], .gm-cardfoot [data-goto]');
    const opts = { nextBtn };
    instances.push(spec.scenarios ? createScenarioDemo(mount, spec, opts) : createDemo(mount, spec, mount, opts));
    if (nextBtn) {
      nextBtn.style.display = 'none';
      const foot = nextBtn.closest('.gm-cardfoot');
      // The first card's footer held only this button — collapse the now-empty row.
      if (foot && !foot.querySelector('[data-wt-cta-prev]')) foot.style.display = 'none';
    }
  });
}

export function rerenderGuideDemos() {
  instances.forEach(inst => inst.rerender());
}
