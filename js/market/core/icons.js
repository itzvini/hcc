// Line icons for the marketplace.
//
// The money views used to label their choices with emoji — 💎 for "your ETH", ⛽ for gas,
// 💸 for cashing out. On a screen that asks a member to sign a real transaction that reads
// as a mock-up, and it renders differently on every platform: Windows draws a flat glyph,
// Apple a glossy 3D one, Android something else again. Nothing in the brand looks like any
// of them.
//
// So: one 24×24 stroke set drawn in the house style already used by the wallet, search and
// caret icons in marketplace.js — `currentColor`, 1.9px round joins, no fill. They inherit
// the surface's colour, which is what makes `--accent` theming work (mint on Add funds,
// lavender on Cash out) without a second copy of anything.
//
// Coins are the exception and stay real art: ETH and IMX are brand marks, and the project
// rule is that a brand mark is never an emoji stand-in. `coinIco()` serves the same files
// the bridge card does.

// Path data only. Everything shares one wrapper so stroke width and joins can't drift.
const PATHS = {
  // Money in / money out: a matched pair. Same tray, the arrow tells the story.
  fundsIn:  '<path d="M12 3v10"/><path d="m8.5 9.5 3.5 3.5 3.5-3.5"/><path d="M4 15.5v3A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-3"/>',
  fundsOut: '<path d="M12 14V4"/><path d="m8.5 7.5 3.5-3.5 3.5 3.5"/><path d="M4 15.5v3A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-3"/>',
  // Where the money lands when it leaves the club.
  bank: '<path d="m3 9.5 9-5.5 9 5.5"/><path d="M5.5 10.5v8"/><path d="M10 10.5v8"/><path d="M14 10.5v8"/><path d="M18.5 10.5v8"/><path d="M2.8 20.8h18.4"/>',
  // Keep shopping.
  bag: '<path d="M4.6 7.8h14.8l-1 12.4a1.2 1.2 0 0 1-1.2 1.1H6.8a1.2 1.2 0 0 1-1.2-1.1L4.6 7.8Z"/><path d="M8.7 10.6V6.9a3.3 3.3 0 0 1 6.6 0v3.7"/>',
  // Buy with a card.
  card: '<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 10h18"/><path d="M6.5 14.8h3.6"/>',
  // Gas. A pump, not a fuel-can, because the wallet UIs a member sees alongside use a pump.
  fuel: '<path d="M4.2 20.6V5.6A2.4 2.4 0 0 1 6.6 3.2h4A2.4 2.4 0 0 1 13 5.6v15"/><path d="M6.2 6.4h5.2v3.3H6.2z"/><path d="M2.6 20.8h12"/><path d="M13 11.2h2.5a1.9 1.9 0 0 1 1.9 1.9v3.4a1.7 1.7 0 0 0 3.4 0V9.4l-2.3-2.3"/>',
  // Status glyphs, replacing ⚠️ / ✓.
  alert: '<path d="M12 3.7 2.7 19.5a1.2 1.2 0 0 0 1 1.8h16.6a1.2 1.2 0 0 0 1-1.8Z"/><path d="M12 9.7v4.6"/><path d="M12 17.6h.01"/>',
  check: '<path d="m4.8 12.6 4.9 4.9L19.2 6.8"/>',
  // A tip worth reading before you sign something.
  bulb: '<path d="M9.2 17.6h5.6"/><path d="M10.3 20.8h3.4"/><path d="M8.3 14.1a5.5 5.5 0 1 1 7.4 0c-.8.8-1.2 1.6-1.2 2.5H9.5c0-.9-.4-1.7-1.2-2.5Z"/>',
  lock: '<path d="M6 10.6h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 6 10.6Z"/><path d="M8.3 10.6V7.9a3.7 3.7 0 0 1 7.4 0v2.7"/>',
  bolt: '<path d="M13.2 2.6 4.6 14.2h6.1l-.9 7.2 8.6-11.6h-6.1Z"/>',
  // Opens somewhere that isn't us.
  external: '<path d="M14.2 4.4h5.4v5.4"/><path d="M19.6 4.4 11 13"/><path d="M18.6 14.4V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7.4a2 2 0 0 1 2-2h3.6"/>',
  // Chevrons for the decorative arrows the views used to draw with → ↓ ←.
  chevronRight: '<path d="m9.5 5 7 7-7 7"/>',
  chevronDown:  '<path d="m5 9.5 7 7 7-7"/>',
  chevronLeft:  '<path d="m14.5 5-7 7 7 7"/>',
  arrowRight:   '<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>',

  // Market states: nothing found, nothing owned, nothing listed, nothing sold.
  search:  '<circle cx="10.8" cy="10.8" r="6.8"/><path d="M15.8 15.8 21 21"/>',
  // Price over time: the axes plus the line that runs across them.
  chart:   '<path d="M4 4v15.4a.6.6 0 0 0 .6.6H20"/><path d="m7 15.5 3.6-4.4 3 2.4 4.6-6"/>',
  wallet:  '<path d="M3.5 7.6A2.1 2.1 0 0 1 5.6 5.5h11.9a2 2 0 0 1 2 2v1.6"/><path d="M3.5 7.6v9.3a2.1 2.1 0 0 0 2.1 2.1h13.4a1.5 1.5 0 0 0 1.5-1.5v-6.4a1.5 1.5 0 0 0-1.5-1.5H5.6"/><path d="M16.6 13.2h.01"/>',
  receipt: '<path d="M5.5 3.5h13v17l-2.2-1.5-2.2 1.5-2.1-1.5-2.2 1.5-2.1-1.5-2.2 1.5Z"/><path d="M9 8.5h6"/><path d="M9 12.5h6"/>',
  box:     '<path d="M3.5 7.8 12 3.4l8.5 4.4v8.4L12 20.6l-8.5-4.4Z"/><path d="M3.7 7.9 12 12.2l8.3-4.3"/><path d="M12 12.2v8.4"/>',
  target:  '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.6"/><path d="M12 1.8v2.6"/><path d="M12 19.6v2.6"/><path d="M1.8 12h2.6"/><path d="M19.6 12h2.6"/>',

  // The rest of the shell's vocabulary.
  pause:   '<path d="M9.2 5.5v13"/><path d="M14.8 5.5v13"/>',
  chain:   '<path d="M9.6 14.4a3.6 3.6 0 0 0 5.1 0l3.1-3.1a3.6 3.6 0 0 0-5.1-5.1l-1 1"/><path d="M14.4 9.6a3.6 3.6 0 0 0-5.1 0l-3.1 3.1a3.6 3.6 0 0 0 5.1 5.1l1-1"/>',
  block:   '<circle cx="12" cy="12" r="8.4"/><path d="m6.1 6.1 11.8 11.8"/>',
  swap:    '<path d="M4 8.4h13"/><path d="m13.6 5 3.4 3.4-3.4 3.4"/><path d="M20 15.6H7"/><path d="M10.4 12 7 15.6 10.4 19"/>',
  shield:  '<path d="M12 3.2 4.8 6v5.5c0 4.2 3 7.6 7.2 9.3 4.2-1.7 7.2-5.1 7.2-9.3V6Z"/>',
  chat:    '<path d="M20.4 12.6a7.4 7.4 0 0 1-8 7.4l-5.1 1.4 1.4-4.2a7.4 7.4 0 1 1 11.7-4.6Z"/>',
  // Stand-ins for artwork that failed to load: a Creature, a parcel of LAND.
  paw:     '<ellipse cx="12" cy="15.4" rx="4.3" ry="3.6"/><circle cx="6.1" cy="11.3" r="2.1"/><circle cx="17.9" cy="11.3" r="2.1"/><circle cx="9.3" cy="7.1" r="2.1"/><circle cx="14.7" cy="7.1" r="2.1"/>',
  map:     '<path d="m3.4 6.6 5.6-2.2v13l-5.6 2.2Z"/><path d="M9 4.4l6 2.2v13l-6-2.2Z"/><path d="m15 6.6 5.6-2.2v13L15 19.6Z"/>',
};

/**
 * One icon, sized in px. Always decorative: every place these are used already states the
 * same thing in words right beside them, so announcing them again would only make a screen
 * reader read every option twice.
 */
export function ico(name, size = 20, cls = '') {
  const d = PATHS[name];
  if (!d) { console.error(`[market] no icon named "${name}"`); return ''; }
  return `<svg class="trade-ico${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" width="${size}" height="${size}"`
    + ` fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"`
    + ` aria-hidden="true" focusable="false">${d}</svg>`;
}

/**
 * A token's real mark. ETH and IMX are brands, so they get their artwork rather than a
 * lookalike glyph — the same files the bridge card and the balance rail already use, which
 * also means one cached image instead of two.
 */
export function coinIco(sym, size = 22) {
  const imx = String(sym).toUpperCase() === 'IMX';
  return `<img class="trade-ico-coin" src="${imx ? '/img/brands/imx.png' : '/img/brands/eth.png'}"`
    + ` alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
}
