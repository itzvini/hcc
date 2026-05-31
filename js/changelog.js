import { t, getCurrentLang } from './i18n.js';

let cachedData = null;

export async function loadChangelog() {
  try {
    const res = await fetch('/changelog.json');
    if (!res.ok) throw new Error();
    cachedData = await res.json();
  } catch {
    ['cl-club-list', 'cl-site-list'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<p class="cl-empty">${t('changelog.empty')}</p>`;
    });
    return;
  }
  renderAll();
}

export function rerenderChangelog() {
  if (cachedData) renderAll();
}

function renderAll() {
  renderSection('cl-club-list', cachedData.club || []);
  renderSection('cl-site-list', cachedData.site || []);
}

function tr(entry, field) {
  const lang = getCurrentLang();
  return (lang !== 'en' && entry.i18n?.[lang]?.[field]) || entry[field] || '';
}

function renderSection(containerId, entries) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!entries.length) {
    el.innerHTML = `<p class="cl-empty">${t('changelog.empty')}</p>`;
    return;
  }
  el.innerHTML = entries.map((e, i) => `
    <div class="cl-entry">
      <div class="cl-date">${tr(e, 'date')}${i === 0 ? `<span class="cl-latest-badge">${t('changelog.latest')}</span>` : ''}</div>
      <div class="cl-title">${tr(e, 'title')}</div>
      ${e.body ? `<div class="cl-body">${tr(e, 'body')}</div>` : ''}
      ${e.tag ? `<span class="cl-tag ${e.tag}">${e.tag}</span>` : ''}
    </div>
  `).join('');
}
