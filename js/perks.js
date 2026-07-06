// Perks tab — Creature Coin yield calculator. Everything else on the panel is
// static data-i18n markup; this module only owns the interactive math: steppers,
// locale-aware number formatting, and the animated running total.
import { t, getCurrentLang } from './i18n.js';

const RATES = { epic: 25, legendary: 75, land: 25, pland: 75 };
const MAX = 999;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const counts = { epic: 1, legendary: 0, land: 0, pland: 0 };
let dayEl, weekEl, monthEl, liveEl;
let shownDay = 0; // last rendered daily total, so changes animate from it
let rafId = 0;

const fmt = n => new Intl.NumberFormat(getCurrentLang()).format(n);
const dailyTotal = () =>
  Object.keys(RATES).reduce((sum, k) => sum + RATES[k] * counts[k], 0);

function setTotals(animate) {
  const day = dailyTotal();
  weekEl.textContent  = fmt(day * 7);
  monthEl.textContent = fmt(day * 30);
  // One announcement per change — the rAF ticker below would spam readers.
  liveEl.textContent = `${fmt(day)} ${t('coins.calc.day')}`;
  cancelAnimationFrame(rafId);
  if (!animate || reduceMotion.matches || day === shownDay) {
    shownDay = day;
    dayEl.textContent = fmt(day);
    return;
  }
  const from = shownDay, dur = 450;
  shownDay = day;
  let t0 = null;
  const frame = ts => {
    if (t0 === null) t0 = ts;
    const p = Math.min((ts - t0) / dur, 1);
    dayEl.textContent = fmt(Math.round(from + (day - from) * (1 - Math.pow(1 - p, 3))));
    if (p < 1) rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);
}

function applyStepperLabels() {
  document.querySelectorAll('.perx-stepbtn').forEach(btn => {
    btn.setAttribute('aria-label', t(btn.dataset.step === '1' ? 'coins.calc.plus' : 'coins.calc.minus'));
  });
}

export function initPerks() {
  dayEl   = document.getElementById('perx-total-day');
  weekEl  = document.getElementById('perx-total-week');
  monthEl = document.getElementById('perx-total-month');
  liveEl  = document.getElementById('perx-total-live');
  if (!dayEl || !weekEl || !monthEl || !liveEl) return;

  document.querySelectorAll('.perx-count').forEach(input => {
    const key = input.dataset.calc;
    input.value = counts[key];
    input.addEventListener('input', () => {
      counts[key] = Math.min(MAX, Math.max(0, parseInt(input.value, 10) || 0));
      setTotals(true);
    });
    // Snap stray input (blank, minus signs, >MAX) back to the clamped value
    input.addEventListener('blur', () => { input.value = counts[key]; });
  });

  document.querySelectorAll('.perx-stepbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.calc;
      counts[key] = Math.min(MAX, Math.max(0, counts[key] + Number(btn.dataset.step)));
      document.querySelector(`.perx-count[data-calc="${key}"]`).value = counts[key];
      setTotals(true);
    });
  });

  applyStepperLabels();
  setTotals(false);
}

// Language switch: re-format grouped numbers and re-translate aria labels
export function rerenderPerks() {
  if (!dayEl) return;
  applyStepperLabels();
  setTotals(false);
}
