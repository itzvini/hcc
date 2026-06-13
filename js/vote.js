import { t } from './i18n.js';

// Voting-advice matcher (a Wahl-O-Mat-style VAA). A signed-in, voting-eligible holder
// sets where they stand on the 9 propositions and sees which candidates align with
// them — ranked by affinity.
//
// PRIVACY MODEL:
//   • The MATCH is computed SERVER-SIDE — the ranked list never includes candidate
//     positions, only a match %.
//   • A candidate's full profile (positions + open answers) is fetched LAZILY, only when
//     the voter opens it — per-candidate, gated to eligible voters, the name withheld
//     until voting opens, and the server logs nothing about which profile was viewed.
//   • The voter's ballot is POSTed to compute the match but is never stored or logged.
//   • Answers are saved in localStorage on this device ("save it"); "Clear" wipes them.
//   • Works while voting is closed — advisory only, casts no vote.

const root = () => document.getElementById('vote-app');
const STORE = 'hcc-vote-advice'; // localStorage key — { positions: { [propId]: stance 1-5 } }

let data = null;          // { propositions, candidateCount, votingOpen } | { error, status } | null (loading)
let lastResults = null;   // last server ranking, cached so a language switch re-renders without re-POSTing
let lastVotingOpen = false;
let profileData = null;   // the candidate profile currently open, or { error: true }
let mode = 'quiz';        // 'quiz' (questionnaire) | 'results' (matches) | 'profile' (one candidate) — one view at a time

const TIER_KEY = { single: 'apply.tier.member', mid: 'apply.tier.patron', whale: 'apply.tier.icon' };
const RACE_ORDER = ['single', 'mid', 'whale']; // group matches by seat, smallest-holder race first
const QUESTION_IDS = ['track', 'theme', 'gen2', 'value', 'roadmap', 'communication', 'represent', 'seat']; // open-question order (mirrors server)

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Highrise icon URLs are versioned and 404 the moment a member restyles their look, so
// an avatar <img> can fail even when the server sent one. `error` doesn't bubble, so
// catch it in the capture phase and fall back to the initial carried in data-initial —
// the server's hourly refresh closes the gap, this covers the window in between.
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  const box = img.closest('.vote-cand-avatar[data-initial]');
  if (!box) return;
  box.textContent = box.dataset.initial || '?';
}, true);

// --- local-only persistence (never throws — private mode degrades to in-memory) ---
function readStore() { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } }
function writeStore(obj) { try { localStorage.setItem(STORE, JSON.stringify(obj)); } catch { /* private mode */ } }
function clearStore() { try { localStorage.removeItem(STORE); } catch { /* ignore */ } }

// Read the currently-checked stances out of the DOM into { id: stance }.
function collect(el) {
  const pos = {};
  (data.propositions || []).forEach(p => {
    const checked = el.querySelector(`input[name="vote-${p.id}"]:checked`);
    if (checked) pos[p.id] = Number(checked.value);
  });
  return pos;
}

function showMsg(el, kind, text) {
  const m = el.querySelector('#vote-msg');
  if (!m) return;
  m.hidden = false;
  m.className = `vote-msg is-${kind}`;
  m.textContent = text;
}

// --- views ---
function scaleRow(p, saved) {
  const cur = saved[p.id];
  const opts = [1, 2, 3, 4, 5].map(v => `
    <label class="vaa-opt" title="${esc(t('app.scale.' + v))}">
      <input type="radio" name="vote-${esc(p.id)}" value="${v}" ${cur === v ? 'checked' : ''} />
      <span class="vaa-dot"></span>
      <span class="vaa-opt-label">${esc(t('app.scale.' + v))}</span>
    </label>`).join('');
  return `
    <div class="vaa-prop" data-prop="${esc(p.id)}">
      <div class="vaa-statement">${esc(t('prop.' + p.id))}</div>
      <div class="vaa-scale">${opts}</div>
    </div>`;
}

// Header. The intro + privacy chip only matter while answering, so they're dropped in
// results mode to keep the matches view compact.
function headerHtml(d) {
  const compact = mode !== 'quiz';
  return `
    <div class="vote-head">
      <span class="apply-pill">${esc(t('vote.eyebrow'))}</span>
      <h3 class="vote-h">${esc(t('vote.h'))}</h3>
      ${compact ? '' : `<p class="vote-intro">${esc(t('vote.intro'))}</p>
      <span class="vote-private"><i aria-hidden="true"></i>${esc(t('vote.private'))}</span>`}
      ${d.votingOpen === false ? `<p class="vote-anon-note">${esc(t('vote.namesHidden'))}</p>` : ''}
    </div>`;
}

function quizBody(d) {
  const saved = readStore().positions || {};
  const rows = (d.propositions || []).map(p => scaleRow(p, saved)).join('');
  return `
    <div class="vote-props">${rows}</div>
    <div class="vote-actions">
      <button class="apply-btn-ghost" type="button" id="vote-clear">${esc(t('vote.clear'))}</button>
      <button class="appf-btn-primary" type="button" id="vote-go">${esc(t('vote.see'))} <span aria-hidden="true">→</span></button>
    </div>
    <div class="vote-msg" id="vote-msg" role="status" hidden></div>`;
}

function resultsBody(results, votingOpen) {
  return `
    <div class="vote-results-actions">
      <button class="apply-btn-ghost vote-back" type="button" id="vote-back"><span aria-hidden="true">←</span> ${esc(t('vote.back'))}</button>
      <button class="apply-btn-ghost" type="button" id="vote-clear">${esc(t('vote.clear'))}</button>
    </div>
    <div class="vote-results" id="vote-results" aria-live="polite">${resultsView(results, votingOpen)}</div>`;
}

// One view at a time — the questionnaire OR the matches — so there's no scrolling past
// the 9 questions to reach results. "See my matches" swaps to results; "Back to
// questions" swaps back (answers restored from localStorage).
function matcherView(d) {
  let body;
  if (mode === 'profile') body = profileView(profileData);
  else if (mode === 'results' && lastResults) body = resultsBody(lastResults, lastVotingOpen);
  else body = quizBody(d);
  return `
    <div class="vote-wrap" data-reveal>
      <div class="apply-aurora" aria-hidden="true"></div>
      ${headerHtml(d)}
      ${body}
    </div>`;
}

// A result row from the server: { bracket, pitch, pct, n, name? }. No candidate positions
// are ever present (affinity is computed server-side), and `name` is present ONLY once
// voting opens — pre-voting the card is anonymised. `rank` is the position within the
// candidate's own seat/race.
function candidateCard(r, rank, votingOpen) {
  const pct = r.pct;
  const top = rank === 0 && pct != null;
  const bracket = r.bracket || 'none';
  const named = votingOpen && r.name;
  const label = named ? r.name : t('vote.anon');
  const based = r.n ? t('vote.basedon').replace('{n}', r.n) : t('vote.nomatch');
  // Highrise profile picture when the server sent one (names public); initial fallback.
  const initial = esc((r.name || '?').trim().charAt(0).toUpperCase() || '?');
  const avatar = named
    ? `<div class="vote-cand-avatar" data-tier="${esc(bracket)}" ${r.avatar ? `data-initial="${initial}"` : ''} aria-hidden="true">${
        r.avatar ? `<img src="${esc(r.avatar)}" alt="" loading="lazy" />` : initial
      }</div>`
    : `<div class="vote-cand-avatar is-anon" data-tier="${esc(bracket)}" aria-hidden="true">👤</div>`;
  const scoreNode = pct == null
    ? `<div class="vote-score-n">—</div>`
    : `<div class="vote-score-n" data-to="${pct}">0</div>`;
  // Clickable when we have an opaque id to open the profile with (keyboard-accessible).
  const clickable = r.id ? `data-cid="${esc(r.id)}" role="button" tabindex="0"` : '';
  return `
    <div class="vote-card ${top ? 'is-top' : ''} ${named ? '' : 'is-anon'} ${r.id ? 'is-clickable' : ''}" data-tier="${esc(bracket)}" ${clickable}>
      <div class="vote-card-glow" aria-hidden="true"></div>
      <div class="vote-card-main">
        <div class="vote-rank">#${rank + 1}</div>
        ${avatar}
        <div class="vote-cand-id">
          <div class="vote-cand-name">${esc(label)}${top ? `<span class="vote-top-badge">${esc(t('vote.results.top'))}</span>` : ''}</div>
          ${r.pitch ? `<div class="vote-cand-pitch">${esc(r.pitch)}</div>` : ''}
        </div>
        <div class="vote-score">
          ${scoreNode}
          <div class="vote-score-l">${esc(t('vote.match'))}</div>
        </div>
      </div>
      <div class="vote-card-foot">
        <span class="vote-based">${esc(based)}</span>
        ${r.id ? `<span class="vote-view">${esc(t('vote.viewprofile'))} <span aria-hidden="true">→</span></span>` : ''}
      </div>
    </div>`;
}

// Group the ranked results by seat/race, but show them behind a tab strip (one tab per
// seat class) so the voter picks a race instead of scrolling the whole field. Voters
// elect per race, so reviewing candidates seat by seat matches how they'll vote.
function resultsView(results, votingOpen) {
  if (!results || !results.length) return `<p class="vote-empty">${esc(t('vote.empty'))}</p>`;
  const races = RACE_ORDER
    .map(bracket => ({ bracket, items: results.filter(r => (r.bracket || 'none') === bracket) }))
    .filter(g => g.items.length);
  if (!races.length) return `<p class="vote-empty">${esc(t('vote.empty'))}</p>`;

  const tabs = races.map((g, i) => {
    const countLabel = g.items.length === 1 ? t('vote.race.candidate') : t('vote.race.candidates');
    const aria = `${t(TIER_KEY[g.bracket])} · ${g.items.length} ${countLabel}`;
    return `
      <button class="vote-seat-tab ${i === 0 ? 'is-active' : ''}" type="button" role="tab"
        data-seat="${esc(g.bracket)}" data-tier="${esc(g.bracket)}"
        aria-selected="${i === 0 ? 'true' : 'false'}" aria-label="${esc(aria)}" title="${esc(aria)}">
        ${esc(t(TIER_KEY[g.bracket]))}<span class="vote-seat-count">${g.items.length}</span>
      </button>`;
  }).join('');

  const panels = races.map((g, i) => {
    const cards = g.items.map((r, idx) => candidateCard(r, idx, votingOpen)).join('');
    return `
      <div class="vote-seat-panel" data-seat="${esc(g.bracket)}" role="tabpanel" ${i === 0 ? '' : 'hidden'}>
        <div class="vote-cards">${cards}</div>
      </div>`;
  }).join('');

  return `
    <div class="appf-divider"><span>${esc(t('vote.results.h'))}</span></div>
    <div class="vote-seat-tabs" role="tablist">${tabs}</div>
    <div class="vote-seat-panels">${panels}</div>`;
}

// Wire the seat tabs: clicking one shows that race's panel and hides the others.
function bindSeatTabs(scope) {
  const tabs = [...scope.querySelectorAll('.vote-seat-tab')];
  const panels = [...scope.querySelectorAll('.vote-seat-panel')];
  tabs.forEach(tab => tab.addEventListener('click', () => {
    tabs.forEach(t2 => {
      const on = t2 === tab;
      t2.classList.toggle('is-active', on);
      t2.setAttribute('aria-selected', String(on));
    });
    panels.forEach(p => { p.hidden = p.dataset.seat !== tab.dataset.seat; });
  }));
}

// One proposition in the profile: the statement, the voter's stance vs the candidate's,
// and the candidate's rationale. Colour-coded by how closely the two agree.
function positionCompareRow(p, voterStance, candPositions) {
  const c = candPositions[p.id];
  const theirStance = c?.stance;
  const yourLabel = voterStance ? t('app.scale.' + voterStance) : '—';
  const theirLabel = theirStance ? t('app.scale.' + theirStance) : '—';
  let cls = '';
  if (voterStance && theirStance) {
    const d = Math.abs(voterStance - theirStance);
    cls = d === 0 ? 'is-agree' : d <= 1 ? 'is-near' : 'is-differ';
  }
  return `
    <div class="vote-bd ${cls}">
      <div class="vote-bd-stmt">${esc(t('prop.' + p.id))}</div>
      <div class="vote-bd-row">
        <span class="vote-bd-you">${esc(t('vote.you'))}: ${esc(yourLabel)}</span>
        <span class="vote-bd-them">${esc(t('vote.them'))}: ${esc(theirLabel)}</span>
      </div>
      ${c?.rationale ? `<div class="vote-bd-why">${esc(c.rationale)}</div>` : ''}
    </div>`;
}

// Full candidate profile (the click-through detail). Shows the pitch, a position-by-
// position comparison against the voter's own answers, and the open-question answers.
// `profile.name` is present only once voting opens — otherwise the candidate stays
// anonymous here too.
function profileView(profile) {
  const backRow = `
    <div class="vote-profile-actions">
      <button class="apply-btn-ghost" type="button" id="vote-pback"><span aria-hidden="true">←</span> ${esc(t('vote.profile.back'))}</button>
    </div>`;
  if (!profile || profile.error) {
    return `${backRow}<p class="vote-empty">${esc(t('vote.profile.err'))}</p>`;
  }

  const named = !!profile.name;
  const label = named ? profile.name : t('vote.anon');
  const bracket = profile.bracket || 'none';
  const tier = profile.bracket ? t(TIER_KEY[profile.bracket]) : '';
  const initial = esc(named ? ((profile.name || '?').trim().charAt(0).toUpperCase() || '?') : '👤');
  const hasAvatar = named && profile.avatar;
  const face = hasAvatar
    ? `<img src="${esc(profile.avatar)}" alt="" loading="lazy" />`
    : initial;
  const matchRow = (lastResults || []).find(r => r.id === profile.id);
  const matchChip = matchRow && matchRow.pct != null
    ? `<span class="vote-profile-match">${esc(t('vote.yourmatch'))} <strong>${matchRow.pct}%</strong></span>` : '';

  const voterPos = readStore().positions || {};
  const posRows = (data.propositions || [])
    .map(p => positionCompareRow(p, voterPos[p.id], profile.positions || {})).join('');

  const answers = profile.answers || {};
  const answerRows = QUESTION_IDS
    .filter(id => (answers[id] || '').trim())
    .map(id => `
      <div class="vote-ans">
        <div class="vote-ans-q">${esc(t('app.q.' + id + '.q'))}</div>
        <div class="vote-ans-a">${esc(answers[id])}</div>
      </div>`).join('');

  return `
    ${backRow}
    <div class="vote-profile" data-tier="${esc(bracket)}">
      <div class="vote-profile-head">
        <div class="vote-cand-avatar ${named ? '' : 'is-anon'}" data-tier="${esc(bracket)}" ${hasAvatar ? `data-initial="${initial}"` : ''} aria-hidden="true">${face}</div>
        <div class="vote-profile-id">
          <div class="vote-cand-name">${esc(label)} ${tier ? `<span class="apply-tier" data-tier="${esc(bracket)}">${esc(tier)}</span>` : ''}</div>
          ${matchChip}
        </div>
      </div>
      ${profile.pitch ? `<p class="vote-profile-pitch">${esc(profile.pitch)}</p>` : ''}
      <div class="appf-divider"><span>${esc(t('vote.profile.positions'))}</span></div>
      <div class="vote-breakdown">${posRows}</div>
      ${answerRows
        ? `<div class="appf-divider"><span>${esc(t('vote.profile.answers'))}</span></div><div class="vote-answers">${answerRows}</div>`
        : (data.votingOpen === false ? `<p class="vote-anon-note vote-locked-note">${esc(t('vote.profile.locked'))}</p>` : '')}
    </div>`;
}

function gate(kind) {
  const h = kind === 'signin' ? t('vote.gate.signin.h') : t('vote.gate.noteligible.h');
  const p = kind === 'signin' ? t('vote.gate.signin.p') : t('vote.gate.noteligible.p');
  return `
    <div class="vote-wrap vote-gate" data-reveal>
      <div class="apply-aurora" aria-hidden="true"></div>
      <div class="vote-gate-ico" aria-hidden="true">🗳️</div>
      <span class="apply-pill">${esc(t('vote.eyebrow'))}</span>
      <h3 class="vote-h">${esc(h)}</h3>
      <p class="vote-intro">${esc(p)}</p>
    </div>`;
}

function errorView() {
  return `
    <div class="vote-wrap vote-error" data-reveal>
      <p>${esc(t('vote.err'))}</p>
      <button class="apply-btn-ghost" type="button" id="vote-retry">${esc(t('apply.retry'))}</button>
    </div>`;
}

// Count-up the match percentages (respects reduced-motion).
function animateCounts(scope) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  scope.querySelectorAll('.vote-score-n[data-to]').forEach(node => {
    const to = Number(node.dataset.to) || 0;
    if (reduce || to <= 0) { node.textContent = String(to); return; }
    const dur = 900, start = performance.now();
    const step = (now) => {
      const prog = Math.min(1, (now - start) / dur);
      node.textContent = String(Math.round(to * (1 - Math.pow(1 - prog, 3))));
      if (prog < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function postMatch(positions) {
  const res = await fetch('/api/vote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ positions }),
  });
  const out = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, out };
}

async function runMatch(el) {
  const voterPos = collect(el);
  if (!Object.keys(voterPos).length) { showMsg(el, 'info', t('vote.answerfirst')); return; }
  writeStore({ positions: voterPos });
  const go = el.querySelector('#vote-go');
  if (go) go.disabled = true;
  showMsg(el, 'info', t('vote.matching'));
  const { ok, status, out } = await postMatch(voterPos);
  if (!ok) {
    if (go) go.disabled = false;
    showMsg(el, 'error', status === 429 ? t('vote.toomany') : (out.error || t('vote.err')));
    return;
  }
  lastResults = out.results || [];
  lastVotingOpen = !!out.votingOpen;
  mode = 'results';
  render();                                                  // swap the questionnaire out for the matches
  root()?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Fetch one candidate's profile on click and show it. Reads nothing about the voter's
// ballot; the server records nothing about which profile was opened.
async function openProfile(cid) {
  let prof = null;
  try {
    const res = await fetch(`/api/vote?candidate=${encodeURIComponent(cid)}`, { headers: { Accept: 'application/json' } });
    if (res.ok) prof = (await res.json()).candidate || null;
  } catch { /* network — fall through to error view */ }
  profileData = prof || { error: true };
  mode = 'profile';
  render();
  root()?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bindMatcher(el) {
  // Questionnaire controls
  el.querySelectorAll('.vote-props input[type="radio"]').forEach(inp => {
    inp.addEventListener('change', () => writeStore({ positions: collect(el) })); // auto-save ("save it")
  });
  el.querySelector('#vote-go')?.addEventListener('click', () => runMatch(el));

  // Results controls
  el.querySelector('#vote-back')?.addEventListener('click', () => {
    mode = 'quiz';
    render();
    root()?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  bindSeatTabs(el);
  if (mode === 'results') animateCounts(el);

  // Open a candidate profile on card click/keyboard. Delegated on the panels container,
  // which is rebuilt each render, so listeners never accumulate on the persistent root.
  const panels = el.querySelector('.vote-seat-panels');
  if (panels) {
    panels.addEventListener('click', e => {
      const card = e.target.closest('.vote-card[data-cid]');
      if (card) openProfile(card.dataset.cid);
    });
    panels.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.vote-card[data-cid]');
      if (card) { e.preventDefault(); openProfile(card.dataset.cid); }
    });
  }

  // Profile back → matches
  el.querySelector('#vote-pback')?.addEventListener('click', () => {
    mode = lastResults ? 'results' : 'quiz';
    render();
    root()?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Clear — present in both views: wipe local answers and return to the questionnaire.
  el.querySelector('#vote-clear')?.addEventListener('click', () => {
    clearStore();
    lastResults = null;
    mode = 'quiz';
    render();
    showMsg(root(), 'ok', t('vote.cleared'));
  });
}

function render() {
  const el = root();
  if (!el || data === null) return; // still loading — keep spinner
  el.setAttribute('aria-busy', 'false');

  if (data.error) {
    if (data.status === 401)      el.innerHTML = gate('signin');
    else if (data.status === 403) el.innerHTML = gate('noteligible');
    else { el.innerHTML = errorView(); el.querySelector('#vote-retry')?.addEventListener('click', () => loadVote()); }
    return;
  }

  // Fall back gracefully if a view's data was cleared/lost.
  if (mode === 'results' && !lastResults) mode = 'quiz';
  if (mode === 'profile' && !profileData) mode = lastResults ? 'results' : 'quiz';

  el.innerHTML = matcherView(data);
  bindMatcher(el);
}

export async function loadVote() {
  const el = root();
  if (!el) return;
  el.setAttribute('aria-busy', 'true');
  el.innerHTML = '<div class="apply-loading"><div class="apply-spinner"></div></div>';
  try {
    const res = await fetch('/api/vote', { headers: { Accept: 'application/json' } });
    data = res.ok ? await res.json() : { error: true, status: res.status };
  } catch {
    data = { error: true, status: 0 };
  }
  render();
}

// Re-render with cached setup + ranking after a language switch (keeps saved answers).
export function rerenderVote() {
  if (data !== null) render();
}
