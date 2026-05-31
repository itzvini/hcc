import { t } from './i18n.js';

export async function loadChangelog() {
  try {
    const res = await fetch('/changelog.json');
    if (!res.ok) throw new Error();
    const data = await res.json();
    renderSection('cl-club-list', data.club || []);
    renderSection('cl-site-list', data.site || []);
  } catch {
    ['cl-club-list', 'cl-site-list'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<p class="cl-empty">${t('changelog.empty')}</p>`;
    });
  }
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
      <div class="cl-date">${e.date}${i === 0 ? `<span class="cl-latest-badge">${t('changelog.latest')}</span>` : ''}</div>
      <div class="cl-title">${e.title}</div>
      ${e.body ? `<div class="cl-body">${e.body}</div>` : ''}
      ${e.tag ? `<span class="cl-tag ${e.tag}">${e.tag}</span>` : ''}
    </div>
  `).join('');
}
