// Skeletons: the shape of what is coming, drawn while it comes.
//
// A spinner and a sentence say "wait". A skeleton says what for: the page keeps its layout,
// the eye already knows where the price and the names will land, and nothing jumps when the
// data arrives. Every loading state in the marketplace draws one from these few shapes, so
// they all move the same way: a soft shine runs across each shape, staggered by `i` so a
// block sweeps as one wave from top to bottom.
//
// Every region carries one plain sentence (with three pulsing dots beside it) and the
// shapes themselves are hidden from screen readers, which hear the sentence once.
// Under reduced motion the shine, the dots and the fade-in all stand still (styles.css).

import { esc } from './dom.js';

/**
 * One shape. `w` and `h` are CSS lengths (a number for `h` means px). `shape` is '' for a
 * text line, 'pill', 'round', 'tile' (an image square) or 'sq' (a square sized by its width).
 */
export function sk(w = '100%', h = 12, { i = 0, shape = '', cls = '' } = {}) {
  const hh = typeof h === 'number' ? `${h}px` : h;
  return `<span class="sk${shape ? ` is-${shape}` : ''}${cls ? ` ${cls}` : ''}" style="--w:${w};--h:${hh};--i:${i}"></span>`;
}

/** A loading region: the sentence for everyone, the shapes for the eye. */
export function skRegion(label, shapes, cls = '') {
  return `<div class="sk-region${cls ? ` ${cls}` : ''}" role="status" aria-busy="true">
    <p class="sk-caption"><span class="sk-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${esc(label)}</span></p>
    <div class="sk-shapes" aria-hidden="true">${shapes}</div>
  </div>`;
}

/** The sentence alone, for a region whose shapes sit somewhere a caption can't (a grid). */
export function skSay(label) {
  return `<span class="sk-sr" role="status">${esc(label)}</span>`;
}
