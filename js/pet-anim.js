// Header slimes: animation baked from the real Highrise skeleton.
//
// tools/build-pet-sprites.py packs frames that the HCC Pet Animation Baker rendered inside
// Highrise Studio. The site only ever receives pixels — sprite sheets and a frame table —
// never the rig, so nothing here can be re-rigged or re-animated elsewhere.
//
// The still <img> in each .pet-wrap is the first paint, stays as the picture under reduced
// motion, and stays whenever a sheet fails to load. Idle sheets load once the page is idle,
// then the small face sheets the idle blinks and moves its mouth with; the reactions (hop on
// hover, backflip on click or tap) load the first time a pointer reaches the row. Each
// reaction's lift is a CSS animation on the wrap (pet-hop, pet-flip); the frames only squash,
// stretch and turn in place.

const BASE = '/assets/pets/anim/';
const pets = [];
let raf = 0;
let inView = true;
let reactionsRequested = false;
const REACTIONS = { jump: 'is-jumping', backflip: 'is-flipping' };

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => (img.decode ? img.decode().then(() => resolve(img), () => resolve(img)) : resolve(img));
    img.onerror = reject;
    img.src = url;
  });
}

// AVIF first (about 40% smaller); a browser that can't decode it falls back to WebP.
function loadSheet(name) {
  return loadImage(`${BASE}${name}.avif`).catch(() => loadImage(`${BASE}${name}.webp`));
}

function whenIdle(fn) {
  if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 2500 });
  else setTimeout(fn, 400);
}

function blit(pet, sheet, index, alpha) {
  const { w, h, cols } = pet.meta;
  pet.ctx.globalAlpha = alpha;
  pet.ctx.drawImage(sheet, (index % cols) * w, Math.floor(index / cols) * h, w, h, 0, 0, w, h);
}

function draw(pet, now) {
  let clip = pet.meta.clips[pet.clip];
  let sheet = pet.sheets[pet.clip];
  if (!sheet) {                       // the hop's sheet isn't here yet: keep idling
    pet.clip = 'idle';
    clip = pet.meta.clips.idle;
    sheet = pet.sheets.idle;
  }
  // A reaction starts from an event handler, whose clock can run a little ahead of this
  // frame's rAF time: below zero would draw frame -1, an empty cell, and blank the slime.
  let f = Math.max(0, ((now - pet.t0) / 1000) * clip.fps);
  if (!clip.loop && f >= clip.count - 1) {
    const next = pet.queued;
    pet.queued = null;
    if (next && start(pet, next)) return draw(pet, now);
    pet.clip = 'idle';
    pet.t0 = now;
    return draw(pet, now);
  }
  if (clip.loop) f %= clip.count;
  const i = Math.floor(f);
  const face = faceAt(pet, now);
  // A face is cut from one idle frame, so it's laid on that frame alone, not on a blend.
  const t = clip.blend && !face ? f - i : 0;
  const j = clip.loop ? (i + 1) % clip.count : Math.min(i + 1, clip.count - 1);
  // Cross-fades in eight steps per frame are indistinguishable from continuous ones and
  // let most animation frames skip the redraw.
  const key = `${pet.clip}:${i}:${Math.round(t * 8)}:${face || ''}`;
  if (key === pet.drawn) return;
  pet.drawn = key;

  const { ctx } = pet;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, pet.meta.w, pet.meta.h);
  const step = Math.round(t * 8) / 8;
  blit(pet, sheet, i, 1 - step);
  if (step > 0) {
    // 'lighter' adds premultiplied pixels, so (1 - t) * A + t * B is an exact blend of two
    // frames with no halo where their edges differ.
    ctx.globalCompositeOperation = 'lighter';
    blit(pet, sheet, j, step);
  }
  if (face) {
    // The crop fades out at its edges, where it matches the frame under it, so no seam shows.
    const c = pet.meta.faces[face];
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(pet.faceSheets[face], (i % c.cols) * c.w, Math.floor(i / c.cols) * c.h, c.w, c.h, c.x, c.y, c.w, c.h);
  }
}

const rand = ([lo, hi]) => lo + Math.random() * (hi - lo);

// Idle faces: now and then the idle blinks or moves its mouth, using the pet's own closed-eye
// and second-mouth art (see tools/build-pet-sprites.py). One face at a time; reactions wear
// their own faces, baked into their frames. Returns the face to show now, or null.
function faceAt(pet, now) {
  if (pet.clip !== 'idle') {
    pet.face = null;
    return null;
  }
  if (!pet.face) {
    // the face that has waited longest goes first, so blinks never crowd out the mouth
    const due = Object.keys(pet.faceSheets)
      .filter(name => now >= pet.faceDue[name])
      .sort((a, b) => pet.faceDue[a] - pet.faceDue[b])[0];
    if (!due) return null;
    const { patterns, every } = pet.meta.faces[due];
    pet.face = { name: due, steps: patterns[Math.floor(Math.random() * patterns.length)], t0: now };
    pet.faceDue[due] = now + rand(every);
  }
  // steps alternate on, off, on, ... in ms
  let at = now - pet.face.t0;
  for (let k = 0; k < pet.face.steps.length; k++) {
    if (at < pet.face.steps[k]) return k % 2 === 0 ? pet.face.name : null;
    at -= pet.face.steps[k];
  }
  // done: keep the next face from following straight on
  for (const name of Object.keys(pet.faceDue)) pet.faceDue[name] = Math.max(pet.faceDue[name], now + 600);
  pet.face = null;
  return null;
}

function loadFaces(pet) {
  for (const [name, c] of Object.entries(pet.meta.faces || {})) {
    loadSheet(c.sheet).then(img => {
      pet.faceSheets[name] = img;
      pet.faceDue[name] = performance.now() + rand(c.every);
    }, () => {});
  }
}

function tick(now) {
  raf = 0;
  for (const pet of pets) draw(pet, now);
  schedule();
}

function schedule() {
  if (!raf && inView && !document.hidden && pets.length) raf = requestAnimationFrame(tick);
}

// Start a reaction: its frames here, its lift as the wrap's CSS class. False when the clip
// wasn't baked or its sheet hasn't arrived yet.
function start(pet, clip) {
  if (!pet.meta.clips[clip] || !pet.sheets[clip]) return false;
  const { wrap } = pet;
  for (const cls of Object.values(REACTIONS)) wrap.classList.remove(cls);
  void wrap.offsetWidth;   // restart the CSS animation even if the same class comes back
  wrap.classList.add(REACTIONS[clip]);
  pet.clip = clip;
  pet.t0 = performance.now();
  pet.drawn = '';
  schedule();
  return true;
}

// Hover: a hop, unless the pet is already busy. A hop lifts the pet off the cursor and lands
// it back under it, which reads as a fresh hover; restarting then snapped it mid-air.
function hop(pet) {
  if (pet.clip !== 'idle') return;
  if (!start(pet, 'jump')) pet.wrap.classList.add('is-jumping');   // no frames yet: lift only
}

// Click or tap: a backflip. A tap fires mouseenter and click together, so a hop that started
// a moment ago gives way at once; one already in the air finishes and the flip follows it.
function flip(pet) {
  if (!pet.meta.clips.backflip || pet.clip === 'backflip') return;
  if (!pet.sheets.backflip) {          // still loading: flip as soon as it lands, if that's soon
    pet.wantsFlip = performance.now();
    loadClip(pet, 'backflip');
    return;
  }
  if (pet.clip === 'jump' && performance.now() - pet.t0 > 200) {
    pet.queued = 'backflip';
    return;
  }
  start(pet, 'backflip');
}

function loadClip(pet, clip) {
  const c = pet.meta.clips[clip];
  if (!c || pet.loading[clip]) return;
  pet.loading[clip] = loadSheet(c.sheet).then(img => {
    pet.sheets[clip] = img;
    if (clip === 'backflip' && pet.wantsFlip && performance.now() - pet.wantsFlip < 1500 && pet.clip === 'idle') {
      pet.wantsFlip = 0;
      start(pet, 'backflip');
    }
  }, () => {});
}

// The hop loads as soon as a pointer reaches the row; the backflip, about as big again, waits
// for the browser to be idle after that unless someone clicks first.
function loadReactions(pet) {
  loadClip(pet, 'jump');
  whenIdle(() => loadClip(pet, 'backflip'));
}

function requestReactions() {
  if (reactionsRequested) return;
  reactionsRequested = true;
  pets.forEach(loadReactions);
}

async function setUp(wrap) {
  const slug = wrap.dataset.anim;
  try {
    const res = await fetch(`${BASE}${slug}.json`);
    if (!res.ok) return;
    const meta = await res.json();
    const idle = await loadSheet(meta.clips.idle.sheet);
    const canvas = document.createElement('canvas');
    canvas.width = meta.w;
    canvas.height = meta.h;
    canvas.className = 'pet-frame';
    canvas.setAttribute('aria-hidden', 'true');
    const pet = {
      wrap, meta, canvas,
      queued: null,
      loading: {},
      wantsFlip: 0,
      ctx: canvas.getContext('2d'),
      sheets: { idle },
      faceSheets: {},
      faceDue: {},
      face: null,
      clip: 'idle',
      // Each slime starts at its own point in the loop so the row doesn't breathe in step.
      t0: performance.now() - Math.random() * (meta.clips.idle.count / meta.clips.idle.fps) * 1000,
      drawn: '',
    };
    draw(pet, performance.now());
    wrap.appendChild(canvas);
    wrap.classList.add('is-playing');   // CSS hides the still under the canvas
    wrap.dataset.animReady = '1';   // app.js leaves this pet's reactions to this module
    wrap.addEventListener('mouseenter', () => hop(pet));
    wrap.addEventListener('click', () => flip(pet));
    wrap.addEventListener('animationend', e => {
      if (e.animationName === 'pet-hop') wrap.classList.remove('is-jumping');
      if (e.animationName === 'pet-flip') wrap.classList.remove('is-flipping');
    });
    pets.push(pet);
    whenIdle(() => loadFaces(pet));
    if (reactionsRequested) loadReactions(pet);
    schedule();
  } catch {
    // keep the still
  }
}

export function initPetAnim() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const wraps = [...document.querySelectorAll('.pet-wrap[data-anim]')];
  if (!wraps.length) return;

  const row = wraps[0].parentElement;
  row.addEventListener('pointerenter', requestReactions, { once: true });
  row.addEventListener('touchstart', requestReactions, { once: true, passive: true });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      inView = entries.some(e => e.isIntersecting);
      schedule();
    }).observe(row);
  }
  document.addEventListener('visibilitychange', schedule);

  const start = () => whenIdle(() => wraps.forEach(setUp));
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
