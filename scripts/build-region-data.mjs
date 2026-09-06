#!/usr/bin/env node
// Builds js/region-data.js — the coverage half of the country picker in the Funding and
// Cash out guides (js/region-pick.js). Everything here comes from a provider's OWN public
// coverage API, so a re-run is how the page stays honest. The hand-checked half (local
// venues, per-country notes, Kraken and Binance) lives in js/region-curated.js.
//
//   node scripts/build-region-data.mjs            # fetch, write js/region-data.js
//   node scripts/build-region-data.mjs --check    # fetch, report what would change
//
// Sources, all public and unauthenticated:
//   MetaMask  on-ramp-cache.api.cx.metamask.io/regions/countries   buy/sell per country and
//             US state, plus /regions/<cc>/light?action=sell for that country's payout rails
//   Binance   accounts.binance.com/bapi/accounts/v1/public/country/list   where it will open
//             an account at all (the list its own signup dropdown is built from)
//   MoonPay   api.moonpay.com/v3/countries   a SECOND, independent view of the off-ramp,
//             used only to cross-check MetaMask's — see note 6
//   Transak   api.transak.com/api/v2/currencies/fiat-currencies   which currency and payment
//             methods our card on-ramp has, and the countries each one covers
//             api.transak.com/api/v2/countries               its ID-document overlay
//
// If any source fails the script writes nothing. A half-filled coverage map on a money
// page is worse than a stale one: a missing country reads as "not available there".
//
// Two things worth knowing before you trust an output:
//   1. Transak sits behind Cloudflare, which 403s any plain fetch whatever headers it
//      carries. Those two calls run inside real Chromium, so this script needs playwright
//      installed locally (`npm i -D playwright`). It is deliberately NOT in package.json:
//      the site itself never needs it, and Railway would install it on every deploy.
//      Passing Immutable's partner key changes nothing — tested.
//   2. Transak's /countries returns only 26 entries, which is NOT its coverage: it is the
//      ID-document overlay. Coverage comes from each fiat currency's supportingCountries,
//      so a country outside that union is recorded as unconfirmed (tx.ok = null), never as
//      "not offered". The page then says we could not confirm it, which is the truth.
//   3. MetaMask has three ramp hosts and only one of them answers. `on-ramp.api` 404s
//      /regions entirely; `on-ramp-content.api` answers but reports every one of the 245
//      countries unsupported, which would have shipped a page saying nothing works
//      anywhere. `on-ramp-cache.api`, with the sdk/context query its own sell page sends,
//      is the one with real flags. Sniff portfolio.metamask.io/sell again if this breaks.
//      Note the United States reports unsupported at country level and carries the truth
//      on its states — that asymmetry is why the picker insists on a state.
//   4. Coinbase has no public coverage feed any more: api.coinbase.com/v2/countries 404s
//      as of this writing. Coinbase is therefore curated by hand in js/region-curated.js,
//      which is the better home for it anyway — "opens an account" and "pays your bank"
//      are different answers there, and only the second one is the one a seller needs.
//   5. Binance answers only half the question, and the half it answers is the account. The
//      signup country list is public and honest — the United States and its territories,
//      Cuba, Iran and North Korea are simply absent from it. Its BANK RAILS are not
//      public: every fiat endpoint 404s, and the fiat menu it does serve
//      (/bapi/fiat/v1/public/fiatpayment/menu/currency) mixes real bank rails with
//      person-to-person currencies, so reading "sell for Venezuelan bolívar and withdraw
//      to a bank" out of it would be an invention. So the page says what is true: it
//      opens accounts here, go and check its own deposit page for your currency. The
//      binance.us state list can't be read from outside the US either — it 403s.
//   6. MoonPay is here as a check, not as an option. It is one of the payment companies
//      behind MetaMask Sell, and its own country API is public, keyless, and carries
//      isSellAllowed per country plus per US state and per Canadian province. It is NOT
//      shown on the page: the guide's four options were each vetted and written up, and
//      members here distrust MoonPay by name. What it is good for is catching a coverage
//      claim that has gone stale. Two useful buckets fall out of comparing it to MetaMask:
//      countries where BOTH refuse (a corroborated dead end, worth more confidence than
//      one source), and countries MetaMask refuses but MoonPay allows (a route the page
//      would be silent about — this was empty when the check was written, and if it ever
//      stops being empty, someone should look). The reverse case, MetaMask allowing what
//      MoonPay refuses, is normal and expected: MetaMask aggregates several providers.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'region-data.js');
const CHECK = process.argv.includes('--check');

// A real browser UA: Transak's edge is behind Cloudflare and 403s a bare fetch.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    let status = 0;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } });
      status = res.status;
      if (res.ok) return await res.json();
      throw new Error(`HTTP ${status}`);
    } catch (err) {
      if (attempt >= tries) throw new Error(`${url} — ${err.message}`);
      // MetaMask rate-limits the per-country pass hard, so a 429 waits properly rather
      // than burning its retries in four seconds.
      await sleep(status === 429 ? attempt * 5000 : attempt * 1200);
    }
  }
}

// Transak's payment-option ids to the rail ids the page has words for
// (gm.geo.rail.* in locales/en.json). An id missing here is dropped and reported, so a new
// payment method can never print a raw "pm_something" at a member.
const TRANSAK_RAILS = {
  credit_debit_card: 'card', debit_card: 'debit', apple_pay: 'apple_pay', google_pay: 'google_pay',
  pm_apple_pay: 'apple_pay', pm_google_pay: 'google_pay',
  sepa_bank_transfer: 'sepa', pm_sepa_bank_transfer: 'sepa',
  // "Easy Bank Transfer" is open banking, offered across Europe — not UK Faster Payments.
  pm_open_banking: 'open_banking', pm_wire: 'wire',
  gbp_bank_transfer: 'fps', pm_gbp_bank_transfer: 'fps',
  inr_bank_transfer: 'imps', imps_bank_transfer: 'imps', upi: 'upi', pm_upi: 'upi',
  pix: 'pix', pm_pix: 'pix', pm_spei: 'spei', pm_pse: 'pse',
  pm_us_wire_bank_transfer: 'wire', pm_us_ach_bank_transfer: 'ach', pm_ach: 'ach',
  pm_pay_id: 'payid', pay_id: 'payid', pm_paynow: 'paynow', paynow: 'paynow',
  pm_promptpay: 'promptpay', pm_fpx: 'fpx', pm_blik: 'blik', pm_ideal: 'ideal',
  pm_interac: 'interac', pm_eft: 'eft', pm_paypal: 'paypal', paypal: 'paypal',
  pm_gcash: 'gcash', pm_instapay: 'instapay', pm_qris: 'qris', pm_mpesa: 'mpesa',
  pm_cbu: 'cbu', pm_bank_transfer: 'bank', bank_transfer: 'bank', pm_cash: 'bank',
};

// MetaMask's payout-method ids, from /regions/<cc>/light?action=sell.
const MM_RAILS = {
  '/payments/pix': 'pix',
  '/payments/debit-credit-card': 'card',
  '/payments/credit-debit-card': 'card',
  '/payments/apple-pay': 'apple_pay',
  '/payments/google-pay': 'google_pay',
  '/payments/paypal': 'paypal',
  '/payments/sepa-bank-transfer': 'sepa',
  '/payments/instant-sepa-bank-transfer': 'sepa_instant',
  '/payments/gbp-bank-transfer': 'fps',
  '/payments/faster-payments': 'fps',
  '/payments/ach-bank-transfer': 'ach',
  '/payments/wire-transfer': 'wire',
  '/payments/bank-transfer': 'bank',
  '/payments/instant-bank-transfer': 'bank',
  '/payments/interac': 'interac',
  '/payments/pay-id': 'payid',
  '/payments/payid': 'payid',
  '/payments/upi': 'upi',
  '/payments/imps-bank-transfer': 'imps',
  '/payments/imps': 'imps',
  '/payments/payid-bank-transfer': 'payid',
  '/payments/bpi': 'bpi',
  '/payments/maya': 'maya',
  '/payments/id-bank-transfer': 'bank',
  '/payments/ng-bank-transfer': 'bank',
  '/payments/vn-bank-transfer': 'bank',
  '/payments/try-bank-transfer': 'bank',
  '/payments/rev-pay': 'revolut',
  '/payments/cash-app': 'cashapp',
  '/payments/spei': 'spei',
  '/payments/pse': 'pse',
  '/payments/paynow': 'paynow',
  '/payments/promptpay': 'promptpay',
  '/payments/fpx': 'fpx',
  '/payments/blik': 'blik',
  '/payments/ideal': 'ideal',
  '/payments/gcash': 'gcash',
  '/payments/instapay': 'instapay',
  '/payments/qris': 'qris',
  '/payments/mpesa': 'mpesa',
};

// The four countries no provider's list mentions at all, because comprehensive sanctions
// keep every one of them out. They are added by hand so the picker can still OFFER them:
// a member in Iran is 13% of this club's players, and a country missing from the dropdown
// tells them nothing, where a country that answers "none of these serve you" tells them
// the truth in one tap. Nothing here claims anything about local law.
const SANCTIONED_GAP = { CU: ['Cuba', 'CUP'], IR: ['Iran', 'IRR'], KP: ['North Korea', 'KPW'], SY: ['Syria', 'SYP'] };

// MetaMask's country feed still carries seven currency codes that were redenominated out
// of existence, and Intl names them honestly as historical: "Zimbabwean Dollar (2009–2024)"
// is not a thing to tell someone they will be paid in. These are the ISO 4217 successors.
const STALE_CURRENCY = {
  BYR: 'BYN',   // Belarusian rouble, redenominated 2016
  MRO: 'MRU',   // Mauritanian ouguiya, 2018
  SLL: 'SLE',   // Sierra Leonean leone, 2022
  STD: 'STN',   // Sao Tome and Principe dobra, 2018
  VEF: 'VES',   // Venezuelan bolivar, 2018
  ZMK: 'ZMW',   // Zambian kwacha, 2013
  ZWL: 'ZWG',   // Zimbabwe Gold, 2024
};

const unmapped = new Set();

function iso2FromRegionId(id) {
  // "/regions/br" → "BR"; "/regions/us-ny" → null (a state, handled separately)
  const m = /^\/regions\/([a-z]{2})$/.exec(String(id || ''));
  return m ? m[1].toUpperCase() : null;
}
function stateCode(id) {
  const m = /^\/regions\/us-([a-z]{2})$/.exec(String(id || ''));
  return m ? m[1].toUpperCase() : null;
}

const MM_QS = 'sdk=2.1.13&context=browser&keys=';

// Run `jobs` a few at a time. 219 sequential round trips take minutes; hammering someone
// else's API with 219 at once is rude and gets the build rate-limited.
async function pooled(jobs, size = 3) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (i < jobs.length) { out.push(await jobs[i++]()); await sleep(180); }
  }));
  return out;
}

async function fetchMetaMask() {
  const rows = await getJson(`https://on-ramp-cache.api.cx.metamask.io/regions/countries?${MM_QS}`);
  const list = Array.isArray(rows) ? rows : rows.data;
  if (!Array.isArray(list) || list.length < 100) throw new Error('MetaMask: unexpected shape');
  const countries = new Map();
  const states = new Map();
  for (const r of list) {
    const iso = iso2FromRegionId(r.id);
    if (!iso) continue;
    const sup = r.support || {};
    countries.set(iso, {
      buy: !!sup.buy && !r.unsupported,
      sell: !!sup.sell && !r.unsupported,
      currency: (r.currencies || [])[0]?.split('/').pop()?.toUpperCase() || null,
      name: r.name || iso,
      rails: [],
    });
    if (iso === 'US' && Array.isArray(r.states)) {
      for (const st of r.states) {
        const code = stateCode(st.id);
        if (!code) continue;
        const ss = st.support || {};
        states.set(code, { n: st.name || code, buy: !!ss.buy && !st.unsupported, sell: !!ss.sell && !st.unsupported, rails: [] });
      }
    }
  }
  if (!countries.size) throw new Error('MetaMask: no countries parsed');
  // Nobody sells anywhere is the signature of asking the wrong host (see the note up top).
  if (![...countries.values()].some(c => c.sell)) throw new Error('MetaMask: every country came back unsupported — wrong host or query');

  // Second pass: what each country actually pays out over. Sell side only, since the
  // funding section leads with our own card rather than with MetaMask.
  // What the last run learned. A 429 mid-pass must cost us nothing: rails we already have
  // stay, and each run fills more of the gaps.
  let previous = {}, previousStates = {};
  try {
    const { pathToFileURL } = await import('node:url');
    ({ COUNTRIES: previous = {}, US_STATES: previousStates = {} } = await import(pathToFileURL(OUT).href));
  } catch {}

  // --no-rails keeps whatever the last run learned rather than throwing it away: the flag
  // is for iterating on the coverage lists, not for emptying the file.
  if (process.argv.includes('--no-rails')) {
    for (const [iso, c] of countries) if (previous[iso]?.mmRails) c.rails = previous[iso].mmRails;
    for (const [code, st] of states) if (previousStates[code]?.mmRails) st.rails = previousStates[code].mmRails;
  } else {
    // Countries that can sell, plus the United States and every state of it that can.
    // The US answers at country level even though it reports itself unsupported, and its
    // states differ from each other (Texas gets a card and ACH, New York gets nothing at
    // all), so the picker asks for a state and the row prefers that state's own answer.
    const targets = [
      ...[...countries].filter(([, c]) => c.sell)
        .map(([iso]) => ({ region: iso.toLowerCase(), set: r => (countries.get(iso).rails = r), had: previous[iso]?.mmRails })),
      ...(countries.has('US') ? [{ region: 'us', set: r => (countries.get('US').rails = r), had: previous.US?.mmRails }] : []),
      ...[...states].filter(([, st]) => st.sell)
        .map(([code, st]) => ({ region: `us-${code.toLowerCase()}`, set: r => (st.rails = r), had: previousStates[code]?.mmRails })),
    ];
    let done = 0;
    await pooled(targets.map(target => async () => {
      const url = `https://on-ramp-cache.api.cx.metamask.io/regions/${target.region}/light?${MM_QS}&payment=&action=sell&multiplePayments=true`;
      try {
        const j = await getJson(url);
        const rails = [];
        for (const p of j.payments || []) {
          const rail = MM_RAILS[p.id];
          if (!rail) { unmapped.add(`metamask:${p.id} (${p.name})`); continue; }
          if (!rails.includes(rail)) rails.push(rail);
        }
        target.set(rails.length ? rails.slice(0, 3) : (target.had || []));
      } catch (err) {
        // One region's rails are a nicety; the page falls back to "its first screen lists
        // the payout methods". Losing the whole build over it would not be.
        if (target.had) target.set(target.had);
        console.warn(`  rails for ${target.region}: ${err.message}${target.had ? ' (kept previous)' : ''}`);
      }
      if (++done % 60 === 0) console.log(`  …rails ${done}/${targets.length}`);
    }));
  }
  return { countries, states };
}

// Cloudflare 403s node's fetch on api.transak.com whatever headers it carries, so these
// two run inside real Chromium, from a page on Transak's own widget origin.
async function transakViaBrowser(urls) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { throw new Error('Transak needs playwright (npm i -D playwright) — Cloudflare blocks a plain fetch'); }
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ userAgent: UA })).newPage();
    await page.goto('https://global.transak.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const out = [];
    for (const url of urls) {
      const r = await page.evaluate(async u => {
        const res = await fetch(u, { headers: { accept: 'application/json' } });
        return { status: res.status, body: await res.text() };
      }, url);
      if (r.status !== 200) throw new Error(`${url} — HTTP ${r.status}`);
      out.push(JSON.parse(r.body));
    }
    return out;
  } finally { await browser.close(); }
}

// Binance's own signup dropdown. A country absent from it cannot open an account, which
// is the one thing about Binance that is both public and decisive.
async function fetchBinance() {
  const res = await getJson('https://accounts.binance.com/bapi/accounts/v1/public/country/list');
  const rows = res.data || res;
  if (!Array.isArray(rows) || rows.length < 100) throw new Error('Binance: unexpected shape');
  const out = new Set();
  for (const r of rows) {
    const iso = String(r.code || '').toUpperCase();
    if (iso.length === 2) out.add(iso);
  }
  if (out.has('US')) throw new Error('Binance: US present in the signup list — the feed changed, re-read it');
  return out;
}

// MoonPay's public country list. Cross-check only — never written to the page.
async function fetchMoonPay() {
  const rows = await getJson('https://api.moonpay.com/v3/countries');
  if (!Array.isArray(rows) || rows.length < 100) throw new Error('MoonPay: unexpected shape');
  const out = new Map();
  for (const r of rows) {
    const iso = String(r.alpha2 || '').toUpperCase();
    if (iso.length !== 2) continue;
    out.set(iso, {
      buy: !!r.isBuyAllowed && !!r.isAllowed,
      sell: !!r.isSellAllowed && !!r.isAllowed,
      states: (r.states || []).reduce((m, st) => (m[st.code] = !!st.isSellAllowed, m), {}),
    });
  }
  return out;
}

async function fetchTransak() {
  const [cRes, fRes] = await transakViaBrowser([
    'https://api.transak.com/api/v2/countries',
    'https://api.transak.com/api/v2/currencies/fiat-currencies',
  ]);
  const cRows = cRes.response || cRes;
  const fRows = fRes.response || fRes;
  if (!Array.isArray(cRows) || !cRows.length) throw new Error('Transak: unexpected countries shape');
  if (!Array.isArray(fRows) || fRows.length < 10) throw new Error('Transak: unexpected fiat shape');

  // Coverage, currency and payment methods per territory, from the currencies themselves.
  // A currency lists the countries it covers, so this is the union we can stand behind.
  const out = new Map();
  for (const f of fRows) {
    if (f.isAllowed === false) continue;
    const rails = [];
    for (const opt of f.paymentOptions || []) {
      if (opt.isActive === false) continue;
      const rail = TRANSAK_RAILS[opt.id];
      if (!rail) { unmapped.add(`transak:${opt.id} (${opt.name})`); continue; }
      if (!rails.includes(rail)) rails.push(rail);
    }
    for (const raw of f.supportingCountries || []) {
      const iso = String(raw).toUpperCase();
      if (iso.length !== 2) continue;              // the feed carries a stray "NOK"
      if (!out.has(iso)) out.set(iso, { ok: 1, cur: f.symbol, pay: rails.slice(0, 4) });
    }
  }
  // The document overlay: an explicit isAllowed:false here blocks a country outright.
  for (const c of cRows) {
    const iso = String(c.alpha2 || '').toUpperCase();
    if (iso.length !== 2) continue;
    if (c.isAllowed === false) out.set(iso, { ok: 0, cur: c.currencyCode || null, pay: [] });
    else if (out.has(iso) && c.currencyCode) out.get(iso).cur = c.currencyCode;
  }
  return out;
}


// ---------- build ----------

const [mm, tx, bn, mp] = await Promise.all([fetchMetaMask(), fetchTransak(), fetchBinance(), fetchMoonPay()]);

const codes = [...new Set([...mm.countries.keys(), ...tx.keys(), ...bn, ...Object.keys(SANCTIONED_GAP)])].sort();
const countries = {};
for (const iso of codes) {
  const m = mm.countries.get(iso);
  const t = tx.get(iso);
  const gap = SANCTIONED_GAP[iso];
  const entry = {
    n: (m && m.name) || (gap && gap[0]) || iso,    // English fallback; Intl names it at runtime
    cur: (() => { const cur = (m && m.currency) || (t && t.cur) || (gap && gap[1]) || 'USD'; return STALE_CURRENCY[cur] || cur; })(),
    mm: [m && m.buy ? 1 : 0, m && m.sell ? 1 : 0], // [buy, sell]
  };
  if (m && m.rails && m.rails.length) entry.mmRails = m.rails;
  entry.bn = bn.has(iso) ? 1 : 0;   // can you open a Binance account at all
  // MoonPay's own verdict, kept for the cross-check below and for whoever edits next.
  // The page never reads it.
  const p = mp.get(iso);
  if (p) entry.mp = [p.buy ? 1 : 0, p.sell ? 1 : 0];
  // No tx key at all = Transak's own feeds don't cover it either way, and the page says
  // so rather than claiming the card is unavailable.
  if (t) entry.tx = { ok: t.ok ? 1 : 0, pay: t.pay };
  countries[iso] = entry;
}

const states = {};
for (const [code, st] of [...mm.states].sort((a, b) => a[0].localeCompare(b[0]))) {
  states[code] = { n: st.n, mm: [st.buy ? 1 : 0, st.sell ? 1 : 0] };
  if (st.rails && st.rails.length) states[code].mmRails = st.rails;
}

const date = new Date().toISOString().slice(0, 10);
const sellable = [...mm.countries.values()].filter(c => c.sell).length;
const noSellStates = Object.entries(states).filter(([, s]) => !s.mm[1]).map(([c]) => c);

const body = `// GENERATED by scripts/build-region-data.mjs on ${date} — do not hand-edit.
// Coverage read from each provider's own public API. Re-run the script to refresh; the
// hand-checked venues and notes live beside this in js/region-curated.js.
//
// Per country: n = English name (Intl renames it at runtime), cur = its currency,
// mm = MetaMask [buy, sell], mmRails = what it pays out over there,
// tx = our card on-ramp { ok, pay: [rail ids] } — ABSENT means unconfirmed, not "no",
// bn = 1 when Binance will open an account there (its signup list; says nothing about rails),
// mp = MoonPay's own [buy, sell] — a cross-check for whoever edits next; the page never reads it.
// US states carry MetaMask's own per-state block, which the picker asks for.
// Cuba, Iran, North Korea and Syria appear in no provider list at all and are added by the
// script with mm [0,0], so the picker can offer them and answer honestly.
//
// This run: ${codes.length} countries, ${sellable} of them can sell through MetaMask,
// ${Object.keys(states).length} US entries of which ${noSellStates.length} cannot sell (${noSellStates.join(', ') || 'none'}).
export const CHECKED = { date: '${date}' };

export const COUNTRIES = {
${Object.entries(countries).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`).join('\n')}
};

export const US_STATES = {
${Object.entries(states).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`).join('\n')}
};
`;

if (unmapped.size) {
  console.warn('Payment ids with no rail word (dropped, add a gm.geo.rail.* key and map them):');
  for (const id of [...unmapped].sort()) console.warn('  ' + id);
}

let before = '';
try { before = await readFile(OUT, 'utf8'); } catch {}
if (CHECK) {
  console.log(before === body ? 'no change' : `would rewrite ${OUT}`);
} else {
  await writeFile(OUT, body);
  console.log(`wrote ${OUT}`);
}
console.log(`countries ${codes.length} | Binance signup ${bn.size} | MetaMask sell ${sellable} | Transak confirmed ${[...tx.values()].filter(t => t.ok).length}, blocked ${[...tx.values()].filter(t => !t.ok).length}, rest unconfirmed`);
console.log(`US states without MetaMask sell: ${noSellStates.join(', ') || 'none'}`);
// The cross-check. Two providers disagreeing is not an error, but one of the two
// directions is worth a human eye, and agreement on a dead end is worth recording.
{
  const bothNo = [], mmNoMpYes = [];
  for (const c of codes) {
    const e = countries[c];
    if (!e.mp) continue;
    if (!e.mm[1] && !e.mp[1]) bothNo.push(c);
    if (!e.mm[1] && e.mp[1] && c !== 'US') mmNoMpYes.push(c);   // US answers on its states
  }
  console.log(`
Cross-check against MoonPay (${mp.size} countries):`);
  console.log(`  Corroborated dead ends, neither will sell (${bothNo.length}): ${bothNo.join(' ')}`);
  if (mmNoMpYes.length) {
    console.log(`  !! MoonPay sells where MetaMask won't (${mmNoMpYes.length}): ${mmNoMpYes.join(' ')}`);
    console.log('     The page is silent about a route that exists. Worth a look before the next release.');
  } else {
    console.log('  MoonPay sells nowhere MetaMask refuses, so the page is not missing a route.');
  }
  const usMp = mp.get('US');
  if (usMp) {
    const mmBlocked = Object.entries(states).filter(([, st]) => !st.mm[1]).map(([k]) => k).sort();
    const mpBlocked = Object.entries(usMp.states).filter(([, ok]) => !ok).map(([k]) => k).sort();
    console.log(`  US states: MetaMask blocks ${mmBlocked.join(' ') || 'none'} | MoonPay blocks ${mpBlocked.join(' ') || 'none'}`);
  }
}

const missingRails = codes.filter(c => countries[c].mm[1] && !countries[c].mmRails);
if (missingRails.length) console.log(`Sell countries still missing payout rails (${missingRails.length}): ${missingRails.join(' ')}
  Re-run to fill them; the page falls back to "its first screen lists the payout methods".`);
