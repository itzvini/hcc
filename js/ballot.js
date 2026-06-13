import { t } from './i18n.js';

// The OFFICIAL ballot — distinct from the advisory matcher in vote.js, which casts
// nothing. One vote per seat race; votes are FINAL once cast and the voter gets a
// private receipt (the published rules on the Council page).
//
// Unopposed races (candidates ≤ seats) use a CONFIRMATION ballot: "Seat the
// candidate(s)" vs "Reopen nominations". If reopening wins but nobody new runs
// during the reopened window, the candidates are seated by rule — a seat can be
// contested, never voted into a vacancy.
//
// The section stays invisible until voting opens (the election board carries the
// phase messaging); after voting closes it shrinks to a receipts card.

const root = () => document.getElementById('ballot-app');

let data = null;     // /api/ballot payload | { error, status } | null while loading
let sel = {};        // bracket -> selected value ('seat' | 'reopen' | opaque candidate id)
let armed = null;    // bracket whose cast button awaits the final confirming tap
let armTimer = 0;    // pending auto-disarm — an armed button relaxes after 5s untouched
let busy = null;     // bracket with a POST in flight
let raceMsg = {};    // bracket -> { kind, text } inline feedback
let justCast = {};   // bracket -> receipt from a cast made this visit (gets the reveal)

const TIER_KEY = { single: 'apply.tier.member', mid: 'apply.tier.patron', whale: 'apply.tier.icon' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Avatar markup with a graceful fallback. Highrise icon URLs are versioned and start
// 404ing the moment a member restyles their look, so a stored URL can be live one day
// and dead the next. `data-initial` carries the letter the error handler below falls
// back to, so a broken image becomes the candidate's initial — never an empty square.
function avatarFace(name, avatar) {
  const initial = esc((name || '?').trim().charAt(0).toUpperCase() || '?');
  return avatar
    ? `<span class="ballot-opt-avatar" data-initial="${initial}" aria-hidden="true"><img src="${esc(avatar)}" alt="" loading="lazy" /></span>`
    : `<span class="ballot-opt-avatar is-initial" aria-hidden="true">${initial}</span>`;
}

// `error` doesn't bubble, so catch it in the capture phase. The server refreshes
// candidate avatars hourly; this covers the window between a restyle and that refresh.
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  const span = img.closest('.ballot-opt-avatar[data-initial]');
  if (!span) return;
  span.classList.add('is-initial');
  span.textContent = span.dataset.initial || '?';
}, true);

function seatsLabel(n) {
  return `${n} ${n === 1 ? t('apply.race.seat') : t('apply.race.seats')}`;
}

function joinNames(cands) {
  return cands.map(c => c.name || t('vote.anon')).join(' + ');
}

// --- option rows ---

function candidateOption(r, c) {
  const checked = sel[r.bracket] === c.id;
  // Highrise profile picture when available; initial fallback keeps the row shape.
  const face = avatarFace(c.name, c.avatar);
  return `
    <label class="ballot-opt ${checked ? 'is-checked' : ''}">
      <input type="radio" name="ballot-${esc(r.bracket)}" value="${esc(c.id)}" ${checked ? 'checked' : ''} />
      <span class="ballot-opt-dot" aria-hidden="true"></span>
      ${face}
      <span class="ballot-opt-body">
        <span class="ballot-opt-name">${esc(c.name || t('vote.anon'))}</span>
        ${c.pitch ? `<span class="ballot-opt-pitch">${esc(c.pitch)}</span>` : ''}
      </span>
    </label>`;
}

// Confirmation race: seat-the-slate vs reopen-nominations, with the rule spelled out
// so a "reopen" vote is an informed one (it can force a contest, never a vacancy).
function confirmationOptions(r) {
  const names = joinNames(r.candidates);
  const seatChecked = sel[r.bracket] === 'seat';
  const reopenChecked = sel[r.bracket] === 'reopen';
  const explain = (r.candidates.length > 1 ? t('ballot.unopposed.many') : t('ballot.unopposed'))
    .replace('{name}', names).replace('{names}', names);
  // Single unopposed candidate → show their face on the seat option (recognition).
  const c = r.candidates.length === 1 ? r.candidates[0] : null;
  const face = c ? avatarFace(c.name, c.avatar) : '';
  return `
    <p class="ballot-explain">${esc(explain)}</p>
    <label class="ballot-opt ballot-opt-seat ${seatChecked ? 'is-checked' : ''}">
      <input type="radio" name="ballot-${esc(r.bracket)}" value="seat" ${seatChecked ? 'checked' : ''} />
      <span class="ballot-opt-dot" aria-hidden="true"></span>
      ${face}
      <span class="ballot-opt-body">
        <span class="ballot-opt-name">${esc(t('ballot.opt.seat').replace('{name}', names))}</span>
        <span class="ballot-opt-pitch">${esc(t('ballot.opt.seat.p'))}</span>
      </span>
    </label>
    <label class="ballot-opt ballot-opt-reopen ${reopenChecked ? 'is-checked' : ''}">
      <input type="radio" name="ballot-${esc(r.bracket)}" value="reopen" ${reopenChecked ? 'checked' : ''} />
      <span class="ballot-opt-dot" aria-hidden="true"></span>
      <span class="ballot-opt-body">
        <span class="ballot-opt-name">${esc(t('ballot.opt.reopen'))}</span>
        <span class="ballot-opt-pitch">${esc(t('ballot.opt.reopen.p'))}</span>
      </span>
    </label>`;
}

// --- race states ---

// The voter's locked-in picks for a race (each final, each with its own receipt).
function castPicksBlock(r, fresh) {
  const label = p => p.choice === 'seat' ? t('ballot.choice.seat')
    : p.choice === 'reopen' ? t('ballot.choice.reopen')
    : (r.candidates.find(c => c.id === p.choice)?.name || t('vote.anon'));
  const rows = r.picks.map(p => `
    <div class="ballot-voted-pick">
      <span class="ballot-voted-chip"><i aria-hidden="true">✓</i>${esc(t('ballot.youchose'))} <strong>${esc(label(p))}</strong></span>
      <span class="ballot-receipt-pair"><span class="ballot-receipt-l">${esc(t('ballot.receipt'))}</span><code class="ballot-receipt">${esc(p.receipt)}</code></span>
    </div>`).join('');
  return `<div class="ballot-voted ${fresh ? 'is-fresh' : ''}">${rows}</div>`;
}

function castControls(r) {
  const isArmed = armed === r.bracket;
  const isBusy = busy === r.bracket;
  const hasSel = !!sel[r.bracket];
  const label = isBusy ? t('ballot.casting') : isArmed ? t('ballot.confirm') : t('ballot.cast');
  const msg = raceMsg[r.bracket];
  return `
    <div class="ballot-cast-row">
      <button class="appf-btn-primary ballot-cast ${isArmed ? 'is-armed' : ''}" type="button"
        data-cast="${esc(r.bracket)}" ${hasSel && !isBusy ? '' : 'disabled'}>${esc(label)}</button>
      <span class="ballot-final-chip"><i aria-hidden="true"></i>${esc(t('ballot.final'))}</span>
    </div>
    ${msg ? `<div class="ballot-msg is-${esc(msg.kind)}" role="alert">${esc(msg.text)}</div>` : ''}`;
}

function raceCard(r, i) {
  const picks = r.picks || [];
  const remaining = r.picksRemaining || 0;
  const multi = r.seats > 1;          // a race that elects more than one seat → more than one vote
  const fresh = !!justCast[r.bracket];

  let body;
  if (!picks.length && r.concluded) {
    body = `<p class="ballot-note">${esc(t('ballot.concluded'))}</p>`;
  } else if (!picks.length && !r.mode) {
    body = `<p class="ballot-note">${esc(t('ballot.noCands'))}</p>`;
  } else {
    const parts = [];
    // Already-cast picks, locked in with their receipts.
    if (picks.length) parts.push(castPicksBlock(r, fresh));

    if (remaining > 0 && !r.concluded) {
      // Prompt: in a multi-seat race, say how many votes remain.
      if (multi) {
        const key = picks.length ? 'ballot.addmore' : 'ballot.multi.intro';
        parts.push(`<p class="ballot-explain">${esc(t(key).replace('{seats}', r.seats).replace('{n}', remaining))}</p>`);
      } else if (r.mode !== 'confirmation') {
        parts.push(`<p class="ballot-explain">${esc(t('ballot.pick'))}</p>`);
      }
      // Options for the next pick — candidates already chosen are dropped from the list.
      const picked = new Set(picks.map(p => p.choice));
      const opts = r.mode === 'confirmation'
        ? confirmationOptions(r)
        : r.candidates.filter(c => !picked.has(c.id)).map(c => candidateOption(r, c)).join('');
      parts.push(`<div class="ballot-opts" role="radiogroup" aria-label="${esc(t(TIER_KEY[r.bracket]))}">${opts}</div>`);
      parts.push(castControls(r));
    } else {
      // All picks used — this race is done for the voter.
      parts.push(`<p class="ballot-allin"><i aria-hidden="true">✓</i> ${esc(multi ? t('ballot.allcast') : t('ballot.voted'))}</p>`);
      parts.push(`<p class="ballot-receipt-keep">${esc(t('ballot.receipt.keep'))}</p>`);
    }
    body = parts.join('');
  }

  return `
    <div class="ballot-race" data-tier="${esc(r.bracket)}" style="--i:${i}">
      <div class="ballot-race-top">
        <span class="apply-tier" data-tier="${esc(r.bracket)}">${esc(t(TIER_KEY[r.bracket]))}</span>
        <span class="race-seat-chip">${esc(seatsLabel(r.seats))}</span>
        ${r.mode === 'confirmation' && !picks.length && !r.concluded ? `<span class="ballot-conf-chip">${esc(t('ballot.confchip'))}</span>` : ''}
      </div>
      ${body}
    </div>`;
}

// After voting closes: a compact receipts card (only if this voter cast anything).
// One row per pick — a Member voter who used both votes sees both receipts.
function receiptsView(d) {
  const rows = d.races.flatMap(r => (r.picks || []).map(p => `
    <div class="ballot-receipt-row">
      <span class="apply-tier" data-tier="${esc(r.bracket)}">${esc(t(TIER_KEY[r.bracket]))}</span>
      <code class="ballot-receipt">${esc(p.receipt)}</code>
    </div>`)).join('');
  if (!rows) return '';
  return `
    <div class="ballot-wrap is-closed" data-reveal>
      <div class="apply-aurora" aria-hidden="true"></div>
      <span class="apply-pill">${esc(t('ballot.eyebrow'))}</span>
      <h3 class="ballot-h">${esc(t('ballot.voted'))}</h3>
      <p class="ballot-intro">${esc(t('ballot.thanks'))}</p>
      <div class="ballot-receipts">${rows}</div>
      <p class="ballot-receipt-keep">${esc(t('ballot.verifynote'))}</p>
    </div>`;
}

function ballotView(d) {
  const cards = d.races.map(raceCard).join('');
  return `
    <div class="ballot-wrap" data-reveal>
      <div class="apply-aurora" aria-hidden="true"></div>
      <div class="ballot-head">
        <span class="apply-pill">${esc(t('ballot.eyebrow'))}</span>
        <h3 class="ballot-h">${esc(t('ballot.h'))}</h3>
        <p class="ballot-intro">${esc(t('ballot.intro'))}</p>
        <span class="vote-private"><i aria-hidden="true"></i>${esc(t('ballot.private'))}</span>
      </div>
      <div class="ballot-races">${cards}</div>
    </div>`;
}

function errorView() {
  return `
    <div class="ballot-wrap ballot-error" data-reveal>
      <p>${esc(t('ballot.loaderr'))}</p>
      <button class="apply-btn-ghost" type="button" id="ballot-retry">${esc(t('apply.retry'))}</button>
    </div>`;
}

// Voter holds now but isn't in the frozen electorate — assets were bought after the
// official snapshot. A clear gate beats a confusing 403 at cast time.
function snapshotGate(snap) {
  const date = snap.capturedAt ? new Date(snap.capturedAt).toLocaleDateString() : '—';
  return `
    <div class="ballot-wrap ballot-gate" data-reveal>
      <div class="apply-aurora" aria-hidden="true"></div>
      <div class="ballot-gate-ico" aria-hidden="true">🗳️</div>
      <span class="apply-pill">${esc(t('ballot.eyebrow'))}</span>
      <h3 class="ballot-h">${esc(t('ballot.gate.snapshot.h'))}</h3>
      <p class="ballot-intro">${esc(t('ballot.gate.snapshot.p').replace('{date}', date))}</p>
    </div>`;
}

async function castVote(bracket) {
  clearTimeout(armTimer);
  busy = bracket;
  raceMsg = { ...raceMsg, [bracket]: null };
  render();
  let res, out = {};
  try {
    res = await fetch('/api/ballot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ bracket, choice: sel[bracket] }),
    });
    out = await res.json().catch(() => ({}));
  } catch { /* network — handled below as a generic error */ }
  busy = null;
  armed = null;
  if (res && res.ok) {
    justCast[bracket] = out.receipt;
    delete sel[bracket];
    await loadBallot(false); // re-fetch so the voted state comes from the server
    return;
  }
  if (res && res.status === 409) {
    // Server distinguishes duplicate-candidate vs all-votes-used — use its message.
    raceMsg[bracket] = { kind: 'error', text: out.error || t('ballot.already') };
    await loadBallot(false); // re-sync (e.g. a second tab cast in the meantime)
    return;
  }
  raceMsg[bracket] = { kind: 'error', text: out.error || t('ballot.err') };
  render();
}

function bind(el) {
  el.querySelectorAll('.ballot-opts input[type="radio"]').forEach(inp => {
    inp.addEventListener('change', () => {
      const bracket = inp.name.replace(/^ballot-/, '');
      sel[bracket] = inp.value;
      if (armed === bracket) { armed = null; clearTimeout(armTimer); } // changing the pick disarms the final tap
      raceMsg[bracket] = null;
      render();
    });
  });
  // Final votes get a two-tap cast: first tap arms the button, second confirms.
  // An armed button auto-disarms after 5s so it can't linger primed while the
  // voter is away — confirming has to be one deliberate, continuous gesture.
  el.querySelectorAll('[data-cast]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bracket = btn.dataset.cast;
      if (!sel[bracket] || busy) return;
      clearTimeout(armTimer);
      if (armed !== bracket) {
        armed = bracket;
        armTimer = setTimeout(() => { if (armed === bracket) { armed = null; render(); } }, 5000);
        render();
        return;
      }
      castVote(bracket);
    });
  });
  el.querySelector('#ballot-retry')?.addEventListener('click', () => loadBallot(true));
}

function render() {
  const el = root();
  if (!el || data === null) return;
  el.setAttribute('aria-busy', 'false');

  // Signed out / not eligible → stay invisible; the matcher's gate carries the message.
  if (data.error) {
    el.innerHTML = (data.status === 401 || data.status === 403) ? '' : errorView();
    el.querySelector('#ballot-retry')?.addEventListener('click', () => loadBallot(true));
    return;
  }
  if (data.votingOpen) {
    const snap = data.snapshot || {};
    if (snap.active && !snap.ready) {
      // Snapshot flag set but capture hasn't landed — voting is fail-closed; show retry.
      el.innerHTML = errorView();
      el.querySelector('#ballot-retry')?.addEventListener('click', () => loadBallot(true));
      return;
    }
    if (snap.active && !snap.in) {
      el.innerHTML = snapshotGate(snap);
      return;
    }
    el.innerHTML = ballotView(data);
    bind(el);
    return;
  }
  // Voting closed: receipts if they voted (results live on the public board), else nothing.
  el.innerHTML = data.resultsOpen ? receiptsView(data) : '';
}

export async function loadBallot(showSpinner = true) {
  const el = root();
  if (!el) return;
  if (showSpinner) {
    el.setAttribute('aria-busy', 'true');
    el.innerHTML = '<div class="apply-loading"><div class="apply-spinner"></div></div>';
  }
  try {
    const res = await fetch('/api/ballot', { headers: { Accept: 'application/json' } });
    data = res.ok ? await res.json() : { error: true, status: res.status };
  } catch {
    data = { error: true, status: 0 };
  }
  render();
}

// Re-render with cached state after a language switch.
export function rerenderBallot() {
  if (data !== null) render();
}
