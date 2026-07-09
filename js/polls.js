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

// Map the ?auth=... flag set by the OAuth callback to a friendly message (the
// callback returns to /polls when the sign-in started here).
function authError() {
  const code = new URLSearchParams(location.search).get('auth');
  if (!code || !location.pathname.startsWith('/polls')) return '';
  const key = { denied: 'apply.err.denied', state: 'apply.err.state', failed: 'apply.err.failed' }[code]
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
  if (p.status === 'open' && p.closesAt)     return t('polls.closes').replace('{date}', fmtDate(p.closesAt));
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
  return `
    <label class="ballot-opt ${checked ? 'is-checked' : ''} ${interactive ? '' : 'is-preview'}">
      <input type="radio" name="poll-${esc(p.id)}" value="${esc(opt)}" ${checked ? 'checked' : ''} ${interactive ? '' : 'disabled'} />
      <span class="ballot-opt-dot" aria-hidden="true"></span>
      <span class="ballot-opt-body">
        <span class="ballot-opt-name">${esc(pt(p, `opt.${opt}`))}</span>
        ${pitch ? `<span class="ballot-opt-pitch">${esc(pitch)}</span>` : ''}
        ${pro ? `<span class="ballot-opt-take is-pro"><i aria-hidden="true">✓</i>${esc(pro)}</span>` : ''}
        ${con ? `<span class="ballot-opt-take is-con"><i aria-hidden="true">✕</i>${esc(con)}</span>` : ''}
      </span>
    </label>`;
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
          <span class="poll-res-label">${win ? '<i aria-hidden="true">✓</i>' : ''}${esc(pt(p, `opt.${opt}`))}</span>
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

  const mine = p.myVote ? `
    <div class="poll-res-mine">
      <span class="ballot-voted-chip"><i aria-hidden="true">✓</i>${esc(t('polls.youchose'))} <strong>${esc(pt(p, `opt.${p.myVote.choice}`))}</strong></span>
      <span class="ballot-receipt-pair"><span class="ballot-receipt-l">${esc(t('polls.receipt'))}</span><code class="ballot-receipt">${esc(p.myVote.receipt)}</code></span>
    </div>` : '';

  return `
    <div class="poll-results">
      <h4 class="poll-res-h">${esc(t('polls.results'))}</h4>
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
}

// Re-render with cached state after a language switch.
export function rerenderPolls() {
  if (data !== null) render();
}
