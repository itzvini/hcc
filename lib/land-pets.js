// Renders the Slime pet attached to a Highrise LAND parcel as one self-contained SVG.
//
// Highrise composites pets in-browser from per-part vector assets — there is no
// server-rendered image anywhere. This reproduces their pipeline (same algorithm as
// the proven HighriseHelper Discord-bot renderer):
//
//   1. GetLandParcelRequest -> the pet's outfit (parts, palettes, dependent colors).
//   2. Download each part's zip from the avatar CDN; the `front-*` entry inside is a
//      plain SVG with the DEFAULT palette baked into `fill:` colors.
//   3. Recolor: remap the default palette to the pet's active palette, resolving
//      dependent colors against the body part's palette.
//   4. Compose the recolored parts, in canonical draw order, into one SVG whose
//      viewBox is the union of the part bounds — every part INLINE, because SVGs
//      loaded via <img> refuse to load external resources (the bug this replaces).
//
// No rasterizer needed: the browser renders the SVG itself. Everything here reads
// public data only; no keys, no user input beyond integer coordinates.

const zlib = require('zlib');
const crypto = require('crypto');

const PARCEL_API_URL = 'https://highrise.game/web/api';
const AVATAR_ZIP_URL = id => `https://cdn.highrisegame.com/avatar/${encodeURIComponent(id)}.zip`;

// Canonical bottom->top draw order, derived from known-good pet composites.
const Z_ORDER = [
  'shadow', 'slimebase', 'base', 'interior', 'mouth', 'face', 'eye', 'nose',
  'horn', 'ear', 'antenna', 'hat', 'glasses', 'accessory',
];

function zRank(itemId) {
  const name = String(itemId || '').toLowerCase();
  const i = Z_ORDER.findIndex(k => name.includes(k));
  return i === -1 ? Z_ORDER.length : i; // unknown parts render on top
}

// Zip entries are named <view>-<item_id>-<Layer>.vec. Only the front view is drawn;
// within it, a part can ship SEVERAL layers (ears: SideEarBack/SideEarFront/
// TopEarBack/TopEarFront) plus alternate animation states we must skip (LeftEyeClosed/
// RightEyeClosed blink frames, SadMouth expression). Verified across every part of all
// listed parcels' pets (54 distinct parts, 2026-06-10) — this is the full vocabulary.
const STATE_VARIANT = /Closed$|^SadMouth$/;
const layerOf = entryName => (entryName.match(/-([A-Za-z]+)\.vec$/) || [])[1] || '';

// Layers named *Back tuck BEHIND the slime body (a cat ear pokes out from behind the
// head); everything else stacks by its part's kind. Shadow=0, body=1, so 0.5 slots
// back-layers between them.
const layerRank = (itemId, layer) => (/Back$/.test(layer) ? 0.5 : zRank(itemId));

// The leading comment encodes minX, minY, width, height as four %05d fixed-width
// fields, e.g. <!---0023-00330004600039--> -> [-23, -33, 46, 39].
function parseViewbox(text) {
  const m = text.match(/^\s*<!--(.*?)-->/s);
  if (!m) return null;
  const c = m[1].trim();
  if (c.length < 20) return null;
  const fields = [0, 5, 10, 15].map(i => Number(c.slice(i, i + 5)));
  return fields.every(Number.isInteger) ? fields : null;
}

const stripComment = text => text.replace(/^\s*<!--.*?-->/s, '').trim();

function recolor(svg, colorMap) {
  const keys = Object.keys(colorMap).sort((a, b) => b.length - a.length); // longest first: #abc must not shadow #abcdef
  if (!keys.length) return svg;
  const pattern = new RegExp('#(' + keys.join('|') + ')', 'gi'); // keys are hex — no escaping needed
  return svg.replace(pattern, (_, hex) => '#' + colorMap[hex.toLowerCase()]);
}

// For each outfit part, map its baked default-palette colors to the colors it
// should actually use (active palette + dependent colors resolved against the
// first part of the source category — for pets that's the slimebase body).
function buildColorMaps(outfit) {
  const info = new Map(); // part -> {default, target}
  const categoryBase = new Map();
  for (const part of outfit) {
    const palettes = part?.colors?.palettes?.length ? part.colors.palettes : [[]];
    const active = part?.active_palette ?? 0;
    const target = [...(palettes[active] ?? palettes[0])];
    info.set(part, { default: [...palettes[0]], target });
    if (part?.category && !categoryBase.has(part.category)) categoryBase.set(part.category, part);
  }
  for (const part of outfit) {
    const target = info.get(part).target;
    for (const entry of part?.colors?.dependent_colors || []) {
      if (!Array.isArray(entry) || entry.length !== 3) continue;
      const [srcCategory, srcIndex, dstIndex] = entry;
      const source = categoryBase.get(srcCategory);
      if (!source) continue;
      const srcTarget = info.get(source).target;
      if (srcIndex >= 0 && srcIndex < srcTarget.length && dstIndex >= 0 && dstIndex < target.length) {
        target[dstIndex] = srcTarget[srcIndex];
      }
    }
  }
  const maps = new Map(); // part -> {defaultHexLower: targetHex}
  for (const part of outfit) {
    const { default: def, target } = info.get(part);
    const cmap = {};
    for (let i = 0; i < Math.min(def.length, target.length); i++) {
      if (def[i] && target[i] && /^[0-9a-f]{3,8}$/i.test(def[i]) && /^[0-9a-f]{3,8}$/i.test(target[i])) {
        cmap[String(def[i]).toLowerCase()] = String(target[i]);
      }
    }
    maps.set(part, cmap);
  }
  return maps;
}

// Defense in depth: the part SVGs come from Highrise's CDN, but they get served
// from OUR origin — strip anything active or external before composing. The real
// assets are pure <path style="fill:#…"> data, so this never bites legit content.
function scrubSvg(svg) {
  return svg
    .replace(/<script[\s\S]*?(?:<\/script>|\/>)/gi, '')
    .replace(/<foreignObject[\s\S]*?(?:<\/foreignObject>|\/>)/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/((?:xlink:)?href\s*=\s*["'])(?!#)[^"']*(["'])/gi, '$1$2')
    .replace(/javascript:/gi, '');
}

function positionPart(partSvg, viewbox) {
  const [mx, my, w, h] = viewbox;
  const attrs = ` x="${mx}" y="${my}" width="${w}" height="${h}" viewBox="${mx} ${my} ${w} ${h}" overflow="visible"`;
  return partSvg.replace(/<svg\b([^>]*)>/, (_, a) => `<svg${a}${attrs}>`);
}

function compose(parts) {
  const minX = Math.min(...parts.map(p => p.viewbox[0]));
  const minY = Math.min(...parts.map(p => p.viewbox[1]));
  const maxX = Math.max(...parts.map(p => p.viewbox[0] + p.viewbox[2]));
  const maxY = Math.max(...parts.map(p => p.viewbox[1] + p.viewbox[3]));
  const width = maxX - minX, height = maxY - minY;
  const inner = parts.map(p => positionPart(p.svg, p.viewbox)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `viewBox="${minX} ${minY} ${width} ${height}" width="${width * 8}" height="${height * 8}">${inner}</svg>`;
}

// --- minimal ZIP reader (entries are tiny: stored or raw-deflate) ---------------

function zipEntries(buf) {
  // End-of-central-directory record: scan backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('no EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // central directory offset
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf, entry) {
  // Local header repeats name/extra with its own lengths — skip via those.
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('bad local header');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip method ${entry.method}`);
}

// --- network, bounded ------------------------------------------------------------

// Small semaphore so a burst of tiles can't stampede Highrise's API/CDN.
let active = 0;
const waiters = [];
async function limited(fn) {
  if (active >= 8) await new Promise(r => waiters.push(r));
  active++;
  try { return await fn(); }
  finally { active--; (waiters.shift() || (() => {}))(); }
}

async function fetchParcel(entityId) {
  return limited(async () => {
    const res = await fetch(PARCEL_API_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ _type: 'GetLandParcelRequest', entity_id: entityId }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`parcel HTTP ${res.status}`);
    // The API replies with application/octet-stream; the body is JSON regardless.
    return JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
  });
}

// item_id -> [{layer, viewbox, svg}] in DEFAULT palette (recoloring is per-pet,
// parts are shared across thousands of pets — cache the neutral form). All idle
// front-view layers, in archive order.
const partCache = new Map();

async function fetchPart(itemId) {
  if (!itemId || typeof itemId !== 'string') return null;
  const hit = partCache.get(itemId);
  if (hit !== undefined) return hit;
  let layers = null;
  try {
    const buf = await limited(async () => {
      const res = await fetch(AVATAR_ZIP_URL(itemId), { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`part HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    for (const entry of zipEntries(buf)) {
      if (!entry.name.startsWith('front-')) continue; // back- = rear view, never drawn
      const layer = layerOf(entry.name);
      if (STATE_VARIANT.test(layer)) continue; // blink frames / sad expression
      const text = zipRead(buf, entry).toString('utf8');
      const viewbox = parseViewbox(text);
      if (viewbox) (layers ??= []).push({ layer, viewbox, svg: scrubSvg(stripComment(text)) });
    }
  } catch (err) {
    console.error(`LAND pet part ${itemId} failed:`, err.message);
    return null; // not cached — transient failures may recover
  }
  if (partCache.size > 800) partCache.clear();
  partCache.set(itemId, layers); // null is cached too: a malformed part stays malformed
  return layers;
}

async function buildPetSvg(outfit) {
  if (!Array.isArray(outfit) || !outfit.length) return null;
  const colorMaps = buildColorMaps(outfit);
  // Flatten parts into individually-ranked layers (an ear part contributes both a
  // behind-the-body piece and an in-front piece), then sort: Array.prototype.sort is
  // stable, so same-rank layers keep outfit + archive order.
  const layers = (await Promise.all(outfit.map(async part => {
    const fetched = await fetchPart(part?.item_id);
    return (fetched || []).map(l => ({
      rank: layerRank(part.item_id, l.layer),
      viewbox: l.viewbox,
      svg: recolor(l.svg, colorMaps.get(part) || {}),
    }));
  }))).flat().sort((a, b) => a.rank - b.rank);
  return layers.length ? compose(layers) : null;
}

// --- public API --------------------------------------------------------------------

// entityId -> {status:'ok', svg, etag} | {status:'none'}, with TTLs. Pets virtually
// never change, but owners CAN swap them — hours-stale is fine, days-stale isn't.
const petCache = new Map();
const inflight = new Map();
const OK_TTL = 6 * 60 * 60 * 1000;
const NONE_TTL = 15 * 60 * 1000;

function cachePet(key, value, ttl) {
  if (petCache.size > 3000) petCache.clear();
  petCache.set(key, { ...value, expires: Date.now() + ttl });
  return value;
}

// Render (or serve from cache) the pet for parcel (x, y). Returns
//   {status:'ok', svg, etag} — composed SVG ready to serve
//   {status:'none'}          — parcel exists but has no pet (caller: 404)
// and throws on upstream failure (caller: 503).
async function renderPet(x, y) {
  const key = `${x}:${y}`;
  const hit = petCache.get(key);
  if (hit && hit.expires > Date.now()) return hit;
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const parcel = await fetchParcel(key);
    const pet = parcel?.attached_items?.pets?.[0];
    if (!pet) return cachePet(key, { status: 'none' }, NONE_TTL);
    const svg = await buildPetSvg(pet.outfit);
    if (!svg) return cachePet(key, { status: 'none' }, NONE_TTL);
    const etag = `"${crypto.createHash('sha1').update(svg).digest('base64url')}"`;
    return cachePet(key, { status: 'ok', svg, etag }, OK_TTL);
  })();
  inflight.set(key, job);
  try { return await job; }
  finally { inflight.delete(key); }
}

module.exports = { renderPet };
