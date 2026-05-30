const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';

// --- Holder stats ---
const CREATURE_HOLDERS_URL = 'https://explorer.immutable.com/api/v2/tokens/0xCf44b1cBC959295bbBb49935B1b339cC0AA77cdA/holders';
const LAND_COLLECTION = '0x8bf3a40ea2337e6e4f6e540680ea6390cb3b4e11';
const HOLDER_CACHE_TTL_MS = 30 * 60 * 1000;

const holderCache = { data: null, fetchedAt: 0, inFlight: null };

async function fetchAllCreatureHolders() {
  const holders = new Set();
  let pageParams = null;

  do {
    const url = new URL(CREATURE_HOLDERS_URL);
    if (pageParams) {
      for (const [k, v] of Object.entries(pageParams)) url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Explorer API ${res.status}`);
    const body = await res.json();
    for (const item of (body.items ?? [])) {
      const addr = item.address?.hash;
      if (typeof addr === 'string') holders.add(addr.toLowerCase());
    }
    pageParams = body.next_page_params ?? null;
  } while (pageParams);

  return holders;
}

async function fetchAllLandHolders() {
  const holders = new Set();
  let continuation = null;

  do {
    const url = new URL('https://api.reservoir.tools/owners/v2');
    url.searchParams.set('collection', LAND_COLLECTION);
    url.searchParams.set('limit', '500');
    if (continuation) url.searchParams.set('continuation', continuation);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Reservoir API ${res.status}`);
    const body = await res.json();
    for (const owner of (body.owners ?? [])) {
      if (typeof owner.address === 'string') holders.add(owner.address.toLowerCase());
    }
    continuation = body.continuation ?? null;
  } while (continuation);

  return holders;
}

async function computeHolderStats() {
  const [creatureHolders, landHolders] = await Promise.all([
    fetchAllCreatureHolders(),
    fetchAllLandHolders(),
  ]);
  let both = 0;
  for (const addr of creatureHolders) {
    if (landHolders.has(addr)) both++;
  }
  return {
    creaturesOnly: creatureHolders.size - both,
    landOnly: landHolders.size - both,
    both,
    totalUniqueHolders: creatureHolders.size + landHolders.size - both,
    totalCreatureHolders: creatureHolders.size,
    totalLandHolders: landHolders.size,
    lastFetched: new Date().toISOString(),
  };
}

function getHolderStats() {
  const now = Date.now();
  if (holderCache.data && (now - holderCache.fetchedAt) < HOLDER_CACHE_TTL_MS) {
    return Promise.resolve(holderCache.data);
  }
  if (!holderCache.inFlight) {
    holderCache.inFlight = computeHolderStats()
      .then(data => {
        holderCache.data = data;
        holderCache.fetchedAt = Date.now();
        holderCache.inFlight = null;
        return data;
      })
      .catch(err => {
        holderCache.inFlight = null;
        throw err;
      });
  }
  return holderCache.inFlight;
}

// Warm up cache in the background on startup
getHolderStats().catch(err => console.error('Holder stats prefetch failed:', err.message));

// --- Static file serving ---
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

function resolveFile(requestUrl) {
  const url = new URL(requestUrl, `http://${host}:${port}`);
  const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const normalizedPath = path.normalize(requestedPath).replace(/^([/\\])+/, '');
  const filePath = path.join(root, normalizedPath);

  if (!filePath.startsWith(root)) {
    return null;
  }

  return filePath;
}

const server = http.createServer((request, response) => {
  if (request.url.startsWith('/api/holders')) {
    getHolderStats()
      .then(data => {
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        });
        response.end(JSON.stringify(data));
      })
      .catch(() => {
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Holder data temporarily unavailable. Try again in a moment.' }));
      });
    return;
  }

  const filePath = resolveFile(request.url);

  if (!filePath) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable'
    });
    response.end(data);
  });
});

server.listen(port, host, () => {
  console.log(`HCC Player Council site running on http://${host}:${port}`);
});
