import { t } from './i18n.js';

// Scam Watch (Guides › Scam Watch) — the two interactive pieces:
//   1) "Spot the scam" — a mock DM whose red flags are tappable. Tapping one
//      reveals why it's a flag and bumps the score; find them all to win.
//   2) A safety checklist whose ticked state persists per-device in localStorage,
//      driving a progress bar and a "done" note.
// Everything else on the panel is static i18n markup. All copy flows through t();
// this module never invents display text, and re-runs on each language switch.

const CHECK_KEY = 'hcc-safety-check';

// Fill {token} placeholders in a translated string.
function fmt(key, vars) {
  return String(t(key)).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// ---------- Spot the scam ----------

function spotRoot() { return document.getElementById('scam-spot'); }

// Rebuild the side panel: score, the running explanation list (one entry per found
// flag, in message order — no overlapping popovers), and the win note. Called on
// every toggle and after each language switch (applyTranslations only touches the
// flags' own text, so we re-source the explanations from data-i18n-tip here).
function updateSpotScore() {
  const root = spotRoot();
  if (!root) return;
  const flags = [...root.querySelectorAll('[data-flag]')];
  const total = flags.length;
  const foundFlags = flags.filter(f => f.classList.contains('is-found'));
  const found = foundFlags.length;

  const countEl = root.querySelector('[data-count]');
  const totalEl = root.querySelector('[data-total]');
  const label   = root.querySelector('[data-scam-progress]');
  const hint     = root.querySelector('[data-scam-hint]');
  const tipList = root.querySelector('[data-scam-tips]');
  const win     = root.querySelector('[data-scam-win]');

  if (countEl) countEl.textContent = String(found);
  if (totalEl) totalEl.textContent = String(total);
  if (label) {
    label.textContent = found === 0 ? t('guide.scam.spot.startlabel')
                                    : fmt('guide.scam.spot.progress', { found, total });
  }
  if (hint) hint.hidden = found > 0;
  if (tipList) {
    tipList.replaceChildren(...foundFlags.map(f => {
      const li = document.createElement('li');
      li.textContent = t(f.getAttribute('data-i18n-tip'));
      return li;
    }));
  }
  if (win) win.hidden = !(total > 0 && found === total);
}

function toggleFlag(flag, on) {
  const found = on ?? !flag.classList.contains('is-found');
  flag.classList.toggle('is-found', found);
  flag.setAttribute('aria-pressed', String(found));
  updateSpotScore();
}

function initSpot() {
  const root = spotRoot();
  if (!root) return;

  // Turn each flag into an accessible toggle. Drop the placeholder aria-label so the
  // real DM text becomes the button's name.
  root.querySelectorAll('[data-flag]').forEach(flag => {
    flag.removeAttribute('aria-label');
    flag.setAttribute('aria-pressed', 'false');
  });

  // Delegated handlers survive the textContent resets applyTranslations does.
  root.addEventListener('click', e => {
    const flag = e.target.closest?.('[data-flag]');
    if (flag && root.contains(flag)) toggleFlag(flag);
  });
  root.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const flag = e.target.closest?.('[data-flag]');
    if (flag && root.contains(flag)) { e.preventDefault(); toggleFlag(flag); }
  });

  root.querySelector('[data-scam-reveal]')?.addEventListener('click', () => {
    root.querySelectorAll('[data-flag]').forEach(f => toggleFlag(f, true));
  });
  root.querySelector('[data-scam-reset]')?.addEventListener('click', () => {
    root.querySelectorAll('[data-flag]').forEach(f => toggleFlag(f, false));
  });
}

// ---------- Safety checklist ----------

function checkRoot() { return document.getElementById('scam-check'); }

function loadCheckState() {
  try { return JSON.parse(localStorage.getItem(CHECK_KEY)) || {}; }
  catch { return {}; }
}
function saveCheckState(state) {
  try { localStorage.setItem(CHECK_KEY, JSON.stringify(state)); } catch {}
}

function updateCheckProgress() {
  const root = checkRoot();
  if (!root) return;
  const items = [...root.querySelectorAll('[data-check-item]')];
  const total = items.length;
  const done  = items.filter(i => i.checked).length;

  const fill     = root.querySelector('[data-check-fill]');
  const progress = root.querySelector('[data-check-progress]');
  const doneNote = root.querySelector('[data-check-done]');

  if (fill) fill.style.width = total ? `${(done / total) * 100}%` : '0%';
  if (progress) progress.textContent = fmt('guide.scam.check.progress', { done, total });
  if (doneNote) doneNote.hidden = !(total > 0 && done === total);
}

function initCheck() {
  const root = checkRoot();
  if (!root) return;
  const items = [...root.querySelectorAll('[data-check-item]')];
  const state = loadCheckState();

  items.forEach((item, i) => {
    item.checked = !!state[i];
    item.addEventListener('change', () => {
      const s = loadCheckState();
      s[i] = item.checked;
      saveCheckState(s);
      updateCheckProgress();
    });
  });
}

// ---------- Public API ----------

export function initSafety() {
  initSpot();
  initCheck();
}

// Re-run after translations load and on every language switch: refresh the score,
// the explanation list, and the checklist progress strings in the active language.
export function rerenderSafety() {
  updateSpotScore();
  updateCheckProgress();
}
