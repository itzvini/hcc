import { initI18n, setLanguage } from './i18n.js';
import { loadHoldersChart } from './holders.js';
import { loadMarketChart, rerenderMarket } from './market.js';
import { loadChangelog, rerenderChangelog } from './changelog.js';
import { loadApply, rerenderApply } from './apply.js';
import { loadElection, rerenderElection } from './election.js';
import { loadBallot, rerenderBallot } from './ballot.js';
import { loadVote, rerenderVote } from './vote.js';
import { loadMarketplace, rerenderMarketplace } from './marketplace.js';
import { loadPolls, rerenderPolls } from './polls.js';
import { loadAnnouncements, rerenderAnnouncements } from './announcements.js';
import { loadGen2, rerenderGen2 } from './gen2.js';
import { initGuideDemos, rerenderGuideDemos } from './guide-demos.js';
import { initPerks, rerenderPerks } from './perks.js';
import { initSafety, rerenderSafety } from './safety.js';

// Language switcher — re-render dynamic views after language change
document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => setLanguage(btn.dataset.lang).then(() => {
    rerenderChangelog();
    rerenderMarket();
    rerenderApply();
    rerenderElection();
    rerenderBallot();
    rerenderVote();
    rerenderMarketplace();
    rerenderPolls();
    rerenderAnnouncements();
    rerenderGen2();
    rerenderGuideDemos();
    rerenderPerks();
    rerenderSafety();
  }));
});

// Tabs
const tabButtons = document.querySelectorAll('[data-tab]');
const tabPanels  = document.querySelectorAll('.tab-panel');
const navDrawer  = document.getElementById('nav-drawer');
const navToggle  = document.getElementById('nav-toggle');
const navCurrent = document.getElementById('nav-current');
let holdersLoaded   = false;
let marketLoaded    = false;
let changelogLoaded = false;
let councilLoaded   = false;
let pollsLoaded     = false;
let announcementsLoaded = false;
let tradeLoaded     = false;
let roadmapLoaded   = false;

// Mobile drawer open/close
function setDrawer(open) {
  navDrawer.classList.toggle('is-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
}
navToggle.addEventListener('click', () => setDrawer(!navDrawer.classList.contains('is-open')));
document.addEventListener('keydown', e => { if (e.key === 'Escape') setDrawer(false); });
document.addEventListener('click', e => {
  if (navDrawer.classList.contains('is-open') &&
      !navDrawer.contains(e.target) && !navToggle.contains(e.target)) setDrawer(false);
});

// Frost the tab bar only while it's actually pinned: a 1px sentinel sits right above
// it; when the sentinel scrolls out of view the bar is stuck and gains its backdrop
// (.is-stuck in CSS). At rest the bar is transparent — no floating strip mid-page.
const pageTabs = document.querySelector('.page-tabs');
if (pageTabs && 'IntersectionObserver' in window) {
  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.style.cssText = 'position:relative;height:1px;margin-top:-1px;visibility:hidden';
  pageTabs.parentNode.insertBefore(sentinel, pageTabs);
  new IntersectionObserver(entries => {
    pageTabs.classList.toggle('is-stuck', !entries[0].isIntersecting);
  }).observe(sentinel);
}

function selectTab(name, updateUrl = true) {
  tabButtons.forEach(btn => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
    // Mirror the active section into the compact mobile bar (keeps i18n in sync)
    if (active && navCurrent) {
      navCurrent.textContent = btn.textContent;
      if (btn.dataset.i18n) navCurrent.dataset.i18n = btn.dataset.i18n;
    }
  });
  setDrawer(false);
  tabPanels.forEach(panel => {
    const active = panel.id === `panel-${name}`;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
  if (name === 'holders'   && !holdersLoaded)   { holdersLoaded   = true; loadHoldersChart(); }
  if (name === 'market'    && !marketLoaded)    { marketLoaded    = true; loadMarketChart(); }
  if (name === 'changelog' && !changelogLoaded) { changelogLoaded = true; loadChangelog(); }
  if (name === 'council'   && !councilLoaded)   { councilLoaded   = true; loadApply(); loadElection(); loadBallot(); loadVote(); }
  if (name === 'polls'     && !pollsLoaded)     { pollsLoaded     = true; loadPolls(); }
  if (name === 'announcements' && !announcementsLoaded) { announcementsLoaded = true; loadAnnouncements(); }
  if (name === 'trade'     && !tradeLoaded)     { tradeLoaded     = true; loadMarketplace(); }
  if (name === 'roadmap'   && !roadmapLoaded)   { roadmapLoaded   = true; loadGen2(); }
  if (updateUrl && location.pathname !== urlFor(name)) history.pushState(null, '', urlFor(name));
}

tabButtons.forEach(btn => btn.addEventListener('click', () => selectTab(btn.dataset.tab)));

// Landing hub cards — jump to a tab and return to the top
document.querySelectorAll('[data-goto]').forEach(el => {
  el.addEventListener('click', () => {
    selectTab(el.dataset.goto);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

// Sub-tabs (Guides: Basics/Walkthroughs/…, Roadmap: Milestones/Gen 2) — scoped to
// the page panel the sub-nav lives in, so each page only drives its own subpanels.
function selectSubTab(scope, name) {
  scope.querySelectorAll('[data-subtab]').forEach(btn => {
    const active = btn.dataset.subtab === name;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  scope.querySelectorAll('[data-subpanel]').forEach(p => { p.hidden = p.dataset.subpanel !== name; });
}
function jumpSubTab(el, name) {
  const scope = el.closest('.tab-panel');
  if (!scope) return;
  selectSubTab(scope, name);
  history.replaceState(null, '', urlFor(scope.id.replace(/^panel-/, ''), name));
  scope.querySelector('.subnav-top')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
document.querySelectorAll('[data-subtab]').forEach(btn =>
  btn.addEventListener('click', () => jumpSubTab(btn, btn.dataset.subtab)));
// In-page jumps that switch sub-tab (e.g. the Gen 2 CTA at the end of Milestones)
document.querySelectorAll('[data-subgoto]').forEach(el =>
  el.addEventListener('click', () => jumpSubTab(el, el.dataset.subgoto)));

// Walkthrough steppers — show one guide at a time (chip tabs + prev/next) instead of
// one long scroll. Used by Guides › Walkthroughs, Guides › Marketplace, and the
// Contribute how-to. Steppers that live in a Guides sub-panel sync their active step
// into the URL (/guides/<subpanel>/<slug>) so individual steps are shareable and
// survive refresh; the Contribute stepper (no sub-panel) stays local-only.
const stepperRouters = {}; // { walkthroughs: fn, marketplace: fn } — driven by route()

function initStepper(nav) {
  const scope    = nav.closest('section');
  const subpanel = nav.closest('[data-subpanel]');
  const tabs     = [...nav.querySelectorAll('[data-wt]')];
  const panels   = [...scope.querySelectorAll('[data-wt-panel]')];
  const total    = panels.length;
  if (!total) return;
  const prevBtn  = scope.querySelector('[data-wt-prev]');
  const nextBtn  = scope.querySelector('[data-wt-next]');
  const countEl  = scope.querySelector('[data-wt-count]');
  const syncKey  = subpanel ? subpanel.dataset.subpanel : null; // null → no URL sync
  let current    = 1;

  const slugFor = n => tabs.find(t => Number(t.dataset.wt) === n)?.dataset.wtSlug || String(n);

  function show(n, { scroll = false, focusTab = false, updateUrl = false } = {}) {
    n = Math.min(total, Math.max(1, n));
    // Stop any video in the panel we're leaving so its audio doesn't linger.
    if (n !== current) {
      const leaving = panels.find(p => Number(p.dataset.wtPanel) === current);
      const frame = leaving && leaving.querySelector('iframe');
      if (frame) frame.src = frame.src; // eslint-disable-line no-self-assign
    }
    current = n;
    tabs.forEach(t => {
      const active = Number(t.dataset.wt) === n;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
    });
    panels.forEach(p => { p.hidden = Number(p.dataset.wtPanel) !== n; });
    if (prevBtn) prevBtn.disabled = n === 1;
    if (nextBtn) nextBtn.disabled = n === total;
    if (countEl) countEl.textContent = `${n} / ${total}`;
    if (syncKey && updateUrl) history.replaceState(null, '', `/guides/${syncKey}/${slugFor(n)}`);
    if (scroll)   nav.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (focusTab) tabs.find(t => Number(t.dataset.wt) === n)?.focus();
  }

  tabs.forEach(t => t.addEventListener('click', () => show(Number(t.dataset.wt), { scroll: true, updateUrl: true })));
  prevBtn?.addEventListener('click', () => show(current - 1, { scroll: true, updateUrl: true }));
  nextBtn?.addEventListener('click', () => show(current + 1, { scroll: true, updateUrl: true }));
  nav.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    show(current + (e.key === 'ArrowRight' ? 1 : -1), { focusTab: true, updateUrl: true });
  });

  if (syncKey) {
    stepperRouters[syncKey] = slug => {
      const match = tabs.find(t => t.dataset.wtSlug === slug || String(t.dataset.wt) === slug);
      show(match ? Number(match.dataset.wt) : 1);
    };
  }
  show(1);
}

document.querySelectorAll('.wt-nav').forEach(initStepper);

// In-card collection toggle (the marketplace walkthrough's Creatures ⇄ LAND switch).
// Scoped to its own card so it never clashes with the steppers or the live Trade panel.
document.querySelectorAll('[data-mkt-toggle]').forEach(group => {
  const scope  = group.closest('.wt-panel') || group.parentElement;
  const btns   = [...group.querySelectorAll('[data-mkt-btn]')];
  const blocks = [...scope.querySelectorAll('[data-mkt]')];
  function showMkt(key) {
    btns.forEach(b => {
      const on = b.dataset.mktBtn === key;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    blocks.forEach(bl => { bl.hidden = bl.dataset.mkt !== key; });
  }
  btns.forEach(b => b.addEventListener('click', () => showMkt(b.dataset.mktBtn)));
  showMkt('creatures');
});

// Interactive guide demos (Guides › Marketplace) — built now, animated only once
// visible; rerendered after initI18n() resolves and on language switch.
initGuideDemos();

// Perks tab — coin yield calculator (static markup, so it wires up immediately;
// number formatting and aria labels are refreshed once translations resolve).
initPerks();

// Scam Watch (Guides › Scam Watch) — spot-the-scam + persisted safety checklist.
// Static markup, so listeners attach now; count/progress strings and the tap-to-
// reveal tooltips are filled once translations resolve and on each language switch.
initSafety();

// Clean tab URLs — every tab (and sub-tab) is a real path the server also serves:
// /council, /polls, /roadmap/gen2, … Tab clicks push the path; legacy #tab links
// and in-page anchors (#terms, #council) still work and get normalized to paths.
// 'apply' is a legacy alias: the old Apply & Vote tab now lives at /council/vote,
// and route() rewrites it so bookmarks and old OAuth redirects keep working.
const ROUTE_TABS = ['club', 'announcements', 'council', 'apply', 'polls', 'roadmap', 'guides', 'perks', 'holders', 'market', 'trade', 'changelog', 'contribute', 'terms', 'privacy'];

function urlFor(name, sub) {
  return name === 'club' && !sub ? '/' : `/${name}${sub ? `/${sub}` : ''}`;
}

function route(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  let tab = ROUTE_TABS.includes(segs[0]) ? segs[0] : 'club';
  let sub = segs[1] && /^[a-z0-9-]+$/.test(segs[1]) ? segs[1] : null;
  if (tab === 'apply') {
    // Legacy path → the merged tab, keeping the query string (?auth= errors).
    tab = 'council';
    sub = 'vote';
    history.replaceState(null, '', '/council/vote' + location.search);
  }
  selectTab(tab, false);
  if (sub) {
    const scope = document.getElementById(`panel-${tab}`);
    if (scope && scope.querySelector(`[data-subtab="${sub}"]`)) selectSubTab(scope, sub);
  }
  // Deep link to a specific step, e.g. /guides/walkthroughs/funding or
  // /guides/marketplace/trading
  if (tab === 'guides' && sub && segs[2] && stepperRouters[sub]) {
    stepperRouters[sub](segs[2]);
  }
}

// Back/forward navigation
window.addEventListener('popstate', () => route(location.pathname));

// Legacy hash links switch tabs; the URL is normalized to the path form. Routing
// through route() keeps the '#apply' → /council/vote alias working here too.
window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (ROUTE_TABS.includes(name)) {
    history.replaceState(null, '', urlFor(name) + location.search);
    route(location.pathname);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

// Initial route: a legacy #tab hash (e.g. an old OAuth redirect or shared link)
// wins and is rewritten to its path; otherwise the path decides the tab.
const legacyTab = ROUTE_TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : null;
if (legacyTab) {
  history.replaceState(null, '', urlFor(legacyTab) + location.search);
  route(urlFor(legacyTab));
} else {
  route(location.pathname);
}

// Re-render dynamic views once translations are loaded. A deep-link to #apply (e.g.
// the OAuth callback redirect) triggers loadApply() before initI18n() resolves, so
// without this the panel would show raw keys until the next language switch.
initI18n().then(() => {
  rerenderChangelog();
  rerenderApply();
  rerenderElection();
  rerenderBallot();
  rerenderVote();
  rerenderMarket();
  rerenderMarketplace();
  rerenderPolls();
  rerenderAnnouncements();
  rerenderGen2();
  rerenderGuideDemos();
  rerenderPerks();
  rerenderSafety();
});

// Jump animation on hover / click / tap
document.querySelectorAll('.pet-wrap').forEach(pet => {
  function jumpPet() {
    pet.classList.remove('is-jumping');
    void pet.offsetWidth; // force reflow so re-triggering restarts the animation
    pet.classList.add('is-jumping');
  }
  pet.addEventListener('mouseenter', jumpPet);
  pet.addEventListener('click', jumpPet);
  pet.addEventListener('animationend', e => {
    if (e.animationName === 'pet-jump') pet.classList.remove('is-jumping');
  });
});

// Gen 2 roadmap — scroll-in reveals + count-up stats. Both no-op under reduced
// motion; the CSS only hides .g2-reveal when motion is welcome, so content stays
// visible even if the observer never fires.
const g2MotionOK = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function g2CountUp(el) {
  const target = parseInt(el.dataset.countup, 10);
  if (!Number.isFinite(target)) return;
  const dur = 900;
  let t0 = null;
  function frame(ts) {
    if (t0 === null) t0 = ts;
    const p = Math.min((ts - t0) / dur, 1);
    el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

const g2Reveals = document.querySelectorAll('.g2-reveal');
if (g2MotionOK && 'IntersectionObserver' in window && g2Reveals.length) {
  const g2io = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('is-in');
    entry.target.querySelectorAll('[data-countup]').forEach(g2CountUp);
    g2io.unobserve(entry.target);
  }), { threshold: 0.15 });
  g2Reveals.forEach(el => g2io.observe(el));
} else {
  g2Reveals.forEach(el => el.classList.add('is-in'));
}

// Fetch and inline pet SVGs so internal <g transform> paths render in document context
(async () => {
  const pets = document.querySelectorAll('.pet-wrap img[src]');
  await Promise.all([...pets].map(async img => {
    try {
      const src = img.getAttribute('src');
      const base = src.replace(/[^/]+$/, '');
      const res = await fetch(src);
      const text = await res.text();
      const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
      svg.querySelectorAll('image[href]').forEach(el => {
        const href = el.getAttribute('href');
        if (href && !href.startsWith('/') && !href.startsWith('http')) {
          el.setAttribute('href', base + href);
        }
      });
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', img.getAttribute('alt') || '');
      svg.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none';
      img.replaceWith(svg);
    } catch {}
  }));
})();
