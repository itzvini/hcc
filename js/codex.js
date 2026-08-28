import { t } from './i18n.js';
import { slug, codexHref } from './entity-url.js';
import {
  collectionsData, TYPES, NOT_WORN, esc, num, fullDate, dateLabel, catName,
  itemShot, fullShot, discordMarkup,
} from './collections.js';

// Codex — one addressable page per thing the club has made.
//
// All of this already existed on the site, but only inside a modal: you could look at a
// release, an item or a trait and then had no way to send anyone to it. A reference
// nobody can link to is a reference nobody quotes, so each entity now has a real URL that
// survives a reload, a share and a back button:
//
//   /collections/release/<release id>
//   /collections/item/<item name slug>
//   /collections/trait/<slot>/<value slug>
//   /collections/creature/<token id>
//
// The four pages share one shell — crumbs, art, fact list, linked rails — so they read as
// one work rather than four features, and so a new entity type is a renderer, not a design.
// Every page links to its neighbours: a release lists its items, an item names every
// release it shipped in, a trait names its pieces, a creature names its traits. Following
// those links is the whole point.

const KINDS = new Set(['release', 'item', 'trait', 'creature']);

let view = null;          // the #codex-view element, once found
let current = null;       // { kind, args } of the open page, so a language switch repaints it
let seq = 0;              // guards against a slow fetch painting over a newer page
let traitDoc = null;      // the whole trait catalogue: one document serves every trait page
// The server stamps the shell's head per entity URL, which covers a full load and every
// scraper. Walking between pages in the browser never reloads, so the tab keeps the title
// it arrived with unless it is set here too. The club's name comes from og:site_name
// rather than document.title, which on a stamped load is already an entity's title.
const siteTitle = document.querySelector('meta[property="og:site_name"]')?.content
  || 'Highrise Creature Club';

/* ------------------------------------------------------------------- helpers */

// t() with {placeholders} filled in. An unresolved key comes back untouched, which is
// what the shell already treats as "keep the markup's own label".
function tr(key, vars) {
  let s = t(key);
  if (s === key) return s;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  return s;
}

function pct(share) {
  if (share == null) return '';
  if (share > 0 && share < 0.001) return '< 0.1%';
  return `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`;
}

function eth(v) {
  const n = Number(v);
  return `${n < 0.01 ? n.toFixed(4) : n.toFixed(3)} ETH`;
}

function shortWallet(w) {
  return w ? `${w.slice(0, 6)}…${w.slice(-4)}` : '';
}

function dated(rel) {
  return rel.precision === 'exact' ? fullDate(rel.date) : `~ ${dateLabel(rel)}`;
}

/* -------------------------------------------------------------------- shell */

// Every page is the same six blocks. Passing them in as strings keeps each renderer
// about its subject and nothing else.
function shell({ accent, crumbs, kind, title, lead, art, cta, facts, blocks, note }) {
  const factRows = (facts || []).filter(Boolean)
    .map(([k, v]) => `<div class="cdx-fact"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('');
  return `
    <article class="cdx" style="--accent:${accent || 'var(--hr-primary)'}">
      <span class="cdx-glow" aria-hidden="true"></span>
      <nav class="cdx-crumbs" aria-label="${esc(t('cdx.a11y.crumbs'))}">
        <a href="/collections" data-codex-close>${esc(t('cdx.crumb.home'))}</a>
        ${(crumbs || []).map(c => `<span aria-hidden="true">›</span>${
          c.href ? `<a href="${esc(c.href)}">${esc(c.label)}</a>`
                 : `<span class="cdx-crumb-here">${esc(c.label)}</span>`}`).join('')}
      </nav>
      <header class="cdx-head">
        ${art ? `<div class="cdx-art">${art}</div>` : ''}
        <div class="cdx-intro">
          <span class="cdx-kind">${esc(kind)}</span>
          <h2 class="cdx-title">${esc(title)}</h2>
          ${lead ? `<p class="cdx-lead">${lead}</p>` : ''}
          ${cta ? `<div class="cdx-cta">${cta}</div>` : ''}
        </div>
      </header>
      ${factRows ? `<dl class="cdx-facts">${factRows}</dl>` : ''}
      ${(blocks || []).filter(Boolean).join('')}
      ${note ? `<p class="cdx-note">${note}</p>` : ''}
    </article>`;
}

// A titled block holding a rail of linked tiles — the part that makes this a reference
// rather than a set of detail views.
function railBlock(title, tiles, { sub = '', more = null } = {}) {
  if (!tiles.length) return '';
  return `<section class="cdx-sec">
    <header class="cdx-sec-h">
      <h3>${esc(title)}</h3>
      ${sub ? `<span class="cdx-sec-sub">${esc(sub)}</span>` : ''}
      ${more ? `<a class="cdx-sec-more" href="${esc(more.href)}">${esc(more.label)}</a>` : ''}
    </header>
    <div class="cdx-rail">${tiles.join('')}</div>
  </section>`;
}

function prose(title, html) {
  return `<section class="cdx-sec">
    <header class="cdx-sec-h"><h3>${esc(title)}</h3></header>
    <div class="cdx-prose">${html}</div>
  </section>`;
}

function itemTile(item) {
  return `<a class="cdx-tile" href="${codexHref('item', item.n)}" title="${esc(item.n)}">
    <span class="cdx-tile-shot">${itemShot(item)}</span>
    <span class="cdx-tile-n">${esc(item.n)}</span>
    <span class="cdx-tile-c"><i class="col-r-${esc(item.r)}"></i>${esc(catName(item.c))}</span>
  </a>`;
}

function loading() {
  return `<div class="cdx-loading"><div class="apply-spinner"></div></div>`;
}

function missing(message) {
  return `<div class="cdx-missing">
    <span class="cdx-missing-ico" aria-hidden="true">&#128451;</span>
    <p>${esc(message)}</p>
    <a class="ctr-btn" href="/collections" data-codex-close>${esc(t('cdx.back'))}</a>
  </div>`;
}

/* ----------------------------------------------------------------- releases */

function releasePage(archive, id) {
  const rel = archive.releases.find(r => r.id === id);
  if (!rel) return missing(t('cdx.missing.release'));
  const meta = TYPES[rel.type] || TYPES.other;
  const order = [...archive.releases].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const at = order.findIndex(r => r.id === rel.id);
  const prev = order[at - 1];
  const next = order[at + 1];
  const hero = (rel.hero || []).map(n => rel.items[n]).filter(Boolean).slice(0, 4);

  const step = (r, isNext) => `<a class="cdx-step${isNext ? ' is-next' : ''}" href="${codexHref('release', r.id)}">
    <span class="cdx-step-dir">${isNext ? `${esc(t('cdx.rel.after'))} ›` : `‹ ${esc(t('cdx.rel.before'))}`}</span>
    <span class="cdx-step-n">${esc(r.name)}</span>
  </a>`;

  return shell({
    accent: meta.accent,
    crumbs: [{ label: t('cdx.crumb.releases'), href: '/collections' }, { label: rel.name }],
    kind: `${meta.ico} ${t(`col.type1.${rel.type}`)}`,
    title: rel.name,
    lead: `${esc(dated(rel))}${rel.announced
      ? ` · <span class="cdx-flag">${esc(t('col.announced'))}</span>` : ''}`,
    art: hero.length
      ? `<div class="cdx-art-grid" data-n="${hero.length}">${
        hero.map(i => itemShot(i, { lazy: false })).join('')}</div>`
      : '',
    facts: [
      [t('cdx.f.type'), esc(t(`col.type1.${rel.type}`))],
      [t('cdx.f.released'), `${esc(dated(rel))}${rel.precision === 'exact' ? ''
        : `<span class="cdx-sub">${esc(t('cdx.f.approx'))}</span>`}`],
      [t('cdx.f.items'), `<b>${num(rel.items.length)}</b>`],
      rel.copies ? [t('cdx.f.copies'), `<b>${num(rel.copies)}</b>`] : null,
    ],
    blocks: [
      rel.note ? prose(t('col.annot'), `<p>${discordMarkup(rel.note)}</p>`) : '',
      railBlock(t('cdx.rel.items'), rel.items.map(itemTile),
        { sub: tr('cdx.rel.itemsSub', { n: num(rel.items.length) }) }),
      (prev || next) ? `<section class="cdx-sec">
        <header class="cdx-sec-h"><h3>${esc(t('cdx.rel.nearby'))}</h3></header>
        <div class="cdx-steps">
          ${prev ? step(prev, false) : ''}${next ? step(next, true) : ''}
        </div></section>` : '',
    ],
    note: esc(t('cdx.src.archive')),
  });
}

/* -------------------------------------------------------------------- items */

function itemPage(archive, wanted) {
  // Every release this exact name shipped in. 57 names appear more than once, and that
  // repeat is the interesting fact about them, so an item gets one page listing all of its
  // appearances rather than a near-identical page per copy.
  const seen = [];
  for (const rel of archive.releases) {
    for (const it of rel.items) if (slug(it.n) === wanted) seen.push({ rel, it });
  }
  if (!seen.length) return missing(t('cdx.missing.item'));
  seen.sort((a, b) => (a.rel.date || '').localeCompare(b.rel.date || ''));
  const { rel, it } = seen[0];
  const meta = TYPES[rel.type] || TYPES.other;
  const whole = fullShot(it);
  const siblings = rel.items.filter(x => x.n !== it.n).slice(0, 12);

  return shell({
    accent: meta.accent,
    crumbs: [
      { label: t('cdx.crumb.releases'), href: '/collections' },
      { label: rel.name, href: codexHref('release', rel.id) },
      { label: it.n },
    ],
    kind: catName(it.c),
    title: it.n,
    lead: `${esc(t(`col.rarity.${it.r}`))}${it.q
      ? ` · ${esc(tr('cdx.item.copiesLead', { n: num(it.q) }))}` : ''}`,
    art: `<div class="cdx-art-one">${itemShot(it, { lazy: false })}</div>`,
    cta: `<a class="ctr-btn is-primary" href="${codexHref('release', rel.id)}">${
      esc(t('cdx.item.seeRelease'))}</a>`,
    facts: [
      [t('cdx.f.rarity'), `<span class="cdx-rar"><i class="col-r-${esc(it.r)}"></i>${
        esc(t(`col.rarity.${it.r}`))}</span>`],
      [t('cdx.f.slot'), esc(catName(it.c))],
      it.q ? [t('cdx.f.copies'), `<b>${num(it.q)}</b>`] : null,
      [t('cdx.f.firstseen'), `${esc(rel.name)}<span class="cdx-sub">${esc(dated(rel))}</span>`],
      it.g ? [t('cdx.f.gifted'), esc(t('col.insp.gifted'))] : null,
    ],
    blocks: [
      it.b && whole ? `<section class="cdx-sec">
        <header class="cdx-sec-h"><h3>${
          esc(t(NOT_WORN.has(it.c) ? 'col.insp.fullart' : 'col.insp.onavatar'))}</h3></header>
        <div class="cdx-whole"><img src="${esc(whole)}" alt="${esc(it.n)}" decoding="async"></div>
      </section>` : '',
      seen.length > 1 ? railBlock(t('cdx.item.appears'), seen.map(({ rel: r }) => `
        <a class="cdx-tile is-wide" href="${codexHref('release', r.id)}">
          <span class="cdx-tile-n">${esc(r.name)}</span>
          <span class="cdx-tile-c">${esc(dated(r))}</span>
        </a>`), { sub: tr('cdx.item.appearsSub', { n: num(seen.length) }) }) : '',
      railBlock(t('cdx.item.alongside'), siblings.map(itemTile), {
        sub: rel.name,
        more: rel.items.length > siblings.length + 1
          ? { href: codexHref('release', rel.id), label: t('cdx.item.allOf') } : null,
      }),
    ],
    note: esc(t('cdx.src.archive')),
  });
}

/* ------------------------------------------------------------------- traits */

async function traitCatalogue() {
  if (traitDoc) return traitDoc;
  const res = await fetch('/api/market/creatures/traits');
  if (!res.ok) throw new Error('traits');
  const doc = await res.json();
  if (doc.indexing) throw new Error('indexing');
  traitDoc = doc;
  return doc;
}

// A slot's label. Same key shape the traits showcase uses, so the two never disagree
// about what a slot is called; anything unnamed falls back to the API's own label.
function slotName(type, doc) {
  const key = `ctr.slot.${String(type).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const label = t(key);
  if (label !== key) return label;
  const ty = doc && doc.types.find(x => x.type === type);
  return (ty && ty.label) || String(type).replace(/_/g, ' ');
}

// The marketplace, opened with this trait already picked. A piece of an outfit has no
// trait of its own to filter on, so it hands over the look it belongs to, which selects
// exactly the same Creatures: a piece appears in one look and nowhere else.
function tradeLink(type, val, all) {
  const filter = val.of ? `Outfit:${val.of}` : `${type}:${val.v}`;
  const p = new URLSearchParams({ coll: 'creatures', t: filter });
  if (all) p.set('scope', 'all');
  return `/trade?${p}`;
}

function traitShot(art, { lazy = true } = {}) {
  if (!art) return '';
  return `<img src="/api/collections/art/trait/${encodeURIComponent(art)}.webp" alt=""${
    lazy ? ' loading="lazy"' : ''} decoding="async">`;
}

function traitPage(doc, slotSlug, valueSlug) {
  const ty = doc.types.find(x => slug(x.type) === slotSlug);
  const val = ty && ty.values.find(v => slug(v.v) === valueSlug);
  if (!val) return missing(t('cdx.missing.trait'));
  const share = doc.total ? val.n / doc.total : null;
  const rank = ty.values.indexOf(val) + 1;
  const siblings = ty.values.filter(v => v !== val).slice(0, 14);

  return shell({
    accent: 'var(--hr-secondary)',
    crumbs: [
      { label: t('cdx.crumb.traits'), href: '/collections/traits' },
      { label: slotName(ty.type, doc), href: '/collections/traits' },
      { label: val.v },
    ],
    kind: slotName(ty.type, doc),
    title: val.v,
    lead: esc(tr('cdx.trait.lead', { n: num(val.n), total: num(doc.total), pct: pct(share) })),
    art: val.art ? `<div class="cdx-art-one is-trait">${traitShot(val.art, { lazy: false })}</div>` : '',
    cta: `${val.listed ? `<a class="ctr-btn is-primary" href="${tradeLink(ty.type, val, false)}">${
      esc(tr('ctr.insp.cta.sale', { n: num(val.listed) }))}</a>` : ''}
      <a class="ctr-btn" href="${tradeLink(ty.type, val, true)}">${esc(t('ctr.insp.cta.all'))}</a>`,
    facts: [
      val.of ? [t('ctr.insp.partof'), `<b>${esc(val.of)}</b>`] : null,
      [t('ctr.insp.wearers'), `<b>${num(val.n)}</b><span class="cdx-sub">${
        esc(tr('ctr.insp.ofTotal', { total: num(doc.total) }))}</span>`],
      [t('ctr.insp.share'), `<b>${esc(pct(share))}</b>`],
      [t('cdx.f.rarestin'), `<b>${esc(tr('cdx.f.rankOf', { n: num(rank), total: num(ty.count) }))}</b>`],
      [t('ctr.insp.forsale'), val.listed ? `<b>${num(val.listed)}</b>`
        : `<span class="cdx-dim">${esc(t('ctr.insp.nonelisted'))}</span>`],
      val.floorEth != null ? [t('ctr.insp.floor'), `<b>${esc(eth(val.floorEth))}</b>`] : null,
    ],
    blocks: [
      railBlock(t('cdx.trait.pieces'), (val.items || []).map(x => {
        const inner = `<span class="cdx-tile-shot is-trait">${traitShot(x.art)}</span>
          <span class="cdx-tile-n">${esc(x.n)}</span>
          <span class="cdx-tile-c">${esc(slotName(x.c, doc))}</span>`;
        // A one-of-one's bespoke parts never carried an attribute of their own, so the
        // collection has no trait to open. Those are shown, not linked to nowhere.
        return doc.types.some(s => s.type === x.c)
          ? `<a class="cdx-tile" href="${codexHref('trait', x.c, x.n)}" title="${esc(x.n)}">${inner}</a>`
          : `<span class="cdx-tile is-static" title="${esc(x.n)}">${inner}</span>`;
      })),
      railBlock(tr('cdx.trait.siblings', { slot: slotName(ty.type, doc) }), siblings.map(v => `
        <a class="cdx-tile" href="${codexHref('trait', ty.type, v.v)}" title="${esc(v.v)}">
          <span class="cdx-tile-shot is-trait">${traitShot(v.art)}</span>
          <span class="cdx-tile-n">${esc(v.v)}</span>
          <span class="cdx-tile-c">${esc(tr('cdx.trait.wearers', { n: num(v.n) }))}</span>
        </a>`), { more: { href: '/collections/traits', label: t('cdx.trait.allSlots') } }),
    ],
    note: esc(t('cdx.src.traits')),
  });
}

/* ----------------------------------------------------------------- creature */

// Holders call a Creature by the number in its name — #3379 — while the chain calls it
// by a 39-digit token id left over from the StarkEx migration. The readable one belongs
// in the URL, so a short number is resolved through the collection search first, and a
// pasted token id gets rewritten to the short form once the name tells us what it is.
async function resolveCreature(id) {
  if (id.length >= 20) return id;
  const res = await fetch(`/api/market/creatures/browse?scope=all&q=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('browse');
  const doc = await res.json();
  const hit = (doc.items || []).find(i => String(i.name || '').endsWith(`#${id}`));
  return hit ? String(hit.tokenId) : null;
}

// A number a Creature is actually known by, pulled back out of its name.
function creatureNumber(token) {
  const m = String(token.name || '').match(/#(\d+)/);
  return m ? m[1] : null;
}

function creaturePage(token, listing, doc) {
  const all = (token.attributes || []).filter(a => a.trait && a.value != null);
  const rarity = all.find(a => /rarity/i.test(a.trait));
  // Rarity is a fact about the Creature, not something it wears, and it already has a
  // row of its own above.
  const attrs = all.filter(a => a !== rarity);
  const price = listing && (listing.totalEth ?? listing.priceEth);

  return shell({
    accent: 'var(--hr-primary)',
    crumbs: [{ label: t('cdx.crumb.creatures'), href: '/trade' }, { label: token.name }],
    kind: t('cdx.creature.kind'),
    title: token.name,
    lead: token.rank
      ? esc(tr('cdx.creature.lead', { rank: num(token.rank), total: num(token.rankOf) })) : '',
    art: token.image
      ? `<div class="cdx-art-one is-creature">
          <img src="${esc(token.image)}" alt="${esc(token.name)}" decoding="async"></div>`
      : '',
    cta: `<a class="ctr-btn is-primary" href="/trade?coll=creatures&token=${
      encodeURIComponent(token.tokenId)}">${esc(t(price != null ? 'cdx.creature.buy' : 'cdx.creature.open'))}</a>`,
    facts: [
      [t('cdx.f.number'), `<b>#${esc(creatureNumber(token) || token.tokenId)}</b>`],
      rarity ? [t('cdx.f.rarity'), `<b>${esc(rarity.value)}</b>`] : null,
      token.rank ? [t('cdx.f.rank'), `<b>${
        esc(tr('cdx.f.rankOf', { n: num(token.rank), total: num(token.rankOf) }))}</b>`] : null,
      [t('cdx.f.listed'), price != null ? `<b>${esc(eth(price))}</b>`
        : `<span class="cdx-dim">${esc(t('ctr.insp.nonelisted'))}</span>`],
      token.owner ? [t('cdx.f.owner'), `<span class="cdx-mono">${esc(shortWallet(token.owner))}</span>`] : null,
    ],
    blocks: [
      railBlock(t('cdx.creature.traits'), attrs.map(a => {
        const inner = `<span class="cdx-tile-n">${esc(a.value)}</span>
          <span class="cdx-tile-c">${esc(slotName(a.trait, doc))}</span>`;
        return doc && doc.types.some(s => s.type === a.trait)
          ? `<a class="cdx-tile is-wide" href="${codexHref('trait', a.trait, a.value)}">${inner}</a>`
          : `<span class="cdx-tile is-wide is-static">${inner}</span>`;
      }), { sub: tr('cdx.creature.traitsSub', { n: num(attrs.length) }) }),
      token.description ? prose(t('cdx.creature.about'), `<p>${esc(token.description)}</p>`) : '',
    ],
    note: esc(t('cdx.src.creature')),
  });
}

/* ---------------------------------------------------------------- the view */

function ensureView() {
  if (view && document.body.contains(view)) return view;
  view = document.getElementById('codex-view');
  return view;
}

// An entity page takes over the Collections panel: the sub-tabs and both sub-panels step
// aside so the page owns the screen, the way an article would.
function setOpen(on) {
  const panel = document.getElementById('panel-collections');
  if (!panel) return;
  panel.classList.toggle('is-codex', on);
  const nav = document.getElementById('collections-top');
  if (nav) nav.hidden = on;
  const v = ensureView();
  if (v) v.hidden = !on;
}

export function closeCodex() {
  current = null;
  seq++;
  document.title = siteTitle;
  setOpen(false);
  const v = ensureView();
  if (v) v.innerHTML = '';
}

export function rerenderCodex() {
  if (current) openCodex(current.kind, current.args);
}

// Open one entity page. `args` are the decoded path segments after the kind.
export async function openCodex(kind, args) {
  if (!KINDS.has(kind)) { closeCodex(); return; }
  const v = ensureView();
  if (!v) return;
  current = { kind, args };
  const mine = ++seq;
  setOpen(true);
  v.innerHTML = loading();

  let html;
  try {
    if (kind === 'release' || kind === 'item') {
      const archive = await collectionsData();
      html = kind === 'release' ? releasePage(archive, args[0]) : itemPage(archive, args[0]);
    } else if (kind === 'trait') {
      html = traitPage(await traitCatalogue(), args[0], args[1]);
    } else {
      const asked = String(args[0] || '').replace(/\D/g, '');
      const id = asked ? await resolveCreature(asked) : null;
      if (!id) {
        html = missing(t('cdx.missing.creature'));
      } else {
        // The listing and the trait catalogue are niceties: a Creature that isn't for sale
        // still has a page, and a marketplace hiccup must not cost the reader its rank and
        // its traits. Only the token read is allowed to fail the page.
        const [tokenRes, listRes, doc] = await Promise.all([
          fetch(`/api/market/creatures/token/${id}`),
          fetch(`/api/market/creatures/listing/${id}`).catch(() => null),
          traitCatalogue().catch(() => null),
        ]);
        if (!tokenRes.ok) throw new Error('token');
        const token = await tokenRes.json();
        // A token that isn't in the collection answers 200 with a shell of nulls, and so
        // does a metadata read that quietly failed. Neither is "a Creature wearing
        // nothing", so neither gets drawn as one.
        if (!token.attributes?.length && !token.image && !token.owner) {
          const live = token.health?.state === 'live';
          html = missing(t(live ? 'cdx.missing.creature' : 'cdx.error'));
        } else {
          const listing = listRes && listRes.ok ? (await listRes.json()).listing : null;
          html = creaturePage(token, listing, doc);
          // Land the readable address in the bar, whichever form was asked for.
          const short = creatureNumber(token);
          const canon = short ? codexHref('creature', short) : null;
          if (canon && location.pathname !== canon) history.replaceState(null, '', canon);
        }
      }
    }
  } catch (err) {
    html = missing(t(err && err.message === 'indexing' ? 'ctr.indexing' : 'cdx.error'));
  }
  if (mine !== seq) return;   // a newer page opened while this one was still fetching
  v.innerHTML = html;
  const name = v.querySelector('.cdx-title');
  document.title = name ? `${name.textContent} · ${siteTitle}` : siteTitle;
  v.querySelectorAll('[data-codex-close]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    history.pushState(null, '', '/collections');
    closeCodex();
  }));
}
