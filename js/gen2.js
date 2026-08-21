import { t, getCurrentLang } from './i18n.js';

// Bi-weekly Gen 2 progress. Two boards, one renderer:
//   • the creature sets  → /gen2-progress.json      → #g2-road  (Roadmap › Gen 2 Creatures)
//   • the pets           → /gen2-pets-progress.json → #g2p-road (Roadmap › Gen 2 Pets)
// Each file is the one thing edited for a bi-weekly community update. A board draws a
// horizontal roadmap (one stop per set, with its phases) and, where the board declares
// one, a "next two weeks" focus note. The pets board deliberately has no focus note: its
// per-set stops are the only place it states where the work is.
// If a fetch fails, the static fallback markup in index.html stays in place.

const STAGES = 5;
// The stop cards list only the production phases — stage 5 ("In game") stays out
// of the checklist; a set that reaches it shows an "In game" live chip, and
// done: 5 flips the whole stop to "Complete".
const PHASES_SHOWN = 4;

// One entry per board. `prefix` picks the i18n namespace for the set names and the
// phase names; the status chips ("Up next", "Queued", "Complete") are the same words
// on both boards, so those keys stay shared under g2.status.*.
const BOARDS = [
  {
    file: '/gen2-progress.json',
    prefix: 'g2',
    road: 'g2-road', focus: 'g2-focus', focusText: 'g2-focus-p',
    sets: {
      vampires:   { ico: '🧛', accent: 'var(--hr-alert)',     soft: 'var(--hr-alert-15)' },
      werewolves: { ico: '🐺', accent: 'var(--hr-tangerine)', soft: 'color-mix(in srgb, var(--hr-tangerine) 25%, transparent)' },
      demons:     { ico: '😈', accent: 'var(--hr-secondary)', soft: 'var(--hr-secondary-25)' },
      ghosts:     { ico: '👻', accent: 'var(--hr-blueberry)', soft: 'color-mix(in srgb, var(--hr-blueberry) 25%, transparent)' },
      slimes:     { ico: '🫠', accent: 'var(--hr-banana)',    soft: 'var(--hr-banana-25)' },
      zombies:    { ico: '🧟', accent: 'var(--hr-primary)',   soft: 'var(--hr-primary-25)' },
    },
  },
  {
    file: '/gen2-pets-progress.json',
    prefix: 'g2p',
    road: 'g2p-road', // no focus note on this board, on purpose
    sets: {
      sushi:     { ico: '🍣', accent: 'var(--hr-alert)',     soft: 'var(--hr-alert-15)' },
      dessert:   { ico: '🍮', accent: 'var(--hr-tangerine)', soft: 'color-mix(in srgb, var(--hr-tangerine) 25%, transparent)' },
      nature:    { ico: '🌿', accent: 'var(--hr-primary)',   soft: 'var(--hr-primary-25)' },
      celestial: { ico: '🌙', accent: 'var(--hr-secondary)', soft: 'var(--hr-secondary-25)' },
      elemental: { ico: '⚡', accent: 'var(--hr-banana)',    soft: 'var(--hr-banana-25)' },
    },
  },
];

const cached = new Map(); // board.file → parsed JSON

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
  await Promise.all(BOARDS.map(async board => {
    try {
      const res = await fetch(board.file);
      if (!res.ok) throw new Error();
      cached.set(board.file, await res.json());
    } catch { return; }
    render(board);
  }));
}

export function rerenderGen2() {
  BOARDS.forEach(board => { if (cached.has(board.file)) render(board); });
}

function doneCount(set) { return Math.max(0, Math.min(set.done ?? 0, STAGES)); }

function chip(board, set) {
  const done = doneCount(set);
  if (done >= STAGES) return `<span class="g2-chip is-live">${esc(t('g2.status.done'))}</span>`;
  if (set.active) {
    const stage = t(`${board.prefix}.pipe.s${done + 1}.h`);
    return `<span class="g2-chip is-live"><span class="g2-chip-dot"></span>${esc(stage)}</span>`;
  }
  if (set.status === 'next') return `<span class="g2-chip is-next">${esc(t('g2.status.next'))}</span>`;
  return `<span class="g2-chip">${esc(t('g2.status.queued'))}</span>`;
}

function phases(board, set) {
  const done = doneCount(set);
  const cur = set.active && done < STAGES ? done + 1 : 0;
  let items = '';
  for (let i = 1; i <= PHASES_SHOWN; i++) {
    const state = i <= done ? ' is-done' : (i === cur ? ' is-now' : '');
    items += `<li class="g2-phase${state}">${esc(t(`${board.prefix}.pipe.s${i}.h`))}</li>`;
  }
  return `<ul class="g2-phases">${items}</ul>`;
}

// Fills the focus note and hides it when the file carries no text.
function noteCard(data, wrapId, textId, field) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const txt = tr(data, field);
  wrap.hidden = !txt;
  const p = document.getElementById(textId);
  if (p) p.textContent = txt;
}

function render(board) {
  const data = cached.get(board.file);
  if (!data) return;
  const sets = (data.sets || []).filter(s => board.sets[s.id]);

  const road = document.getElementById(board.road);
  if (road && sets.length) {
    road.innerHTML = sets.map(set => {
      const m = board.sets[set.id];
      const done = doneCount(set);
      const stopState = done >= STAGES ? ' is-past' : (set.active ? ' is-live' : '');
      const note = tr(set, 'note');
      return `
      <div class="g2-stop${stopState}" style="--accent:${m.accent};--accent-soft:${m.soft}">
        <span class="g2-stop-node"></span>
        <div class="g2-stop-card">
          <span class="g2-set-glow"></span>
          <span class="g2-set-ico">${m.ico}</span>
          <h4 class="g2-set-h">${esc(t(`${board.prefix}.set.${set.id}.h`))}</h4>
          ${chip(board, set)}
          ${phases(board, set)}
          ${note ? `<p class="g2-stop-note">${esc(note)}</p>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  if (board.focus) noteCard(data, board.focus, board.focusText, 'focus');
}
