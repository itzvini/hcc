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

// Published receipt codes for a decided race — voters verify their ballot was counted
// by finding their own code; the list length always equals the published turnout.
function receiptsBlock(res) {
  const codes = res.receipts || [];
  if (!codes.length) return '';
  return `
    <details class="race-receipts">
      <summary>${esc(t('apply.result.receipts').replace('{n}', codes.length))}</summary>
      <p class="race-receipts-p">${esc(t('apply.result.receipts.p'))}</p>
      <div class="race-receipt-grid">${codes.map(c => `<code>${esc(c)}</code>`).join('')}</div>
    </details>`;
}

// Final-result block for one race (only rendered once the server publishes results).
function resultBlock(res) {
  if (!res) return '';
  const turnout = `<span class="race-turnout">${esc(t('apply.result.turnout').replace('{n}', res.turnout))}</span>`;
  if (res.status === 'vacant') {
    return `<div class="race-result"><p class="race-result-note">${esc(t('apply.result.vacant'))}</p></div>`;
  }
  if (res.status === 'revote') {
    return `<div class="race-result"><p class="race-result-note">${esc(t('apply.result.revote'))}</p></div>`;
  }
  if (res.mode === 'contested') {
    const rows = (res.rows || []).map(row => `
      <div class="race-tally-row ${row.seated ? 'is-seated' : ''}">
        <span class="race-tally-name">${row.seated ? '<i aria-hidden="true">✓</i>' : ''}${esc(row.name)}</span>
        <span class="race-tally-votes">${row.votes}</span>
      </div>`).join('');
    return `<div class="race-result"><div class="race-tally">${rows}</div>${turnout}${receiptsBlock(res)}</div>`;
  }
  // Confirmation race: the two option counts plus the resolved outcome.
  const counts = `
    <div class="race-tally">
      <div class="race-tally-row ${res.status.startsWith('seated') ? 'is-seated' : ''}">
        <span class="race-tally-name">${res.status.startsWith('seated') ? '<i aria-hidden="true">✓</i>' : ''}${esc(t('ballot.choice.seat'))}</span>
        <span class="race-tally-votes">${res.seatVotes}</span>
      </div>
      <div class="race-tally-row ${res.status === 'reopened' || res.status === 'reopenPending' ? 'is-seated' : ''}">
        <span class="race-tally-name">${esc(t('ballot.choice.reopen'))}</span>
        <span class="race-tally-votes">${res.reopenVotes}</span>
      </div>
    </div>`;
  let note = '';
  if (res.status === 'seated')        note = `${t('apply.result.seated')}: ${res.seated.join(', ')}`;
  if (res.status === 'seatedByRule')  note = `${t('apply.result.seated')}: ${res.seated.join(', ')} — ${t('apply.result.seatedByRule')}`;
  if (res.status === 'reopened')      note = t('apply.result.reopened');
  if (res.status === 'reopenPending') note = t('apply.result.reopenPending');
  return `<div class="race-result">${counts}<p class="race-result-note">${esc(note)}</p>${turnout}${receiptsBlock(res)}</div>`;
}

function raceCard(r, i, results) {
  // Server-declared mode: 'contested' (more runners than seats), 'confirmation'
  // (unopposed — seat-or-reopen ballot), or null while the field is empty.
  const chip = r.mode === 'contested'
    ? `<span class="race-contested">${esc(t('apply.race.contested'))}</span>`
    : r.mode === 'confirmation'
      ? `<span class="race-confirmation">${esc(t('apply.race.confirmation'))}</span>`
      : '';
  const reopened = r.reopened && r.reopenDeadline
    ? `<p class="race-reopened">${esc(t('apply.race.reopenuntil').replace('{date}', new Date(r.reopenDeadline).toLocaleDateString()))}</p>`
    : '';
  const countLabel = r.candidates === 1 ? t('apply.race.candidate') : t('apply.race.candidates');
  const res = (results || []).find(x => x.bracket === r.bracket);
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
        ${chip}
      </div>
      ${reopened}
      ${resultBlock(res)}
    </div>`;
}

// One-line context under the cards. t() has no interpolation, so the seat counts are
// substituted into the translated sentence here (integers — safe to inline).
function footNote(d) {
  const seats = t('apply.race.foot')
    .replace('{elected}', d.electedSeats)
    .replace('{appointed}', d.appointedSeats);
  // Electorate transparency: who may vote was frozen in the official snapshot.
  const snap = d.voterSnapshot?.wallets
    ? ` ${t('apply.race.snapshot')
        .replace('{n}', d.voterSnapshot.wallets)
        .replace('{date}', new Date(d.voterSnapshot.capturedAt).toLocaleDateString())}`
    : '';
  // Once anyone's in the race, just state the seats — the "pre-window" / "be the
  // first" lines only make sense while the field is empty.
  if (d.totalCandidates > 0) return seats + snap;
  if (!d.applicationsOpen) return `${t('apply.race.foot.closed')} ${seats}`;
  return `${t('apply.race.empty')} ${seats}`;
}

// The phase pill reflects the furthest-along phase: results > voting > candidacy.
function phasePill(d) {
  if (d.resultsOpen) return { cls: 'is-open', label: t('apply.race.results') };
  if (d.votingOpen)  return { cls: 'is-open', label: t('apply.race.voting') };
  if (d.applicationsOpen) return { cls: 'is-open', label: t('apply.race.open') };
  return { cls: 'is-closed', label: t('apply.race.closed') };
}

function boardView(d) {
  const pill = phasePill(d);
  const cards = (d.races || []).map((r, i) => raceCard(r, i, d.results)).join('');
  return `
    <div class="race-wrap" data-reveal>
      <div class="apply-aurora" aria-hidden="true"></div>
      <div class="race-head">
        <div class="race-head-text">
          <span class="apply-pill">${esc(t('apply.race.eyebrow'))}</span>
          <h3 class="race-h">${esc(t('apply.race.h'))}</h3>
        </div>
        <span class="race-status ${pill.cls}">
          <i class="race-status-dot" aria-hidden="true"></i>${esc(pill.label)}
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
