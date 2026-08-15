// Last-known snapshots of upstream market data.
//
// This is deliberately NOT a cache, and is kept separate from the TTL caches so the happy
// path cannot accidentally read it. The rule the owner set: listings must show CURRENT
// status. So:
//
//   - a SUCCESSFUL fetch never reads from here, it only writes.
//   - a FAILED fetch may read from here, and whatever it serves is labelled stale, with
//     its real age, and trading is paused.
//   - past maxAgeMs the snapshot is DROPPED, not served. That is what makes the
//     degraded -> down transition deterministic instead of showing hour-old prices.
//
// Only failure branches call read().
'use strict';

const store = new Map(); // key -> { data, at }

// Bound memory: these snapshots are per route + cursor + address, so a busy site can
// accumulate keys. Oldest out first.
const MAX_KEYS = 128;

function record(key, data) {
  if (data == null) return;
  if (store.size >= MAX_KEYS && !store.has(key)) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) store.delete(oldest[0]);
  }
  store.set(key, { data, at: Date.now() });
}

// Returns { data, at } or null when there is nothing usable. `maxAgeMs` is required so a
// caller cannot accidentally serve an unbounded-age snapshot.
function read(key, maxAgeMs) {
  const hit = store.get(key);
  if (!hit) return null;
  if (!Number.isFinite(maxAgeMs) || Date.now() - hit.at > maxAgeMs) {
    store.delete(hit === store.get(key) ? key : key); // aged out: drop it, don't serve it
    return null;
  }
  return { data: hit.data, at: hit.at };
}

const clear = () => store.clear();

module.exports = { record, read, clear };
