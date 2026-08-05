import { t, getCurrentLang } from './i18n.js';

// Council board (Council › The Council) — who holds the seven seats. The roster itself
// is static data-i18n markup in index.html, because names, seat labels and roles are
// editorial. This module owns only the part that can't be hardcoded: the term dates in
// the reader's language, how much of the six months has run, and how much is left.
//
// Each seat's dates come off its .cb-term block:
//   data-term-start   the day the member took the seat (YYYY-MM-DD, required)
//   data-term-end     the day the term runs out — elected seats only. Appointed seats
//                     leave it off and get a plain "seated on" line instead of a bar.

const MS_DAY = 24 * 60 * 60 * 1000;

// 'YYYY-MM-DD' → local midnight. Built from parts rather than Date.parse, which reads
// a bare date as UTC and lands on the previous day for anyone west of Greenwich.
function parseDay(value) {
  const [y, m, d] = String(value || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}

function fmtDay(date, withYear) {
  return date.toLocaleDateString(getCurrentLang(), {
    month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}),
  });
}

// "Jun 17 – Dec 17, 2026". formatRange does the joining itself, so the connector comes
// from the locale instead of a translated string — a key that fell back to English
// would otherwise sit in the middle of a translated date.
function fmtRange(start, end) {
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  const f = new Intl.DateTimeFormat(getCurrentLang(), opts);
  return f.formatRange ? f.formatRange(start, end)
    : `${fmtDay(start, start.getFullYear() !== end.getFullYear())} – ${fmtDay(end, true)}`;
}

function daysLeftLabel(days) {
  if (days < 0) return t('cboard.term.over');
  if (days === 0) return t('cboard.term.lastday');
  if (days === 1) return t('cboard.term.left1');
  return t('cboard.term.left').replace('{n}', days);
}

function renderTerm(box) {
  const start = parseDay(box.dataset.termStart);
  if (!start) return;
  const end = parseDay(box.dataset.termEnd);
  const range = box.querySelector('[data-term-range]');
  const left  = box.querySelector('[data-term-left]');

  if (!end) {                                   // appointed seat — no term to count down
    if (range) range.textContent = fmtDay(start, true);
    return;
  }
  if (range) range.textContent = fmtRange(start, end);

  // Whole days, measured from today's midnight, so the bar and the "days left" line
  // never disagree by a few hours.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const span = Math.max(1, Math.round((end - start) / MS_DAY));
  const gone = Math.round((today - start) / MS_DAY);
  const pct  = Math.min(100, Math.max(0, Math.round((gone / span) * 100)));

  const fill = box.querySelector('.cb-term-bar i');
  if (fill) fill.style.setProperty('--w', `${pct}%`);
  if (left) left.textContent = daysLeftLabel(span - gone);
}

function render() {
  document.querySelectorAll('#panel-council .cb-term[data-term-start]').forEach(renderTerm);
}

export function initCouncilBoard() { render(); }

// Dates and the days-left line are language-dependent, so redo them on a switch.
export function rerenderCouncilBoard() { render(); }
