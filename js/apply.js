import { t } from './i18n.js';

// Council "Apply & Vote" panel: Discord sign-in → eligibility check.
// All dynamic copy goes through t() so it follows the active language; user-supplied
// values (Discord name, wallet) are escaped before being injected as HTML.

const root = () => document.getElementById('apply-app');
let lastState = null; // cached /api/me payload so a language switch can re-render

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shortWallet(addr) {
  return addr && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : (addr || '');
}

const BRACKET_KEY = { single: 'apply.bracket.single', mid: 'apply.bracket.mid', whale: 'apply.bracket.whale' };

// Map the ?auth=... flag set by the OAuth callback to a friendly message.
function authError() {
  const code = new URLSearchParams(location.search).get('auth');
  if (!code) return '';
  const key = { denied: 'apply.err.denied', state: 'apply.err.state', failed: 'apply.err.failed' }[code]
    || 'apply.err.failed';
  return `<div class="apply-alert" role="alert">${esc(t(key))}</div>`;
}

function signedOutView() {
  return `
    ${authError()}
    <div class="apply-card">
      <p class="apply-intro">${esc(t('apply.signin.intro'))}</p>
      <a class="apply-btn apply-btn-discord" href="/api/auth/discord/login">
        <span class="apply-discord-ico" aria-hidden="true">🎮</span>${esc(t('apply.signin.btn'))}
      </a>
    </div>`;
}

function statusRow(ok, label) {
  const icon = ok ? '✅' : '⛔';
  return `<div class="apply-status ${ok ? 'is-yes' : 'is-no'}"><span aria-hidden="true">${icon}</span><span>${esc(label)}</span></div>`;
}

function eligibilityView(profile, e) {
  const header = `
    <div class="apply-id">
      ${profile.avatar ? `<img class="apply-avatar" src="${esc(profile.avatar)}" alt="" />` : '<div class="apply-avatar apply-avatar-fallback" aria-hidden="true">👤</div>'}
      <div>
        <div class="apply-name">${esc(profile.username)}</div>
        <div class="apply-sub">${esc(t('apply.connected'))}</div>
      </div>
      <a class="apply-logout" href="/api/auth/logout">${esc(t('apply.logout'))}</a>
    </div>`;

  // No wallet linked at Highrise — nothing to check.
  if (!e.linked || !e.ethWallet) {
    return header + `
      <div class="apply-card apply-card-warn">
        <h3>${esc(t('apply.nowallet.h'))}</h3>
        <p>${esc(t('apply.nowallet.p'))}</p>
      </div>`;
  }

  // Holder snapshot not ready yet (cold cache / fetch in progress).
  if (!e.holdersAvailable) {
    return header + `
      <div class="apply-card apply-card-warn">
        <div class="apply-wallet">${esc(t('apply.wallet'))}: <code>${esc(shortWallet(e.ethWallet))}</code></div>
        <p>${esc(t('apply.holders.loading'))}</p>
        <button class="apply-btn apply-btn-ghost" type="button" id="apply-retry">${esc(t('apply.retry'))}</button>
      </div>`;
  }

  const bracketLabel = e.bracket ? t(BRACKET_KEY[e.bracket]) : t('apply.bracket.none');

  return header + `
    <div class="apply-card">
      <div class="apply-wallet">${esc(t('apply.wallet'))}: <code title="${esc(e.ethWallet)}">${esc(shortWallet(e.ethWallet))}</code></div>
      <div class="apply-counts">
        <div class="apply-count"><div class="apply-count-n">${e.creatureCount}</div><div class="apply-count-l">${esc(t('apply.count.creatures'))}</div></div>
        <div class="apply-count"><div class="apply-count-n">${e.landCount}</div><div class="apply-count-l">${esc(t('apply.count.land'))}</div></div>
        <div class="apply-count apply-count-total"><div class="apply-count-n">${e.totalCount}</div><div class="apply-count-l">${esc(t('apply.count.total'))}</div></div>
      </div>
      <div class="apply-statuses">
        ${statusRow(e.isMember, t('apply.is.member'))}
        ${statusRow(e.canVotePendingHoldTime, t('apply.is.vote'))}
        ${statusRow(e.canRun, e.canRun ? `${t('apply.is.run')} — ${bracketLabel}` : t('apply.is.run'))}
      </div>
      ${e.canVotePendingHoldTime ? `<p class="apply-note">${esc(t('apply.note.holdtime'))}</p>` : `<p class="apply-note">${esc(t('apply.note.nothold'))}</p>`}
    </div>`;
}

function render() {
  const el = root();
  if (!el) return;
  el.setAttribute('aria-busy', 'false');

  if (!lastState) {
    el.innerHTML = signedOutView();
  } else if (!lastState.authenticated) {
    el.innerHTML = signedOutView();
  } else {
    el.innerHTML = eligibilityView(lastState.profile || {}, lastState.eligibility || {});
    el.querySelector('#apply-retry')?.addEventListener('click', () => loadApply(true));
  }
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

// Re-render with cached state after a language switch.
export function rerenderApply() {
  if (lastState !== null) render();
}
