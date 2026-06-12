import { t, getCurrentLang } from './i18n.js';

// Bi-weekly Gen 2 progress. Fetches /gen2-progress.json — the one file edited for
// each bi-weekly community update — and re-renders the horizontal roadmap (one stop
// per set, with its five phases) and the "next two weeks" focus note.
// If the fetch fails, the static fallback markup in index.html stays in place.

let cachedData = null;

const SET_META = {
  zombies:    { ico: '🧟', accent: 'var(--hr-primary)',   soft: 'var(--hr-primary-25)' },
  vampires:   { ico: '🧛', accent: 'var(--hr-alert)',     soft: 'var(--hr-alert-15)' },
  werewolves: { ico: '🐺', accent: 'var(--hr-tangerine)', soft: 'color-mix(in srgb, var(--hr-tangerine) 25%, transparent)' },
  demons:     { ico: '😈', accent: 'var(--hr-secondary)', soft: 'var(--hr-secondary-25)' },
  ghosts:     { ico: '👻', accent: 'var(--hr-blueberry)', soft: 'color-mix(in srgb, var(--hr-blueberry) 25%, transparent)' },
  slimes:     { ico: '🫠', accent: 'var(--hr-banana)',    soft: 'var(--hr-banana-25)' },
};
const STAGES = 5;
// The stop cards list only the production phases — stage 5 ("In game") stays out
// of the checklist; a set that reaches it shows an "In game" live chip, and
// done: 5 flips the whole stop to "Complete".
const PHASES_SHOWN = 4;

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Optional per-language overrides, same shape as changelog.json entries
function tr(obj, field) {
  const lang = getCurrentLang();
  return (lang !== 'en' && obj.i18n?.[lang]?.[field]) || obj[field] || '';
}

export async function loadGen2() {
  try {
    const res = await fetch('/gen2-progress.json');
    if (!res.ok) throw new Error();
    cachedData = await res.json();
  } catch { return; }
  renderAll();
}

export function rerenderGen2() { if (cachedData) renderAll(); }

function stageName(n) { return t(`g2.pipe.s${n}.h`); }

function doneCount(set) { return Math.max(0, Math.min(set.done ?? 0, STAGES)); }

function chip(set) {
  const done = doneCount(set);
  if (done >= STAGES) return `<span class="g2-chip is-live">${esc(t('g2.status.done'))}</span>`;
  if (set.active) {
    return `<span class="g2-chip is-live"><span class="g2-chip-dot"></span>${esc(stageName(done + 1))}</span>`;
  }
  if (set.status === 'next') return `<span class="g2-chip is-next">${esc(t('g2.status.next'))}</span>`;
  return `<span class="g2-chip">${esc(t('g2.status.queued'))}</span>`;
}

function phases(set) {
  const done = doneCount(set);
  const cur = set.active && done < STAGES ? done + 1 : 0;
  let items = '';
  for (let i = 1; i <= PHASES_SHOWN; i++) {
    const state = i <= done ? ' is-done' : (i === cur ? ' is-now' : '');
    items += `<li class="g2-phase${state}">${esc(stageName(i))}</li>`;
  }
  return `<ul class="g2-phases">${items}</ul>`;
}

function renderAll() {
  const sets = (cachedData.sets || []).filter(s => SET_META[s.id]);

  const road = document.getElementById('g2-road');
  if (road && sets.length) {
    road.innerHTML = sets.map(set => {
      const m = SET_META[set.id];
      const done = doneCount(set);
      const stopState = done >= STAGES ? ' is-past' : (set.active ? ' is-live' : '');
      const note = tr(set, 'note');
      return `
      <div class="g2-stop${stopState}" style="--accent:${m.accent};--accent-soft:${m.soft}">
        <span class="g2-stop-node"></span>
        <div class="g2-stop-card">
          <span class="g2-set-glow"></span>
          <span class="g2-set-ico">${m.ico}</span>
          <h4 class="g2-set-h">${esc(t(`g2.set.${set.id}.h`))}</h4>
          ${chip(set)}
          ${phases(set)}
          ${note ? `<p class="g2-stop-note">${esc(note)}</p>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  const focus = document.getElementById('g2-focus');
  if (focus) {
    const txt = tr(cachedData, 'focus');
    focus.hidden = !txt;
    const p = document.getElementById('g2-focus-p');
    if (p) p.textContent = txt;
  }
}
