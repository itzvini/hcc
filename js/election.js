import { t } from './i18n.js';

// Public election-status board for the Apply & Vote panel: how many candidates have
// thrown their hat in for each holder bracket, the seats each bracket elects, and
// whether the candidacy window is open. Same picture voters see — no sign-in needed.
// Mirrors the Apply card's premium patterns (glass, brand-accent glow, count-ups,
// staggered reveal), and every animation set is disabled under reduced-motion.

const root = () => document.getElementById('election-board');
let lastData = null; // cached /api/election payload so a language switch can re-render

// Bracket id → i18n keys for its tier name and asset range.
const TIER_KEY  = { single: 'apply.tier.member', mid: 'apply.tier.patron', whale: 'apply.tier.icon' };
const RANGE_KEY = { single: 'apply.race.range.single', mid: 'apply.race.range.mid', whale: 'apply.race.range.whale' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "1 seat" / "2 seats" — pluralised in the active language (English fallback otherwise).
function seatsLabel(n) {
  return `${n} ${n === 1 ? t('apply.race.seat') : t('apply.race.seats')}`;
}

function raceCard(r, i) {
  const contested = r.candidates > r.seats; // more runners than seats — a real contest
  const countLabel = r.candidates === 1 ? t('apply.race.candidate') : t('apply.race.candidates');
  return `
    <div class="race-card" data-tier="${esc(r.bracket)}" style="--i:${i}">
      <div class="race-card-glow" aria-hidden="true"></div>
      <div class="race-card-top">
        <span class="apply-tier" data-tier="${esc(r.bracket)}">${esc(t(TIER_KEY[r.bracket]))}</span>
        <span class="race-range">${esc(t(RANGE_KEY[r.bracket]))}</span>
      </div>
      <div class="race-count" data-to="${r.candidates}">0</div>
      <div class="race-count-l">${esc(countLabel)}</div>
      <div class="race-seatbar">
        <span class="race-seat-chip">${esc(seatsLabel(r.seats))}</span>
        ${contested ? `<span class="race-contested">${esc(t('apply.race.contested'))}</span>` : ''}
      </div>
    </div>`;
}

// One-line context under the cards. t() has no interpolation, so the seat counts are
// substituted into the translated sentence here (integers — safe to inline).
function footNote(d) {
  const seats = t('apply.race.foot')
    .replace('{elected}', d.electedSeats)
    .replace('{appointed}', d.appointedSeats);
  // Once anyone's in the race, just state the seats — the "pre-window" / "be the
  // first" lines only make sense while the field is empty.
  if (d.totalCandidates > 0) return seats;
  if (!d.applicationsOpen) return `${t('apply.race.foot.closed')} ${seats}`;
  return `${t('apply.race.empty')} ${seats}`;
}

function boardView(d) {
  const open = !!d.applicationsOpen;
  const cards = (d.races || []).map(raceCard).join('');
  return `
    <div class="race-wrap" data-reveal>
      <div class="apply-aurora" aria-hidden="true"></div>
      <div class="race-head">
        <div class="race-head-text">
          <span class="apply-pill">${esc(t('apply.race.eyebrow'))}</span>
          <h3 class="race-h">${esc(t('apply.race.h'))}</h3>
        </div>
        <span class="race-status ${open ? 'is-open' : 'is-closed'}">
          <i class="race-status-dot" aria-hidden="true"></i>${esc(open ? t('apply.race.open') : t('apply.race.closed'))}
        </span>
      </div>
      <div class="race-grid">${cards}</div>
      <p class="race-foot">${esc(footNote(d))}</p>
    </div>`;
}

function errorView() {
  return `
    <div class="race-wrap race-error" data-reveal>
      <p>${esc(t('apply.race.err'))}</p>
      <button class="apply-btn-ghost" type="button" id="race-retry">${esc(t('apply.retry'))}</button>
    </div>`;
}

// Count-up the candidate tallies (respects reduced-motion / zero).
function animateCounts(el) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.querySelectorAll('.race-count[data-to]').forEach(node => {
    const to = Number(node.dataset.to) || 0;
    if (reduce || to <= 0) { node.textContent = String(to); return; }
    const dur = 1000, start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = String(Math.round(to * eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function render() {
  const el = root();
  if (!el || lastData === null) return; // still loading — keep the spinner
  el.setAttribute('aria-busy', 'false');
  el.innerHTML = lastData.error ? errorView() : boardView(lastData);
  el.querySelector('#race-retry')?.addEventListener('click', () => loadElection(true));
  if (!lastData.error) animateCounts(el);
}

export async function loadElection(force = false) {
  const el = root();
  if (!el) return;
  if (force) { el.setAttribute('aria-busy', 'true'); el.innerHTML = '<div class="apply-loading"><div class="apply-spinner"></div></div>'; }
  try {
    const res = await fetch('/api/election', { headers: { Accept: 'application/json' } });
    const data = await res.json();
    lastData = res.ok ? data : { error: true };
  } catch {
    lastData = { error: true };
  }
  render();
}

// Re-render with cached state after a language switch.
export function rerenderElection() {
  if (lastData !== null) render();
}
