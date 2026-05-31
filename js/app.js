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

const initialTab = ['roadmap', 'holders', 'changelog'].find(name => location.hash === `#${name}`);
if (initialTab) selectTab(initialTab, false);

initI18n().then(rerenderChangelog);
