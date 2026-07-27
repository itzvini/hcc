import { t, getCurrentLang } from './i18n.js';

// Collections — every Creature Club release ever made, oldest to newest.
// Fetches /collections.json (built from the Highrise item catalogue and the club's
// gift log) and renders a year-by-year timeline: one card per release, each opening
// into a grid of its items with their in-game icons.
//
// Half the releases predate the announcements channel, so their dates are worked out
// from when the items were authored. Those show a "~" marker and the card says so —
// the timeline never presents a guessed date as a known one.

let data = null;
let failed = false;

// One accent per release type drives that card's glow, chip and rail node.
const TYPES = {
  drop:     { ico: '💧', accent: 'var(--hr-primary)'   },
  grab:     { ico: '🎰', accent: 'var(--hr-secondary)' },
  store:    { ico: '🛒', accent: 'var(--hr-banana)'    },
  event:    { ico: '🎪', accent: 'var(--hr-blueberry)' },
  competition: { ico: '🏆', accent: 'var(--hr-tangerine)' },
  giveaway: { ico: '🎁', accent: 'var(--hr-alert)'     },
  collab:   { ico: '🤝', accent: 'var(--hr-tangerine)' },
  other:    { ico: '✨', accent: 'var(--hr-mackerel)'  },
};
const RARITY = ['m', 'l', 'e', 'r', 'c'];   // mythical → common, best first
// Slots that aren't worn, so their render is the object itself, not an avatar in it
const NOT_WORN = new Set(['furniture', 'room_floor', 'emote', 'set']);
const HERO_THUMBS = 7;   // 7 thumbs + a "+N" chip fill the strip's 4-wide block exactly

// UI state
let activeTypes = new Set();   // empty = show every type
let query = '';
let newestFirst = false;   // oldest first, so the timeline reads as the club's history
const openCards = new Set();

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function num(n) {
  return new Intl.NumberFormat(getCurrentLang()).format(n);
}

// Supporting quotes are Discord messages, so show them the way Discord would rather
// than leaving the asterisks on display. Everything is escaped first, so the only
// tags that survive are the ones added here.
function discordMarkup(s) {
  return esc(s)
    .replace(/\*\*\*(.+?)\*\*\*/gs, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/gs, '$1<em>$2</em>')
    .replace(/__(.+?)__/gs, '<u>$1</u>')
    .replace(/~~(.+?)~~/gs, '<s>$1</s>')
    .replace(/`([^`]+?)`/gs, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

// 12400 → "12.4K", 1025794 → "1M" — keeps the stat tiles and card meta compact
function compact(n) {
  return new Intl.NumberFormat(getCurrentLang(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function monthYear(iso) {
  const [y, m] = iso.split('-');
  const d = new Date(Date.UTC(+y, +m - 1, 1));
  return new Intl.DateTimeFormat(getCurrentLang(), { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}

function fullDate(iso) {
  const [y, m, d] = iso.split('-');
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  return new Intl.DateTimeFormat(getCurrentLang(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(dt);
}

// The rail badge: an exact day, or the month alone when the date is worked out
function dateLabel(rel) {
  if (!rel.date) return t('col.date.unknown');
  return rel.precision === 'exact' ? fullDate(rel.date) : monthYear(rel.date);
}

export async function loadCollections() {
  const box = document.getElementById('collections-app');
  try {
    const res = await fetch('/collections.json');
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch {
    failed = true;
    if (box) {
      box.setAttribute('aria-busy', 'false');
      box.innerHTML = `<div class="col-empty"><span class="col-empty-ico" aria-hidden="true">🗂️</span>
        <p>${esc(t('col.error'))}</p></div>`;
    }
    return;
  }
  render();
}

export function rerenderCollections() { if (data && !failed) render(); }

/* ---------------------------------------------------------------- filtering */

function matches(rel) {
  if (activeTypes.size && !activeTypes.has(rel.type)) return false;
  if (!query) return true;
  if (rel.name.toLowerCase().includes(query)) return true;
  return rel.items.some(i => i.n.toLowerCase().includes(query));
}

function visibleReleases() {
  const list = data.releases.filter(matches);
  list.sort((a, b) => {
    const d = (a.date || '').localeCompare(b.date || '');
    return newestFirst ? -d || a.name.localeCompare(b.name) : d || a.name.localeCompare(b.name);
  });
  return list;
}

/* ------------------------------------------------------------------ pieces */

function statTiles(list) {
  const items = list.reduce((s, r) => s + r.count, 0);
  const copies = list.reduce((s, r) => s + r.copies, 0);
  const years = new Set(list.filter(r => r.date).map(r => r.date.slice(0, 4)));
  const tiles = [
    { k: 'releases', v: num(list.length), raw: list.length },
    { k: 'items',    v: num(items),       raw: items },
    { k: 'copies',   v: compact(copies),  raw: copies, title: num(copies) },
    { k: 'years',    v: num(years.size),  raw: years.size },
  ];
  return `<div class="col-stats">${tiles.map((tile, i) => `
    <div class="col-stat col-reveal" style="--d:${i * 60}ms"${tile.title ? ` title="${esc(tile.title)}"` : ''}>
      <span class="col-stat-v" data-count="${tile.raw}">${esc(String(tile.v))}</span>
      <span class="col-stat-k">${esc(t(`col.stat.${tile.k}`))}</span>
    </div>`).join('')}</div>`;
}

function filterBar() {
  const counts = {};
  data.releases.forEach(r => { counts[r.type] = (counts[r.type] || 0) + 1; });
  const chips = data.types.filter(k => counts[k]).map(k => {
    const on = activeTypes.has(k);
    return `<button class="col-chip${on ? ' is-on' : ''}" type="button" data-type="${k}"
      style="--accent:${TYPES[k].accent}" aria-pressed="${on}">
      <span class="col-chip-ico" aria-hidden="true">${TYPES[k].ico}</span>
      <span>${esc(t(`col.type.${k}`))}</span>
      <span class="col-chip-n">${counts[k]}</span>
    </button>`;
  }).join('');
  const allOn = activeTypes.size === 0;
  return `
  <div class="col-controls">
    <div class="col-chips" role="group" aria-label="${esc(t('col.a11y.filter'))}">
      <button class="col-chip is-all${allOn ? ' is-on' : ''}" type="button" data-type="" aria-pressed="${allOn}">
        <span>${esc(t('col.type.all'))}</span>
        <span class="col-chip-n">${data.releases.length}</span>
      </button>
      ${chips}
    </div>
    <div class="col-tools">
      <div class="col-search">
        <span class="col-search-ico" aria-hidden="true">🔍</span>
        <input type="search" id="col-q" class="col-search-in" value="${esc(query)}"
          placeholder="${esc(t('col.search.ph'))}" aria-label="${esc(t('col.a11y.search'))}">
      </div>
      <button class="col-sort" type="button" id="col-sort" aria-pressed="${newestFirst}">
        <span class="col-sort-ico" aria-hidden="true">${newestFirst ? '↓' : '↑'}</span>
        <span>${esc(t(newestFirst ? 'col.sort.newest' : 'col.sort.oldest'))}</span>
      </button>
    </div>
  </div>`;
}

// Rarity mix: a thin stacked bar plus a plain-word legend, so the split is readable
// and not just a coloured line.
function rarityMix(rel) {
  const present = RARITY.filter(r => rel.rarity[r]);
  if (!present.length) return '';
  const total = rel.count || 1;
  const segs = present.map(r =>
    `<span class="col-rbar-seg col-r-${r}" style="width:${(rel.rarity[r] / total) * 100}%"></span>`).join('');
  const legend = present.map(r =>
    `<span class="col-rl"><i class="col-r-${r}" aria-hidden="true"></i>${num(rel.rarity[r])} ${esc(t(`col.rarity.${r}`))}</span>`).join('');
  return `<div class="col-rarity">
    <span class="col-rbar" aria-hidden="true">${segs}</span>
    <span class="col-rleg">${legend}</span>
  </div>`;
}

function heroStrip(rel) {
  if (!rel.hero.length) return '';
  // hero holds row indices, chosen by the build so every one resolves to a picture.
  const picks = rel.hero.slice(0, HERO_THUMBS).filter(n => rel.items[n]);
  const thumbs = picks.map((n, k) => `
    <button class="col-hero-t" type="button" data-item="${esc(rel.id)}" data-idx="${n}"
      style="--d:${k * 45}ms" title="${esc(rel.items[n].n)}">
      ${thumbShot(rel.items[n])}
    </button>`).join('');
  const more = rel.count - picks.length;
  return `<div class="col-hero">${thumbs}${
    more > 0 ? `<span class="col-hero-more">+${num(more)}</span>` : ''}</div>`;
}

function catName(c) {
  const key = `col.cat.${c}`;
  const label = t(key);
  return label === key ? c.replace(/_/g, ' ') : label;
}

// Most previews are a render of the whole avatar wearing the item, so a mouth or a
// choker is only a few pixels across. The build works out a crop window per item;
// this turns that window into a style that scales the render up inside its square
// frame so only the item shows. Items without a window keep the full render.
function zoomStyle(box) {
  if (!box) return '';
  const [x0, y0, x1, y1, w, h] = box;
  // Read the window as fractions of its frame, never as pixels. Most CDN renders are
  // 600x800, but some arrive trimmed to the avatar, and sizing by the pixel numbers
  // squashed those to fit.
  const fx0 = x0 / w, fx1 = x1 / w, fy0 = y0 / h, fy1 = y1 / h;
  // Blow the crop's longer side up to fill the square and leave the other axis auto,
  // so the image holds its own aspect and cannot come out stretched.
  const size = (x1 - x0) >= (y1 - y0)
    ? `width:${(100 / (fx1 - fx0)).toFixed(2)}%;height:auto`
    : `height:${(100 / (fy1 - fy0)).toFixed(2)}%;width:auto`;
  // Then pull the crop's midpoint onto the frame's. A translate percentage counts
  // against the image's own box, so this lands whatever size it loaded at.
  return `${size};left:50%;top:50%;transform:translate(` +
         `${(-(fx0 + fx1) * 50).toFixed(2)}%,${(-(fy0 + fy1) * 50).toFixed(2)}%)`;
}

// Every picture comes from our own domain, out of the collection_art table. `k` is a
// hash of the source bytes, so the URL names nothing: no Highrise item id reaches a
// browser, and because the bytes behind an id can never change the server caches these
// hard. 'full' is the whole render; 'thumb' is the pre-cropped 104px square.
function artUrl(i, variant) {
  return i.k ? `/api/collections/art/${variant}/${encodeURIComponent(i.k)}.webp` : null;
}

// The whole render, cropped to the item by a CSS window where the build worked one out.
// Used at every size the item is shown big: the grid tile and the inspect card stage.
function itemShot(i, { zoom = true, lazy = true } = {}) {
  const src = artUrl(i, 'full');
  if (!src) {
    return `<span class="col-shot is-empty"><span class="col-item-none" aria-hidden="true">?</span></span>`;
  }
  const style = zoom ? zoomStyle(i.b) : '';
  return `<span class="col-shot${style ? ' is-zoomed' : ''}">
    <img src="${src}" alt=""${lazy ? ' loading="lazy"' : ''} decoding="async"${
      style ? ` style="${style}" data-fr="${(i.b[4] / i.b[5]).toFixed(4)}"` : ''}>
  </span>`;
}

// The same picture the stage shows, but whole. Only worth showing next to a cropped
// stage, so the inspect card can say "here it is on an avatar".
function fullShot(i) {
  return artUrl(i, 'full');
}

// A collapsed card's strip runs on the small variant: cropped to the item when the
// picture was encoded, so no window and no shape guard here, and about 3 KB against the
// full render's 21 KB. Seven per card, across 107 cards, is where that adds up.
function thumbShot(i) {
  const src = artUrl(i, 'thumb');
  if (!src) return itemShot(i);
  return `<span class="col-shot">
    <img src="${src}" alt="" loading="lazy" decoding="async">
  </span>`;
}

// A crop window describes the frame it was measured in. Nearly every render is in that
// frame, but a few come back from Highrise trimmed to the avatar, and the window says
// nothing useful about those. Checking the shape on load costs nothing and keeps the
// page right without a rebuild if more get trimmed.
function checkFrame(img) {
  const want = Number(img.dataset.fr);
  if (!want || !img.naturalWidth || !img.naturalHeight) return;
  if (Math.abs(img.naturalWidth / img.naturalHeight - want) / want <= 0.02) return;
  delete img.dataset.fr;
  img.removeAttribute('style');            // back to fitting the box whole
  img.closest('.col-shot')?.classList.remove('is-zoomed');
}

// A picture can be missing: the build couldn't encode one for that item, or the site is
// running without the database that holds them. Show the placeholder tile rather than a
// broken frame. Neither `error` nor `load` bubbles, so both are caught in the capture
// phase, and a tile is only ever replaced once.
function shotFailed(img) {
  const shot = img.closest('.col-shot');
  if (!shot) return;
  shot.classList.add('is-empty');
  shot.innerHTML = '<span class="col-item-none" aria-hidden="true">?</span>';
}
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  // The inspect card's avatar view is a bonus, not the item's own picture — if it
  // won't load, drop the block rather than leave a broken frame in the card.
  const avatar = img.closest('.col-insp-avatar');
  if (avatar) { avatar.remove(); return; }
  shotFailed(img);
}, true);
document.addEventListener('load', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.naturalWidth <= 2) shotFailed(img);
  else checkFrame(img);
}, true);

function itemGrid(rel) {
  return `<div class="col-items">${rel.items.map((i, n) => `
    <button class="col-item" type="button" data-item="${esc(rel.id)}" data-idx="${n}">
      <span class="col-item-fig">
        ${itemShot(i)}
        <span class="col-item-dot col-r-${i.r}"></span>
      </span>
      <span class="col-item-cap">
        <span class="col-item-n" title="${esc(i.n)}">${esc(i.n)}</span>
        <span class="col-item-m">${esc(catName(i.c))}${i.q ? ` · ${compact(i.q)}` : ''}</span>
      </span>
    </button>`).join('')}</div>`;
}

function card(rel, idx) {
  const meta = TYPES[rel.type] || TYPES.other;
  const open = openCards.has(rel.id);
  const approx = rel.precision !== 'exact';
  return `
  <li class="col-stop col-reveal${open ? ' is-open' : ''}" style="--accent:${meta.accent};--d:${Math.min(idx, 8) * 55}ms" data-id="${esc(rel.id)}">
    <span class="col-node" aria-hidden="true"></span>
    <div class="col-rail">
      <span class="col-rail-d"${approx ? ` title="${esc(t('col.note.approx'))}"` : ''}>${
        approx ? '<span class="col-approx" aria-hidden="true">~</span>' : ''}${esc(dateLabel(rel))}</span>
    </div>
    <article class="col-card">
      <span class="col-glow" aria-hidden="true"></span>
      <div class="col-main">
        <header class="col-card-top">
          <span class="col-type"><span aria-hidden="true">${meta.ico}</span>${esc(t(`col.type1.${rel.type}`))}</span>
          ${rel.announced ? `<span class="col-badge" title="${esc(t('col.announced.tip'))}">${esc(t('col.announced'))}</span>` : ''}
        </header>
        <h3 class="col-card-h">${esc(rel.name)}</h3>
        <p class="col-card-meta">
          <span><b>${num(rel.count)}</b> ${esc(t(rel.count === 1 ? 'col.meta.item' : 'col.meta.items'))}</span>
          ${rel.copies ? `<span title="${esc(num(rel.copies))}"><b>${compact(rel.copies)}</b> ${esc(t('col.meta.copies'))}</span>` : ''}
        </p>
        ${rarityMix(rel)}
        ${rel.gift ? `<p class="col-gift"><span aria-hidden="true">🎁</span>${esc(rel.gift)}</p>` : ''}
        ${rel.quote ? `<blockquote class="col-quote">${discordMarkup(rel.quote)}</blockquote>` : ''}
        ${rel.note ? `<aside class="col-annot">
          <span class="col-annot-lbl">${esc(t('col.annot'))}</span>
          <span class="col-annot-t">${esc(rel.note)}</span>
        </aside>` : ''}
      </div>
      ${heroStrip(rel)}
      <!-- Own grid row, after the preview strip, so the stacked mobile card reads
           text → thumbnails → button rather than burying the strip below the button. -->
      <button class="col-more" type="button" data-toggle="${esc(rel.id)}" aria-expanded="${open}" aria-controls="col-body-${esc(rel.id)}">
        <span>${esc(t(open ? 'col.hide' : 'col.show'))}</span>
        <span class="col-more-caret" aria-hidden="true">▾</span>
      </button>
      <div class="col-body" id="col-body-${esc(rel.id)}"${open ? '' : ' hidden'}>
        ${open ? itemGrid(rel) : ''}
        ${approx ? `<p class="col-note">${esc(t('col.note.approx'))}</p>` : ''}
      </div>
    </article>
  </li>`;
}

function timeline(list) {
  if (!list.length) {
    return `<div class="col-empty"><span class="col-empty-ico" aria-hidden="true">🔍</span>
      <p>${esc(t('col.none'))}</p>
      <button class="col-reset" type="button" id="col-reset">${esc(t('col.reset'))}</button></div>`;
  }
  let html = '<div class="col-timeline">';
  let year = null;
  let i = 0;
  let openList = false;
  list.forEach(rel => {
    const y = rel.date ? rel.date.slice(0, 4) : t('col.date.unknown');
    if (y !== year) {
      if (openList) html += '</ol>';
      year = y;
      const n = list.filter(r => (r.date ? r.date.slice(0, 4) : t('col.date.unknown')) === y).length;
      html += `<div class="col-year"><span class="col-year-n">${esc(y)}</span>
        <span class="col-year-c">${num(n)} ${esc(t(n === 1 ? 'col.meta.release' : 'col.meta.releases'))}</span>
        <span class="col-year-rule"></span></div><ol class="col-stops">`;
      openList = true;
      i = 0;
    }
    html += card(rel, i++);
  });
  if (openList) html += '</ol>';
  return html + '</div>';
}

/* ------------------------------------------------------------------ render */

function render() {
  const box = document.getElementById('collections-app');
  if (!box) return;
  const list = visibleReleases();
  box.setAttribute('aria-busy', 'false');
  box.innerHTML = statTiles(data.releases) + filterBar() + timeline(list);
  wire(box);
  countUp(box);
  reveal(box);
}

// Re-render just the timeline, so typing in the search box keeps focus and caret
function renderList() {
  const box = document.getElementById('collections-app');
  const old = box?.querySelector('.col-timeline, .col-empty:not(:first-child)');
  if (!box || !old) { render(); return; }
  const holder = document.createElement('div');
  holder.innerHTML = timeline(visibleReleases());
  old.replaceWith(holder.firstElementChild);
  wire(box);
  reveal(box);
}

function wire(box) {
  box.querySelectorAll('[data-type]').forEach(chip => {
    if (chip.dataset.wired) return;
    chip.dataset.wired = '1';
    chip.addEventListener('click', () => {
      const k = chip.dataset.type;
      if (!k) activeTypes.clear();
      else if (activeTypes.has(k)) activeTypes.delete(k);
      else activeTypes.add(k);
      render();
    });
  });

  const q = box.querySelector('#col-q');
  if (q && !q.dataset.wired) {
    q.dataset.wired = '1';
    let timer;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { query = q.value.trim().toLowerCase(); renderList(); }, 160);
    });
  }

  const sort = box.querySelector('#col-sort');
  if (sort && !sort.dataset.wired) {
    sort.dataset.wired = '1';
    sort.addEventListener('click', () => { newestFirst = !newestFirst; render(); });
  }

  box.querySelector('#col-reset')?.addEventListener('click', () => {
    activeTypes.clear(); query = ''; render();
  });

  // One delegated listener on the box covers every item tile, including the grids
  // that get built later when a release is expanded.
  if (!box.dataset.inspectWired) {
    box.dataset.inspectWired = '1';
    box.addEventListener('click', e => {
      const tile = e.target.closest('[data-item]');
      if (tile) openInspect(tile.dataset.item, Number(tile.dataset.idx));
    });
  }

  // Expand a release into its full item grid. The grid is built on first open, so
  // the initial paint never mounts 1,300 images at once.
  box.querySelectorAll('[data-toggle]').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const id = btn.dataset.toggle;
      const stop = btn.closest('.col-stop');
      const body = stop.querySelector('.col-body');
      const rel = data.releases.find(r => r.id === id);
      const open = !openCards.has(id);
      if (open) {
        openCards.add(id);
        if (!body.querySelector('.col-items')) body.insertAdjacentHTML('afterbegin', itemGrid(rel));
      } else {
        openCards.delete(id);
      }
      body.hidden = !open;
      stop.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', String(open));
      btn.querySelector('span').textContent = t(open ? 'col.hide' : 'col.show');
    });
  });
}

// Count the stat numbers up once, on first paint. Formatted values (12.4K) hold a
// data-count with the real figure, so the roll lands on the same compact string.
function countUp(box) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  box.querySelectorAll('.col-stat-v').forEach(el => {
    const target = Number(el.dataset.count);
    const final = el.textContent;
    if (!target) return;
    const dur = 900;
    const t0 = performance.now();
    const compactly = /[^\d.,\s]/.test(final);
    function step(now) {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = Math.round(target * eased);
      el.textContent = p === 1 ? final : (compactly ? compact(v) : num(v));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

/* ----------------------------------------------------------- inspect card */

// Click any item to open it in a floating card: the item blown up as large as the
// art allows, the whole avatar render beside it for context, and which release it
// came from. Arrow keys walk the rest of the release without closing.
let inspecting = null;   // { relId, idx }

function inspectDialog() {
  let dlg = document.getElementById('col-inspect');
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.id = 'col-inspect';
  dlg.className = 'col-modal';
  dlg.setAttribute('aria-labelledby', 'col-modal-h');
  document.body.appendChild(dlg);
  // Clicking the backdrop (the dialog's own box, outside the panel) closes it
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { e.preventDefault(); stepInspect(1); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); stepInspect(-1); }
  });
  dlg.addEventListener('close', () => { inspecting = null; });
  return dlg;
}

function stepInspect(delta) {
  if (!inspecting) return;
  const rel = data.releases.find(r => r.id === inspecting.relId);
  if (!rel) return;
  const n = rel.items.length;
  openInspect(inspecting.relId, (inspecting.idx + delta + n) % n);
}

function openInspect(relId, idx) {
  const rel = data.releases.find(r => r.id === relId);
  if (!rel || !rel.items[idx]) return;
  const i = rel.items[idx];
  const meta = TYPES[rel.type] || TYPES.other;
  const dlg = inspectDialog();
  inspecting = { relId, idx };

  const rows = [
    [t('col.insp.rarity'), `<span class="col-insp-rar"><i class="col-r-${i.r}"></i>${esc(t(`col.rarity.${i.r}`))}</span>`],
    [t('col.insp.slot'), esc(catName(i.c))],
    i.q ? [t('col.insp.copies'), `<b>${num(i.q)}</b>`] : null,
    [t('col.insp.from'), `${esc(rel.name)}<span class="col-insp-sub">${
      rel.precision === 'exact' ? esc(fullDate(rel.date)) : `~ ${esc(dateLabel(rel))}`}</span>`],
  ].filter(Boolean);

  dlg.innerHTML = `
    <div class="col-insp" style="--accent:${meta.accent}">
      <span class="col-insp-glow" aria-hidden="true"></span>
      <button class="col-insp-x" type="button" data-close aria-label="${esc(t('col.insp.close'))}">✕</button>
      <div class="col-insp-stage">
        ${itemShot(i, { lazy: false })}
      </div>
      <div class="col-insp-body">
        <span class="col-insp-type"><span aria-hidden="true">${meta.ico}</span>${esc(t(`col.type1.${rel.type}`))}</span>
        <h3 class="col-insp-h" id="col-modal-h">${esc(i.n)}</h3>
        <dl class="col-insp-dl">
          ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}
        </dl>
        ${i.g ? `<p class="col-insp-gift"><span aria-hidden="true">🎁</span>${esc(t('col.insp.gifted'))}</p>` : ''}
        ${i.b && fullShot(i) ? `<div class="col-insp-avatar">
          <span class="col-insp-avatar-lbl">${esc(t(NOT_WORN.has(i.c) ? 'col.insp.fullart' : 'col.insp.onavatar'))}</span>
          <img src="${fullShot(i)}" alt="${esc(i.n)}" decoding="async">
        </div>` : ''}
        <div class="col-insp-nav">
          <button class="col-insp-step" type="button" data-step="-1" aria-label="${esc(t('col.insp.prev'))}">‹</button>
          <span class="col-insp-count">${num(idx + 1)} / ${num(rel.items.length)}</span>
          <button class="col-insp-step" type="button" data-step="1" aria-label="${esc(t('col.insp.next'))}">›</button>
        </div>
      </div>
    </div>`;

  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('[data-step]').forEach(b =>
    b.addEventListener('click', () => stepInspect(Number(b.dataset.step))));
  if (!dlg.open) dlg.showModal();
}

// Stagger cards in as they scroll into view.
//
// The top rootMargin is deliberately enormous: it makes everything above the
// viewport count as intersecting, so a card reveals the moment it ends up behind
// you. Without it, jumping down the timeline (a year link, a long flick, a
// restored scroll position) leaves every card it skipped stuck at opacity 0,
// because "below the fold" to "above the fold" is not an intersection change and
// fires no callback. The bottom margin stays at 0 for the same reason: pulling the
// trigger line up the screen leaves a band at the end of the document that no
// amount of scrolling can push a card past, so the last card never appears.
function reveal(box) {
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-in');
      obs.unobserve(e.target);
    });
  }, { rootMargin: '100000px 0px 0px 0px' });
  box.querySelectorAll('.col-reveal:not(.is-in)').forEach(el => io.observe(el));
}
