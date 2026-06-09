import { initI18n, setLanguage } from './i18n.js';
import { loadHoldersChart } from './holders.js';
import { loadMarketChart, rerenderMarket } from './market.js';
import { loadChangelog, rerenderChangelog } from './changelog.js';
import { loadApply, rerenderApply } from './apply.js';
import { loadElection, rerenderElection } from './election.js';

// Language switcher — re-render dynamic views after language change
document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => setLanguage(btn.dataset.lang).then(() => {
    rerenderChangelog();
    rerenderMarket();
    rerenderApply();
    rerenderElection();
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

function selectTab(name, updateHash = true) {
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
  if (name === 'apply'     && !applyLoaded)     { applyLoaded     = true; loadApply(); loadElection(); }
  if (updateHash) history.replaceState(null, '', `#${name}`);
}

tabButtons.forEach(btn => btn.addEventListener('click', () => selectTab(btn.dataset.tab)));

// Landing hub cards — jump to a tab and return to the top
document.querySelectorAll('[data-goto]').forEach(el => {
  el.addEventListener('click', () => {
    selectTab(el.dataset.goto);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

// Guides sub-tabs (Basics / Walkthroughs / Stay safe / Links)
const subTabs   = document.querySelectorAll('[data-subtab]');
const subPanels = document.querySelectorAll('[data-subpanel]');
function selectSubTab(name) {
  subTabs.forEach(btn => {
    const active = btn.dataset.subtab === name;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  subPanels.forEach(p => { p.hidden = p.dataset.subpanel !== name; });
}
subTabs.forEach(btn => btn.addEventListener('click', () => {
  selectSubTab(btn.dataset.subtab);
  document.getElementById('guides-top')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}));

const HASH_TABS = ['club', 'council', 'apply', 'roadmap', 'guides', 'perks', 'holders', 'market', 'changelog', 'terms', 'privacy'];

// Footer / in-page links like #terms and #privacy switch tabs (and deep-links on load)
window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (HASH_TABS.includes(name)) {
    selectTab(name, false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

const initialTab = HASH_TABS.filter(n => n !== 'club').find(name => location.hash === `#${name}`);
if (initialTab) selectTab(initialTab, false);

// Re-render dynamic views once translations are loaded. A deep-link to #apply (e.g.
// the OAuth callback redirect) triggers loadApply() before initI18n() resolves, so
// without this the panel would show raw keys until the next language switch.
initI18n().then(() => {
  rerenderChangelog();
  rerenderApply();
  rerenderElection();
  rerenderMarket();
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
