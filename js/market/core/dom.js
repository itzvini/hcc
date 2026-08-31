// The two DOM primitives every market module needs: where the panel lives, and how to make
// a user-supplied string safe to drop into a template. Kept apart from everything else so a
// module that only builds HTML never has to import state or chain code to get them.

/** The marketplace panel's mount point, or null when the Trade tab has never been opened. */
export const root = () => document.getElementById('trade-app');

/**
 * Escape a value for interpolation into HTML. Every string that came from a wallet, an API
 * or a person goes through this — see the security note in .claude/CLAUDE.md.
 */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Build one section, and never let its failure take the page with it. The panel is written
 * in a single innerHTML assignment, so without this an exception anywhere in one collection's
 * builders threw before that assignment ran: the boot spinner stayed up, the loaders after
 * it never fired, and a Creature bug blanked LAND too. Now a broken section degrades to a
 * small notice and the rest of the panel, including the collection switcher, still paints.
 */
export function safeSection(fn, fallback = '') {
  try { return fn(); }
  catch (err) { console.error('marketplace: section failed to render:', err); return fallback; }
}
