import { initI18n, setLanguage } from './i18n.js';
import { loadHoldersChart } from './holders.js';
import { loadChangelog, rerenderChangelog } from './changelog.js';

// Language switcher — re-render changelog after language change
document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => setLanguage(btn.dataset.lang).then(rerenderChangelog));
});

// Tabs
const tabButtons = document.querySelectorAll('[data-tab]');
const tabPanels  = document.querySelectorAll('.tab-panel');
let holdersLoaded   = false;
let changelogLoaded = false;

function selectTab(name, updateHash = true) {
  tabButtons.forEach(btn => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  tabPanels.forEach(panel => {
    const active = panel.id === `panel-${name}`;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
  if (name === 'holders'   && !holdersLoaded)   { holdersLoaded   = true; loadHoldersChart(); }
  if (name === 'changelog' && !changelogLoaded) { changelogLoaded = true; loadChangelog(); }
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

const initialTab = ['roadmap', 'guides', 'holders', 'changelog'].find(name => location.hash === `#${name}`);
if (initialTab) selectTab(initialTab, false);

initI18n().then(rerenderChangelog);
