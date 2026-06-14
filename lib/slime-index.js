// Slime-pet catalogue: every LAND parcel's attached Slime, its named parts as
// filterable traits, and a statistical rarity rank — the data behind the "browse by
// Slime" explorer (mirrors the Creature collection index, but for LAND's slimes).
//
// Slimes aren't on-chain and there is no bulk endpoint, so the catalogue is a heavy
// background SWEEP: one Highrise game-API call per parcel (~2,973), routed through the
// pet renderer's shared concurrency limiter so the sweep and on-demand tile renders
// can't stampede Highrise together. Built once at boot, refreshed daily. Slime parts
// all report rarity "rare", so — like Creatures — the real rarity signal is a
// statistical rank computed from how common each part value is across the collection.
//
// Read-only public data; integer coordinates only.

const landMarket = require('./land-market');
const landPets = require('./land-pets');

// Outfit parts are item_ids like `body-pet_eye08`, `body-pet_horn010devilhorns`.
// The alpha token after `body-pet_` is the slot. slimebase/shadow are structural
// (every slime has them, one value) — kept out of the facets; eye/mouth/interior are
// the discriminating slots; everything that sits on the head (horn/ear/antenna/wing/
// flower/…) is exactly-one-per-slime, so they collapse into a single "Headpiece" facet.
const SLOT_LABEL = { eye: 'Eyes', mouth: 'Mouth', interior: 'Interior' };
const HEAD_SLOTS = new Set(['horn', 'ear', 'antenna', 'wing', 'wings', 'flower', 'flowers', 'hat', 'glasses', 'accessory']);
const STRUCTURAL = new Set(['slimebase', 'shadow', 'base']);

function slotOf(itemId) {
  const m = /^body-pet_([a-z]+)/i.exec(String(itemId || ''));
  return m ? m[1].toLowerCase() : null;
}
// The facet a part belongs to, or null if it's structural / unfacetable.
function traitTypeOf(itemId) {
  const slot = slotOf(itemId);
  if (!slot || STRUCTURAL.has(slot)) return null;
  if (SLOT_LABEL[slot]) return SLOT_LABEL[slot];
  if (HEAD_SLOTS.has(slot)) return 'Headpiece';
  return slot[0].toUpperCase() + slot.slice(1); // unknown slot → its own facet, Title-cased
}

const FACET_TYPES = ['Eyes', 'Mouth', 'Interior', 'Headpiece'];

// Shape one parcel's pet into a catalogue row, or null if the parcel has no slime.
function shapeSlime(parcel, meta) {
  const pet = parcel?.attached_items?.pets?.[0];
  if (!pet || !Array.isArray(pet.outfit)) return null;
  const traits = {};
  const parts = [];
  for (const p of pet.outfit) {
    const type = traitTypeOf(p.item_id);
    parts.push({ itemId: p.item_id || null, name: p.name || null, rarity: p.rarity || null, type });
    if (type && p.name) traits[type] = String(p.name); // last wins; head slots are 1-per-slime
  }
  return {
    tokenId: meta.tokenId,
    coords: { x: meta.x, y: meta.y },
    slimeName: pet.name || null,            // owner nickname, e.g. "Gleepy"
    parcelName: meta.name || `LAND (${meta.x}, ${meta.y})`,
    traits,                                  // {Eyes, Mouth, Interior, Headpiece}
    parts,                                   // full part list for the detail view
  };
}

// Bounded sweep: cap simultaneous in-flight parcel fetches (on top of land-pets' own
// limiter) so a transient Highrise hiccup can't pile up thousands of pending requests.
async function sweep(coords, onResult) {
  const SWEEP_CONCURRENCY = 6;
  let i = 0, ok = 0, miss = 0;
  async function worker() {
    while (i < coords.length) {
      const meta = coords[i++];
      try {
        const parcel = await landPets.fetchParcel(`${meta.x}:${meta.y}`);
        const slime = shapeSlime(parcel, meta);
        if (slime) { onResult(slime); ok++; } else miss++;
      } catch { miss++; } // one dead parcel must not sink the sweep
    }
  }
  await Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, worker));
  return { ok, miss };
}

async function buildSlimeIndex() {
  const coords = await landMarket.allParcelCoords();
  const items = [];
  const { ok, miss } = await sweep(coords, slime => items.push(slime));

  // Statistical rarity (same formula as the Creature index): a slime's score is the
  // sum over its facetable traits of total/frequency(value) — rare parts dominate.
  const freq = new Map();
  for (const it of items) {
    for (const type of FACET_TYPES) {
      const v = it.traits[type];
      if (v != null) freq.set(`${type}:${v}`, (freq.get(`${type}:${v}`) || 0) + 1);
    }
  }
  const total = items.length;
  for (const it of items) {
    let score = 0;
    for (const type of FACET_TYPES) {
      const v = it.traits[type];
      if (v != null) score += total / freq.get(`${type}:${v}`);
    }
    it.score = score;
  }
  items.sort((a, b) => b.score - a.score || a.tokenId.localeCompare(b.tokenId));
  items.forEach((it, n) => { it.rank = n + 1; });

  const byCoord = new Map(items.map(it => [`${it.coords.x}:${it.coords.y}`, it]));
  const byToken = new Map(items.map(it => [String(it.tokenId), it]));
  console.log(`Slime index built: ${total} slimes (${miss} parcels without one) of ${coords.length} parcels.`);
  return { items, byCoord, byToken, total, parcels: coords.length, builtAt: Date.now() };
}

// Non-blocking accessor with a daily TTL and a failure cool-down — same lifecycle as
// the Creature collection index. Returns null until the first sweep lands; callers
// degrade gracefully (browse falls back to listed-only LAND).
const idx = { data: null, at: 0, inFlight: null, failedAt: 0 };
const TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

function getSlimeIndex() {
  const fresh = idx.data && Date.now() - idx.at < TTL_MS;
  const cooling = Date.now() - idx.failedAt < RETRY_MS;
  if (!fresh && !idx.inFlight && !cooling) {
    idx.inFlight = buildSlimeIndex()
      .then(d => { idx.data = d; idx.at = Date.now(); return d; })
      .catch(err => { idx.failedAt = Date.now(); console.error('Slime index build failed:', err.message); })
      .finally(() => { idx.inFlight = null; });
  }
  return idx.data;
}

module.exports = { getSlimeIndex, FACET_TYPES };
