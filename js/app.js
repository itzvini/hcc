import { initI18n, setLanguage } from './i18n.js';
import { loadHoldersChart } from './holders.js';
import { loadMarketChart, rerenderMarket } from './market.js';
import { loadChangelog, rerenderChangelog } from './changelog.js';
import { loadApply, rerenderApply } from './apply.js';
import { loadElection, rerenderElection } from './election.js';
import { loadBallot, rerenderBallot } from './ballot.js';
import { loadVote, rerenderVote } from './vote.js';
import { loadMarketplace, rerenderMarketplace } from './marketplace.js';
import { loadGen2, rerenderGen2 } from './gen2.js';

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
    rerenderGen2();
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
let applyLoaded     = false;
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
  if (name === 'apply'     && !applyLoaded)     { applyLoaded     = true; loadApply(); loadElection(); loadBallot(); loadVote(); }
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

// Walkthrough stepper — Guides › Walkthroughs shows one guide at a time instead of
// one long scroll: chip tabs jump to any step, prev/next walks the sequence.
const wtNav = document.querySelector('.wt-nav');
if (wtNav) {
  const guidesPanel = wtNav.closest('.tab-panel');
  const wtTabs   = [...wtNav.querySelectorAll('[data-wt]')];
  const wtPanels = [...guidesPanel.querySelectorAll('[data-wt-panel]')];
  const wtTotal  = wtPanels.length;
  const wtPrev   = guidesPanel.querySelector('[data-wt-prev]');
  const wtNext   = guidesPanel.querySelector('[data-wt-next]');
  const wtCount  = guidesPanel.querySelector('[data-wt-count]');
  let wtCurrent  = 1;

  function showWalkthrough(n, { scroll = false, focusTab = false } = {}) {
    n = Math.min(wtTotal, Math.max(1, n));
    // Stop any video in the panel we're leaving so its audio doesn't linger.
    if (n !== wtCurrent) {
      const leaving = wtPanels.find(p => Number(p.dataset.wtPanel) === wtCurrent);
      const frame = leaving && leaving.querySelector('iframe');
      if (frame) frame.src = frame.src; // eslint-disable-line no-self-assign
    }
    wtCurrent = n;
    wtTabs.forEach(t => {
      const active = Number(t.dataset.wt) === n;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
    });
    wtPanels.forEach(p => { p.hidden = Number(p.dataset.wtPanel) !== n; });
    if (wtPrev)  wtPrev.disabled = n === 1;
    if (wtNext)  wtNext.disabled = n === wtTotal;
    if (wtCount) wtCount.textContent = `${n} / ${wtTotal}`;
    if (scroll)   wtNav.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (focusTab) wtTabs.find(t => Number(t.dataset.wt) === n)?.focus();
  }

  wtTabs.forEach(t => t.addEventListener('click', () => showWalkthrough(Number(t.dataset.wt), { scroll: true })));
  wtPrev?.addEventListener('click', () => showWalkthrough(wtCurrent - 1, { scroll: true }));
  wtNext?.addEventListener('click', () => showWalkthrough(wtCurrent + 1, { scroll: true }));
  wtNav.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    showWalkthrough(wtCurrent + (e.key === 'ArrowRight' ? 1 : -1), { focusTab: true });
  });

  showWalkthrough(1);
}

// Clean tab URLs — every tab (and sub-tab) is a real path the server also serves:
// /council, /roadmap/gen2, … Tab clicks push the path; legacy #tab links and
// in-page anchors (#terms, #council) still work and get normalized to paths.
const ROUTE_TABS = ['club', 'council', 'apply', 'roadmap', 'guides', 'perks', 'holders', 'market', 'trade', 'changelog', 'contribute', 'terms', 'privacy'];

function urlFor(name, sub) {
  return name === 'club' && !sub ? '/' : `/${name}${sub ? `/${sub}` : ''}`;
}

function route(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  const tab = ROUTE_TABS.includes(segs[0]) ? segs[0] : 'club';
  selectTab(tab, false);
  if (segs[1] && /^[a-z0-9-]+$/.test(segs[1])) {
    const scope = document.getElementById(`panel-${tab}`);
    if (scope && scope.querySelector(`[data-subtab="${segs[1]}"]`)) selectSubTab(scope, segs[1]);
  }
}

// Back/forward navigation
window.addEventListener('popstate', () => route(location.pathname));

// Legacy hash links switch tabs; the URL is normalized to the path form.
window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (ROUTE_TABS.includes(name)) {
    history.replaceState(null, '', urlFor(name) + location.search);
    selectTab(name, false);
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
  rerenderGen2();
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
  const pets = document.querySelectorAll('.pet-wrap object[data]');
  await Promise.all([...pets].map(async obj => {
    try {
      const data = obj.getAttribute('data');
      const base = data.replace(/[^/]+$/, '');
      const res = await fetch(data);
      const text = await res.text();
      const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
      svg.querySelectorAll('image[href]').forEach(img => {
        const href = img.getAttribute('href');
        if (href && !href.startsWith('/') && !href.startsWith('http')) {
          img.setAttribute('href', base + href);
        }
      });
      svg.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none';
      obj.replaceWith(svg);
    } catch {}
  }));
})();
