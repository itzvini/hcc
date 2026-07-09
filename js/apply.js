import { t } from './i18n.js';
import { openApplication, rerenderApplication } from './application.js';

// Council "Apply & Vote" panel: Discord sign-in → eligibility check, styled as the
// entrance to a premium members' club. All dynamic copy goes through t(); any
// user-supplied value (Discord name, wallet) is escaped before being injected.

const root = () => document.getElementById('apply-app');
let lastState = null; // cached /api/me payload so a language switch can re-render

// Official Discord mark (inlined so it inherits button colour via currentColor).
// Exported for the other Discord-gated panels (polls.js) so the mark stays one asset.
export const DISCORD_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>`;

const CHECK_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const LOCK_SVG  = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10V8a6 6 0 1112 0v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="4" y="10" width="16" height="11" rx="2.5" fill="currentColor"/></svg>`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shortWallet(addr) {
  return addr && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : (addr || '');
}

const BRACKET_KEY = { single: 'apply.bracket.single', mid: 'apply.bracket.mid', whale: 'apply.bracket.whale' };
const TIER_KEY    = { single: 'apply.tier.member',  mid: 'apply.tier.patron',  whale: 'apply.tier.icon' };

// Map the ?auth=... flag set by the OAuth callback to a friendly message.
function authError() {
  const code = new URLSearchParams(location.search).get('auth');
  if (!code) return '';
  const key = { denied: 'apply.err.denied', state: 'apply.err.state', failed: 'apply.err.failed' }[code]
    || 'apply.err.failed';
  return `<div class="apply-alert" role="alert"><span aria-hidden="true">⚠</span><span>${esc(t(key))}</span></div>`;
}

function discordButton() {
  return `
    <a class="apply-discord-btn" href="/api/auth/discord/login">
      <span class="apply-discord-logo">${DISCORD_SVG}</span>
      <span class="apply-discord-label">${esc(t('apply.signin.btn'))}</span>
      <span class="apply-discord-shine" aria-hidden="true"></span>
    </a>`;
}

function signedOutView() {
  return `
    ${authError()}
    <div class="apply-gate" data-reveal>
      <div class="apply-aurora" aria-hidden="true"></div>
      <div class="apply-sparkles" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      <span class="apply-pill">${esc(t('apply.members.badge'))}</span>
      <h3 class="apply-gate-h">${esc(t('apply.gate.h'))}</h3>
      <p class="apply-gate-p">${esc(t('apply.signin.intro'))}</p>
      ${discordButton()}
      <div class="apply-trust">
        <span>${esc(t('apply.trust.secure'))}</span>
        <span>${esc(t('apply.trust.readonly'))}</span>
      </div>
    </div>`;
}

function memberHeader(profile, tierKey) {
  const tier = tierKey
    ? `<span class="apply-tier" data-tier="${esc(tierKey)}">${esc(t(TIER_KEY[tierKey]))}</span>`
    : '';
  // Prefer the Highrise profile pic; fall back to the Discord avatar.
  const avatarSrc = profile.highriseIcon || profile.avatar;
  const avatar = avatarSrc
    ? `<img class="apply-avatar" src="${esc(avatarSrc)}" alt="" loading="lazy" />`
    : '<div class="apply-avatar apply-avatar-fallback" aria-hidden="true">👤</div>';
  return `
    <div class="apply-id">
      <div class="apply-avatar-wrap">${avatar}</div>
      <div class="apply-id-text">
        <div class="apply-name">${esc(profile.username)} ${tier}</div>
        <div class="apply-sub"><span class="apply-discord-dot">${DISCORD_SVG}</span>${esc(t('apply.connected'))}</div>
      </div>
      <a class="apply-logout" href="/api/auth/logout?return=%2Fcouncil%2Fvote">${esc(t('apply.logout'))}</a>
    </div>`;
}

function checkRow(ok, label, i) {
  return `
    <div class="apply-check ${ok ? 'is-yes' : 'is-no'}" style="--i:${i}">
      <span class="apply-check-ico" aria-hidden="true">${ok ? CHECK_SVG : LOCK_SVG}</span>
      <span class="apply-check-label">${esc(label)}</span>
    </div>`;
}

function statTile(value, label, accent) {
  return `
    <div class="apply-stat ${accent ? 'is-total' : ''}">
      <div class="apply-stat-n" data-to="${value}">0</div>
      <div class="apply-stat-l">${esc(label)}</div>
    </div>`;
}

function eligibilityView(profile, e, phase = {}) {
  // No wallet linked at Highrise — nothing to check.
  if (!e.linked || !e.ethWallet) {
    return `
      <div class="apply-member apply-member-warn" data-reveal>
        <div class="apply-aurora" aria-hidden="true"></div>
        ${memberHeader(profile, null)}
        <div class="apply-state-box">
          <div class="apply-state-ico" aria-hidden="true">🔗</div>
          <h3>${esc(t('apply.nowallet.h'))}</h3>
          <p>${esc(t('apply.nowallet.p'))}</p>
        </div>
      </div>`;
  }

  // Holder snapshot not ready yet (cold cache / fetch in progress).
  if (!e.holdersAvailable) {
    return `
      <div class="apply-member" data-reveal>
        <div class="apply-aurora" aria-hidden="true"></div>
        ${memberHeader(profile, null)}
        <div class="apply-wallet-chip"><span>${esc(t('apply.wallet'))}</span><code title="${esc(e.ethWallet)}">${esc(shortWallet(e.ethWallet))}</code></div>
        <div class="apply-state-box">
          <div class="apply-spinner" aria-hidden="true"></div>
          <p>${esc(t('apply.holders.loading'))}</p>
          <button class="apply-btn-ghost" type="button" id="apply-retry">${esc(t('apply.retry'))}</button>
        </div>
      </div>`;
  }

  const tierKey = e.canRun ? e.bracket : null;
  const bracketLabel = e.bracket ? t(BRACKET_KEY[e.bracket]) : t('apply.bracket.none');
  const eligible = e.isMember;

  // Running is only an option while the candidacy window is open; once it closes the
  // "Run for a seat" CTA disappears. During the voting phase the primary action for an
  // eligible holder is to vote — and voting runs through the candidate match below, so
  // we point them straight at it instead of leaving "Run for a seat" as the only button.
  const showRun  = e.canRun && phase.applicationsOpen;
  const showVote = phase.votingOpen && e.canVotePendingHoldTime;
  const note = !e.isMember ? t('apply.note.nothold')
    : showVote ? t('apply.note.vote')
    : t('apply.note.holdtime');

  return `
    <div class="apply-member ${eligible ? 'is-eligible' : ''}" data-tier="${esc(e.bracket || 'none')}" data-reveal>
      <div class="apply-aurora" aria-hidden="true"></div>
      <div class="apply-shine" aria-hidden="true"></div>
      ${memberHeader(profile, tierKey)}

      <div class="apply-wallet-chip"><span>${esc(t('apply.wallet'))}</span><code title="${esc(e.ethWallet)}">${esc(shortWallet(e.ethWallet))}</code></div>

      <div class="apply-stats">
        ${statTile(e.creatureCount, t('apply.count.creatures'), false)}
        ${statTile(e.landCount, t('apply.count.land'), false)}
        ${statTile(e.totalCount, t('apply.count.total'), true)}
      </div>

      <div class="apply-checks">
        ${checkRow(e.isMember, t('apply.is.member'), 0)}
        ${checkRow(e.canVotePendingHoldTime, t('apply.is.vote'), 1)}
        ${checkRow(e.canRun, e.canRun ? `${t('apply.is.run')} · ${bracketLabel}` : t('apply.is.run'), 2)}
      </div>

      <p class="apply-note">${esc(note)}</p>
      ${showVote ? `<button class="appf-btn-primary apply-run-cta apply-vote-cta" type="button" id="apply-vote">${esc(t('apply.cta.vote'))} <span aria-hidden="true">↓</span></button>` : ''}
      ${showRun ? `<button class="${showVote ? 'apply-btn-ghost' : 'appf-btn-primary'} apply-run-cta" type="button" id="apply-run">${esc(t('app.cta'))} <span aria-hidden="true">→</span></button>` : ''}
    </div>`;
}

// Count-up the holdings stats (respects reduced-motion).
function animateCounts(el) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.querySelectorAll('.apply-stat-n[data-to]').forEach(node => {
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
  if (!el) return;
  el.setAttribute('aria-busy', 'false');

  if (!lastState || !lastState.authenticated) {
    el.innerHTML = signedOutView();
    return;
  }
  el.innerHTML = eligibilityView(lastState.profile || {}, lastState.eligibility || {}, lastState.phase || {});
  el.querySelector('#apply-retry')?.addEventListener('click', () => loadApply(true));
  el.querySelector('#apply-run')?.addEventListener('click', () => openApplication(el, () => loadApply()));
  // "Vote now" scrolls to the voting flow: the unlocked ballot if the voter has already
  // reviewed their matches, otherwise the candidate match that unlocks it.
  el.querySelector('#apply-vote')?.addEventListener('click', () => {
    let adviceSeen = false;
    try { adviceSeen = localStorage.getItem('hcc-advice-seen') === '1'; } catch { /* private mode */ }
    const target = document.getElementById(adviceSeen ? 'ballot-app' : 'vote-app');
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  animateCounts(el);
}

export async function loadApply(force = false) {
  const el = root();
  if (!el) return;
  if (force) { el.setAttribute('aria-busy', 'true'); el.innerHTML = '<div class="apply-loading"><div class="apply-spinner"></div></div>'; }
  try {
    const res = await fetch('/api/me', { headers: { Accept: 'application/json' } });
    lastState = await res.json();
  } catch {
    lastState = { authenticated: false };
  }
  render();
}

// Re-render with cached state after a language switch. If the application form is
// open, let it re-render itself (keeping entered values) instead of clobbering it
// with the eligibility card.
export function rerenderApply() {
  if (rerenderApplication()) return;
  if (lastState !== null) render();
}
