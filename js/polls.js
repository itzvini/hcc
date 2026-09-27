import { t, getCurrentLang } from './i18n.js';
import { DISCORD_SVG } from './apply.js';

// Polls & Votes — official club-wide votes the Player Council sends to every
// holder (e.g. the Gen 2 ship order). Same trust chain as the election ballot:
// Discord sign-in → Highrise-linked wallet → live holder check, one holder one
// vote, final once cast, private receipt, tallies published only after close.
//
// All copy goes through t(); poll content renders from i18n keys the server
// sends (`polls.p.<key>.*`) — the API never ships display text. Every dynamic
// string is escaped before it's injected as HTML.

const root = () => document.getElementById('polls-app');

let data = null;     // /api/polls payload | { error } | null while loading
let sel = {};        // pollId -> selected option id
let armed = null;    // pollId whose cast button awaits the confirming tap
let armTimer = 0;    // pending auto-disarm (armed relaxes after 5s untouched)
let busy = null;     // pollId with a POST in flight
let pollMsg = {};    // pollId -> { kind, text } inline feedback
let justCast = {};   // pollId -> receipt cast this visit (gets the reveal)
let revealed = false; // entrance animation plays once; re-renders (pick/arm) stay put

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Poll copy lives in the locales under polls.p.<key>.*
const pt = (p, part) => t(`polls.p.${p.key}.${part}`);
// Optional copy: '' when the key isn't defined for this poll (t() echoes the key).
const ptOpt = (p, part) => { const k = `polls.p.${p.key}.${part}`; const v = t(k); return v === k ? '' : v; };

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(getCurrentLang(), { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return new Date(iso).toLocaleDateString(); }
}

// An open poll shows the closing hour as well as the day: some run for hours, not
// weeks, and the viewer's own time zone decides which day it closes on.
function fmtDateTime(iso) {
  if (!iso) return '';
  const opts = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  try { return new Date(iso).toLocaleString(getCurrentLang(), opts); }
  catch { return new Date(iso).toLocaleString(); }
}

// Map the ?auth=... flag set by the OAuth callback to a friendly message (the
// callback returns to /polls when the sign-in started here).
function authError() {
  const code = new URLSearchParams(location.search).get('auth');
  if (!code || !location.pathname.startsWith('/polls')) return '';
  const key = { denied: 'apply.err.denied', state: 'apply.err.state', failed: 'apply.err.failed', highrise: 'apply.err.highrise' }[code]
    || 'apply.err.failed';
  return `<div class="apply-alert" role="alert"><span aria-hidden="true">⚠</span><span>${esc(t(key))}</span></div>`;
}

// --- status chips ---

function statusChip(p) {
  if (p.status === 'open')   return `<span class="poll-chip is-live"><i aria-hidden="true"></i>${esc(t('polls.chip.live'))}</span>`;
  if (p.status === 'closed') return `<span class="poll-chip is-closed">${esc(t('polls.chip.closed'))}</span>`;
  return `<span class="poll-chip is-soon">${esc(t('polls.chip.soon'))}</span>`;
}

function whenLine(p) {
  if (p.status === 'open' && p.closesAt)     return t('polls.closes').replace('{date}', fmtDateTime(p.closesAt));
  if (p.status === 'upcoming' && p.opensAt)  return t('polls.opens').replace('{date}', fmtDate(p.opensAt));
  if (p.status === 'upcoming')               return t('polls.opens.soon');
  if (p.status === 'closed' && p.closesAt)   return t('polls.closed.on').replace('{date}', fmtDate(p.closesAt));
  return '';
}

// --- gates (signed out / no wallet / not a holder) ---

function signinGate() {
  return `
    <div class="poll-gate">
      <div class="poll-gate-ico" aria-hidden="true">🔐</div>
      <div class="poll-gate-body">
        <h4>${esc(t('polls.gate.signin.h'))}</h4>
        <p>${esc(t('polls.gate.signin.p'))}</p>
      </div>
      <a class="apply-discord-btn poll-discord-btn" href="/api/auth/discord/login?return=%2Fpolls">
        <span class="apply-discord-logo">${DISCORD_SVG}</span>
        <span class="apply-discord-label">${esc(t('apply.signin.btn'))}</span>
        <span class="apply-discord-shine" aria-hidden="true"></span>
      </a>
    </div>`;
}

function blockedGate(viewer) {
  const nowallet = !viewer.linked;
  return `
    <div class="poll-gate">
      <div class="poll-gate-ico" aria-hidden="true">${nowallet ? '🔗' : '🔒'}</div>
      <div class="poll-gate-body">
        <h4>${esc(t(nowallet ? 'polls.gate.nowallet.h' : 'polls.gate.holder.h'))}</h4>
        <p>${esc(t(nowallet ? 'polls.gate.nowallet.p' : 'polls.gate.holder.p'))}</p>
      </div>
    </div>`;
}

// --- option rows / voting ---

function optionRow(p, opt, interactive) {
  const checked = sel[p.id] === opt;
  // Each option carries its upside and its cost, price scenarios included (the
  // Council asked for the implications to be on the ballot, so every vote is an
  // informed one). A plain pitch line is the fallback for polls without that copy.
  const pitch = ptOpt(p, `opt.${opt}.p`);
  const pro = ptOpt(p, `opt.${opt}.pro`);
  const con = ptOpt(p, `opt.${opt}.con`);
  // The references button sits next to the label, not in it: a button inside a
  // label is invalid markup, and a tap on it must never pick the option.
  const refs = p.refs?.[opt] || [];
  return `
    <div class="poll-opt">
      <label class="ballot-opt ${checked ? 'is-checked' : ''} ${interactive ? '' : 'is-preview'} ${refs.length ? 'has-refs' : ''}">
        <input type="radio" name="poll-${esc(p.id)}" value="${esc(opt)}" ${checked ? 'checked' : ''} ${interactive ? '' : 'disabled'} />
        <span class="ballot-opt-dot" aria-hidden="true"></span>
        <span class="ballot-opt-body">
          <span class="ballot-opt-name">${esc(pt(p, `opt.${opt}`))}</span>
          ${pitch ? `<span class="ballot-opt-pitch">${esc(pitch)}</span>` : ''}
          ${pro ? `<span class="ballot-opt-take is-pro"><i aria-hidden="true">✓</i>${esc(pro)}</span>` : ''}
          ${con ? `<span class="ballot-opt-take is-con"><i aria-hidden="true">✕</i>${esc(con)}</span>` : ''}
        </span>
      </label>
      ${refs.length ? `
      <button class="poll-refs-btn" type="button" data-refs="${esc(opt)}" data-poll="${esc(p.id)}" aria-haspopup="dialog">
        ${REFS_ICON}<span>${esc(t('polls.refs.btn'))}</span><span class="poll-refs-n">${refs.length}</span>
      </button>` : ''}
    </div>`;
}

// --- reference pins (a sheet of Pinterest embeds per option) ---

const REFS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M7 5V3h14v14h-2"/><path d="m3 15 4-4 4 4 2-2 4 4"/></svg>';

// One dialog on <body>, outside #polls-app: the poll list re-renders on every pick
// and tap, and that must not tear down an open sheet or reload its frames.
let refsDlg = null;
function refsDialog() {
  if (refsDlg) return refsDlg;
  refsDlg = document.createElement('dialog');
  refsDlg.className = 'col-modal poll-refs-modal';
  refsDlg.setAttribute('aria-labelledby', 'poll-refs-h');
  document.body.appendChild(refsDlg);
  refsDlg.addEventListener('click', e => { if (e.target === refsDlg) refsDlg.close(); }); // backdrop tap
  refsDlg.addEventListener('close', () => { refsDlg.innerHTML = ''; }); // drop the frames: nothing loads after close
  return refsDlg;
}

function openRefs(p, opt) {
  const ids = p.refs?.[opt] || [];
  if (!ids.length) return;
  const dlg = refsDialog();
  const pitch = ptOpt(p, `opt.${opt}.p`);
  // Pinterest renders each pin in its own frame, sized to the frame's width. The
  // frames load only now, when someone opens the sheet.
  const pins = ids.map((id, i) => `
    <figure class="poll-ref">
      <iframe src="https://assets.pinterest.com/ext/embed.html?id=${encodeURIComponent(id)}"
        title="${esc(t('polls.refs.pin').replace('{n}', i + 1).replace('{total}', ids.length))}"
        loading="lazy" scrolling="no" referrerpolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>
      <a class="poll-ref-open" href="https://www.pinterest.com/pin/${encodeURIComponent(id)}/" target="_blank" rel="noopener noreferrer">${esc(t('polls.refs.open'))}</a>
    </figure>`).join('');
  dlg.innerHTML = `
    <div class="poll-refs">
      <span class="poll-refs-glow" aria-hidden="true"></span>
      <button class="col-insp-x" type="button" data-close aria-label="${esc(t('polls.refs.close'))}">✕</button>
      <div class="poll-refs-head">
        <span class="poll-refs-eyebrow">${esc(t('polls.refs.eyebrow'))}</span>
        <h3 class="poll-refs-h" id="poll-refs-h">${esc(pt(p, `opt.${opt}`))}</h3>
        ${pitch ? `<p class="poll-refs-p">${esc(pitch)}</p>` : ''}
      </div>
      <div class="poll-refs-track" tabindex="0" aria-label="${esc(t('polls.refs.track'))}">${pins}</div>
      <div class="poll-refs-foot">
        <p class="poll-refs-note">${esc(t('polls.refs.note'))}</p>
        <div class="poll-refs-nav">
          <button class="col-insp-step" type="button" data-scroll="-1" aria-label="${esc(t('polls.refs.prev'))}">‹</button>
          <button class="col-insp-step" type="button" data-scroll="1" aria-label="${esc(t('polls.refs.next'))}">›</button>
        </div>
      </div>
    </div>`;
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  const track = dlg.querySelector('.poll-refs-track');
  dlg.querySelectorAll('[data-scroll]').forEach(b => b.addEventListener('click', () => {
    const card = track.querySelector('.poll-ref');
    const step = card ? card.getBoundingClientRect().width + 14 : 250; // one pin plus the gap
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    track.scrollBy({ left: step * Number(b.dataset.scroll), behavior: smooth ? 'smooth' : 'auto' });
  }));
  if (!dlg.open) dlg.showModal();
}

function optionsBlock(p, interactive) {
  return `
    <div class="ballot-opts poll-opts" role="radiogroup" aria-label="${esc(pt(p, 'title'))}">
      ${p.options.map(opt => optionRow(p, opt, interactive)).join('')}
    </div>`;
}

function castControls(p) {
  const isArmed = armed === p.id;
  const isBusy = busy === p.id;
  const hasSel = !!sel[p.id];
  const label = isBusy ? t('polls.casting') : isArmed ? t('polls.confirm') : t('polls.cast');
  const msg = pollMsg[p.id];
  return `
    <div class="ballot-cast-row">
      <button class="appf-btn-primary ballot-cast ${isArmed ? 'is-armed' : ''}" type="button"
        data-poll-cast="${esc(p.id)}" ${hasSel && !isBusy ? '' : 'disabled'}>${esc(label)}</button>
      <span class="ballot-final-chip"><i aria-hidden="true"></i>${esc(t('polls.final'))}</span>
    </div>
    ${msg ? `<div class="ballot-msg is-${esc(msg.kind)}" role="alert">${esc(msg.text)}</div>` : ''}`;
}

// The voter's locked-in vote, with its receipt.
function votedBlock(p) {
  const fresh = !!justCast[p.id];
  return `
    <div class="ballot-voted ${fresh ? 'is-fresh' : ''}">
      <div class="ballot-voted-pick">
        <span class="ballot-voted-chip"><i aria-hidden="true">✓</i>${esc(t('polls.youchose'))} <strong>${esc(pt(p, `opt.${p.myVote.choice}`))}</strong></span>
        <span class="ballot-receipt-pair"><span class="ballot-receipt-l">${esc(t('polls.receipt'))}</span><code class="ballot-receipt">${esc(p.myVote.receipt)}</code></span>
      </div>
    </div>
    <p class="ballot-receipt-keep">${esc(t('polls.receipt.keep'))}</p>`;
}

// --- results (closed polls only) ---

function resultsBlock(p) {
  const counts = p.results?.counts || {};
  const total = Object.values(counts).reduce((n, v) => n + v, 0);
  const top = Math.max(0, ...Object.values(counts));
  const rows = [...p.options]
    .sort((a, b) => (counts[b] || 0) - (counts[a] || 0))
    .map((opt, i) => {
      const n = counts[opt] || 0;
      const pct = total ? Math.round((n / total) * 100) : 0;
      const win = total > 0 && n === top;
      return `
        <div class="poll-res-row ${win ? 'is-win' : ''}" style="--i:${i}">
          <span class="poll-res-label">${win && !p.results?.live ? '<i aria-hidden="true">✓</i>' : ''}${esc(pt(p, `opt.${opt}`))}</span>
          <span class="poll-res-bar" aria-hidden="true"><i style="--w:${total ? Math.max(2, Math.round((n / (top || 1)) * 100)) : 0}%"></i></span>
          <span class="poll-res-n"><strong>${pct}%</strong> · ${n}</span>
        </div>`;
    }).join('');

  const receipts = p.results?.receipts || [];
  const receiptsBlock = receipts.length ? `
    <details class="race-receipts">
      <summary>${esc(t('polls.res.receipts').replace('{n}', receipts.length))}</summary>
      <p class="race-receipts-p">${esc(t('polls.res.receipts.p'))}</p>
      <div class="race-receipt-grid">${receipts.map(c => `<code>${esc(c)}</code>`).join('')}</div>
    </details>` : '';

  const live = !!p.results?.live;
  const mine = p.myVote && !live ? `
    <div class="poll-res-mine">
      <span class="ballot-voted-chip"><i aria-hidden="true">✓</i>${esc(t('polls.youchose'))} <strong>${esc(pt(p, `opt.${p.myVote.choice}`))}</strong></span>
      <span class="ballot-receipt-pair"><span class="ballot-receipt-l">${esc(t('polls.receipt'))}</span><code class="ballot-receipt">${esc(p.myVote.receipt)}</code></span>
    </div>` : '';

  return `
    <div class="poll-results">
      <h4 class="poll-res-h">${esc(t(live ? 'polls.results.live' : 'polls.results'))}</h4>
      ${live ? `<p class="poll-note">${esc(t('polls.results.live.p'))}</p>` : ''}
      ${rows}
      ${mine}
      ${receiptsBlock}
    </div>`;
}

// --- the poll card ---

function pollCard(p, i, viewer) {
  const parts = [];

  if (p.status === 'closed') {
    parts.push(resultsBlock(p));
  } else if (p.status === 'upcoming') {
    parts.push(`<p class="poll-note">${esc(t('polls.note.upcoming'))}</p>`);
    parts.push(optionsBlock(p, false));
  } else if (p.myVote) {
    parts.push(votedBlock(p));
  } else if (!viewer.authenticated) {
    parts.push(optionsBlock(p, false));
    parts.push(signinGate());
  } else if (!viewer.holder) {
    parts.push(optionsBlock(p, false));
    parts.push(blockedGate(viewer));
  } else {
    parts.push(`<p class="ballot-explain">${esc(t('polls.pick'))}</p>`);
    parts.push(optionsBlock(p, true));
    parts.push(castControls(p));
  }
  // A poll that opted into live results shows the running totals under the ballot.
  if (p.status === 'open' && p.results?.live) parts.push(resultsBlock(p));

  const when = whenLine(p);
  const showTurnout = p.status !== 'upcoming' && p.turnout > 0;
  return `
    <article class="poll-card is-${esc(p.status)} ${revealed ? 'is-static' : ''}" style="--i:${i}">
      <div class="apply-aurora" aria-hidden="true"></div>
      <div class="poll-top">
        ${statusChip(p)}
        <span class="poll-official">${esc(t('polls.chip.official'))}</span>
        ${when ? `<span class="poll-when">${esc(when)}</span>` : ''}
      </div>
      <h3 class="poll-h">${esc(pt(p, 'title'))}</h3>
      <p class="poll-p">${esc(pt(p, 'desc'))}</p>
      ${parts.join('')}
      <div class="poll-foot">
        <span class="poll-foot-chip">${esc(t('polls.onevote'))}</span>
        ${showTurnout ? `<span class="poll-turnout"><span class="poll-turnout-n" data-to="${p.turnout}">0</span> ${esc(t('polls.turnout'))}</span>` : ''}
      </div>
    </article>`;
}

// Signed-in member strip at the top of the list (mirrors the eligibility card's id row).
function viewerStrip(viewer) {
  if (!viewer.authenticated) return '';
  const profile = viewer.profile || {};
  const avatarSrc = profile.highriseIcon || profile.avatar;
  const avatar = avatarSrc
    ? `<img class="poll-viewer-avatar" src="${esc(avatarSrc)}" alt="" loading="lazy" />`
    : '<span class="poll-viewer-avatar is-fallback" aria-hidden="true">👤</span>';
  const holderChip = viewer.holder
    ? `<span class="poll-viewer-chip is-yes"><i aria-hidden="true">✓</i>${esc(t('polls.viewer.holder'))}</span>`
    : `<span class="poll-viewer-chip is-no">${esc(t('polls.viewer.notholder'))}</span>`;
  return `
    <div class="poll-viewer" data-reveal>
      ${avatar}
      <span class="poll-viewer-name">${esc(profile.username || '')}</span>
      ${holderChip}
      <a class="apply-logout poll-viewer-out" href="/api/auth/logout?return=%2Fpolls">${esc(t('apply.logout'))}</a>
    </div>`;
}

function listView(d) {
  const polls = d.polls || [];
  if (!polls.length) {
    return `
      ${authError()}
      ${viewerStrip(d.viewer || {})}
      <div class="poll-card poll-empty" data-reveal>
        <div class="apply-aurora" aria-hidden="true"></div>
        <div class="poll-gate-ico" aria-hidden="true">🗳️</div>
        <p class="poll-note">${esc(t('polls.none'))}</p>
      </div>`;
  }
  // Live polls first, then upcoming, then closed (newest definition order within each).
  const order = { open: 0, upcoming: 1, closed: 2 };
  const sorted = [...polls].sort((a, b) => order[a.status] - order[b.status]);
  return `
    ${authError()}
    ${viewerStrip(d.viewer || {})}
    <div class="poll-list" data-reveal>
      ${sorted.map((p, i) => pollCard(p, i, d.viewer || {})).join('')}
    </div>`;
}

function errorView() {
  return `
    <div class="poll-card poll-error" data-reveal>
      <p>${esc(t('polls.loaderr'))}</p>
      <button class="apply-btn-ghost" type="button" id="polls-retry">${esc(t('apply.retry'))}</button>
    </div>`;
}

// Count-up the turnout numbers (respects reduced-motion).
function animateCounts(el) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.querySelectorAll('.poll-turnout-n[data-to]').forEach(node => {
    const to = Number(node.dataset.to) || 0;
    if (reduce || to <= 0) { node.textContent = String(to); return; }
    const dur = 1000, start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      node.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function castVote(pollId) {
  clearTimeout(armTimer);
  busy = pollId;
  pollMsg = { ...pollMsg, [pollId]: null };
  render();
  let res, out = {};
  try {
    res = await fetch('/api/polls/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ poll: pollId, choice: sel[pollId] }),
    });
    out = await res.json().catch(() => ({}));
  } catch { /* network — handled below as a generic error */ }
  busy = null;
  armed = null;
  if (res && res.ok) {
    justCast[pollId] = out.receipt;
    delete sel[pollId];
    await loadPolls(false); // re-fetch so the voted state comes from the server
    return;
  }
  if (res && res.status === 409) {
    pollMsg[pollId] = { kind: 'error', text: out.error || t('polls.already') };
    await loadPolls(false); // re-sync (e.g. a second tab voted in the meantime)
    return;
  }
  pollMsg[pollId] = { kind: 'error', text: out.error || t('polls.err') };
  render();
}

function bind(el) {
  el.querySelectorAll('.poll-opts input[type="radio"]:not([disabled])').forEach(inp => {
    inp.addEventListener('change', () => {
      const pollId = inp.name.replace(/^poll-/, '');
      sel[pollId] = inp.value;
      if (armed === pollId) { armed = null; clearTimeout(armTimer); } // new pick disarms the final tap
      pollMsg[pollId] = null;
      render();
    });
  });
  // Final votes get a two-tap cast: first tap arms the button, second confirms.
  // An armed button auto-disarms after 5s so it can't linger primed.
  el.querySelectorAll('[data-poll-cast]').forEach(btn => {
    btn.addEventListener('click', () => {
      const pollId = btn.dataset.pollCast;
      if (!sel[pollId] || busy) return;
      clearTimeout(armTimer);
      if (armed !== pollId) {
        armed = pollId;
        armTimer = setTimeout(() => { if (armed === pollId) { armed = null; render(); } }, 5000);
        render();
        return;
      }
      castVote(pollId);
    });
  });
  el.querySelectorAll('[data-refs]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = (data?.polls || []).find(x => x.id === btn.dataset.poll);
      if (p) openRefs(p, btn.dataset.refs);
    });
  });
  el.querySelector('#polls-retry')?.addEventListener('click', () => loadPolls(true));
}

function render() {
  const el = root();
  if (!el || data === null) return;
  el.setAttribute('aria-busy', 'false');
  el.innerHTML = data.error ? errorView() : listView(data);
  bind(el);
  if (!data.error) { animateCounts(el); revealed = true; }
}

// Live totals refresh every 30s while the tab is visible, and only re-render when a
// count actually moved (a re-render replays the bars and would drop a half-made pick).
let liveTimer = 0;
function scheduleLive() {
  clearInterval(liveTimer);
  if (!data?.polls?.some(p => p.status === 'open' && p.results?.live)) return;
  liveTimer = setInterval(async () => {
    if (document.hidden || busy || armed || !root()) return;
    try {
      const res = await fetch('/api/polls', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const next = await res.json();
      const sig = d => JSON.stringify((d.polls || []).map(p => [p.id, p.status, p.turnout, p.results?.counts, p.myVote?.receipt]));
      if (sig(next) !== sig(data)) { data = next; render(); }
    } catch { /* keep the last totals */ }
  }, 30000);
}

export async function loadPolls(showSpinner = true) {
  const el = root();
  if (!el) return;
  if (showSpinner) {
    el.setAttribute('aria-busy', 'true');
    el.innerHTML = '<div class="apply-loading"><div class="apply-spinner"></div></div>';
  }
  try {
    const res = await fetch('/api/polls', { headers: { Accept: 'application/json' } });
    data = res.ok ? await res.json() : { error: true };
  } catch {
    data = { error: true };
  }
  render();
  scheduleLive();
}

// Re-render with cached state after a language switch.
export function rerenderPolls() {
  if (data !== null) render();
}
