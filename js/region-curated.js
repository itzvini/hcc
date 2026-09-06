// Hand-checked facts for the country picker in the Funding and Cash out guides
// (js/region-pick.js). This file is the part a person maintains; the coverage lists that
// come from the providers' own APIs live in the GENERATED js/region-data.js.
//
// Rules for an edit:
//   - Every fact here was read on the company's own site or on a regulator's register, on
//     the date in LOCALS_CHECKED. Re-check before you change anything: never adjust from
//     memory, and never soften a "no" you haven't re-read.
//   - Leave a country out rather than guess. An absent country still gets an honest
//     answer, because every row falls back to "we couldn't confirm this"; a wrong entry
//     sends someone's money the wrong way, and this page is read by people cashing out
//     their first four figures.
//   - Rail ids map to gm.geo.rail.* in locales/en.json. Add the key before the id.
//   - Notes are i18n keys gm.geo.note.<CC>.<n>, written in locales/en.json.
//
// Shape per country, all fields optional:
//   cb:  { acct: 1|0, cash: 1|0, buy: 1|0, rails: [...] }  Coinbase. acct = opens accounts,
//        cash = pays local money to a bank there, buy = takes local money in. Omit the
//        country entirely and the page says Coinbase is unconfirmed there, which beats
//        guessing: "opens an account" and "pays your bank" are different answers.
//   kr:  { ok: 0 } to override the served list, { fiat, rails } to override the currency map
//   bn:  { st: 'ok'|'p2p'|'no'|'unk', rails: [...] }  Binance on the site BINANCE.sites picks
//   mm:  { rails: [...] }  only when MetaMask's own feed gives no payout rails
//   loc: [{ n, d, reg, rails, buy, sell, wd, notIn }]  local venues. wd = 0 means it will
//        not let you withdraw ETH to your own wallet, which makes it useless for funding
//        this site. notIn lists US state codes the venue itself rules out.
//   legal: 'sanctioned' | 'restricted', legalNote: an i18n key for the alert line
//   notes / notesCash / notesFund: i18n key suffixes under gm.geo.note.

export const LOCALS_CHECKED = '2026-09-05';

// Kraken, from support.kraken.com "Where is Kraken licensed or regulated?" (its own page,
// last updated 17 August 2026) and the cash deposit and withdrawal tables (same date),
// all read 2026-09-05.
export const KRAKEN = {
  // Kraken's own words: "We do not serve clients, or permit cash and crypto deposits,
  // from the following regions." Crimea, Donetsk and Luhansk are on that list too, which
  // is a region rather than a country and so lives in Ukraine's note instead.
  notServed: ['AF', 'BY', 'CU', 'CD', 'IR', 'IQ', 'JP', 'LY', 'KP', 'RU', 'SD', 'SS', 'SY'],
  usNotServed: ['ME', 'NY'],
  // The nine currencies Kraken will actually pay out, and over what. Everything else means
  // selling into dollars or euros and needing a bank that takes them.
  fiat: {
    USD: ['ach', 'wire'],
    EUR: ['sepa', 'sepa_instant'],
    GBP: ['fps'],
    CAD: ['eft'],
    AUD: ['bank'],
    CHF: ['bank'],
    ARS: ['bank'],
    BRL: ['pix'],
    MXN: ['spei'],
  },
};

// Binance. Which of its legal entities serves a country is the whole question, and its
// terms are not machine-readable, so this list is deliberately short: a country that is
// not named here reads as "Unchecked" on the page rather than as "Works".
export const BINANCE = {
  // Which countries it will open an account for is FETCHED, not listed here — see
  // COUNTRIES[c].bn in the generated file. These are the exceptions that list can't express.
  restricted: [],                    // extra blocks beyond the signup list, if any turn up
  frozen: { GB: '16 October 2023' }, // no new UK customers since; still true 2026-08-29
  // Markets Binance ANNOUNCED it was leaving, which its signup list does not reflect —
  // both of these are still in that dropdown today. That gap is why the generic line
  // below never says "opens accounts here", and why this list exists at all. It is
  // certainly incomplete: add to it whenever an exit is confirmed on Binance's own site.
  //   CA — withdrawal announced 12 May 2023, Canadian accounts liquidation-only from
  //        1 October 2023 (Binance News, binance.com/en/square/post/518437)
  //   NL — "Notice on Changes of Services in the Netherlands", withdrawals only from
  //        17 July 2023 after it failed to get a Dutch VASP registration
  //        (binance.com/en/support/announcement/notice-on-changes-of-services-in-the-netherlands-b5a647be31cf469b87fc3337fd461ced)
  left: { CA: '2023', NL: '2023' },
  // Binance missed the MiCA deadline and suspended service across the whole EEA on
  // 1 July 2026: no new sign-ups, no deposits, no new spot orders, no Earn. Withdrawals
  // and Convert stay open so people already inside can wind down, and Binance calls it a
  // pause rather than an exit. Its signup list still carries every one of these countries.
  //   Announced to users 26 June 2026 after it withdrew its Greek licence application;
  //   reported by AFP (france24.com/en/live-news/20260625-binance-to-suspend-crypto-
  //   services-in-several-eu-countries), Euronews and CoinDesk. Re-check before mid-2027:
  //   Binance says it will reapply, and a licence would put all thirty back.
  // NL also sits in `left` above, which is checked first and wins. Its 2023 exit is the
  // older and stronger fact, so a Dutch reader keeps that line.
  micaDate: '1 July 2026',
  mica: ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
         'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES',
         'SE', 'IS', 'LI', 'NO'],
  // Announced a full exit, but people there still report working accounts, so these read
  // "limited" and not "not here". An outright no would be wrong for anyone already inside.
  //   RU — "Binance Fully Exits Russia With Sale to CommEX", Binance's own blog,
  //        27 September 2023. The buyer, CommEX, shut down in May 2024, and Binance said
  //        in September 2024 it was still serving a limited number of Russian users.
  exiting: { RU: '2023' },
  // Blocked by the country's own regulator rather than by Binance, so the signup list
  // still carries it: the block sits at the reader's end, not Binance's.
  //   PH — the SEC had the app pulled from both stores and the NTC ordered internet
  //        providers to block binance.com, March 2024. Still blocked in 2026. Binance is
  //        talking about a return through the SEC's supervised trial, but nothing is open.
  blocked: { PH: '2024' },
  // Binance.US's own state lists. They cannot be read from outside the United States —
  // every binance.us endpoint 403s from here — so they stay empty and the US note carries
  // the sixteen-state fact in words instead of pretending to know which sixteen.
  usNotServed: [],
  usCryptoOnly: [],
  sites: {
    default: { host: 'www.binance.com', dom: 'binance.com', whenKey: 'gm.paid.go.bn.world' },
    US:      { host: 'www.binance.us',  dom: 'binance.us',  whenKey: 'gm.paid.go.bn.us' },
    TR:      { host: 'www.binance.tr',  dom: 'binance.tr',  whenKey: 'gm.paid.go.bn.tr' },
  },
};

// Transak (the card on our own Add funds page) — US states it does not serve.
export const TRANSAK = { usNotServed: [] };

// Coinbase entries below carry only what a live check has actually established: the
// Brazil, UK, US and Turkey lines come from the 29 August 2026 pass behind the option
// cards above (Pix, Faster Payments, a US bank transfer, and no Turkish lira).
//
// Coinbase is the hardest of the four to keep current and it is worth knowing why before
// you try again: api.coinbase.com/v2/countries now 404s, and help.coinbase.com sits behind
// a Cloudflare bot check that turns away both a plain fetch and headless Chromium (its
// "Prohibited regions" article came through on a patient retry; the supported-countries
// and per-region funding articles did not). So anywhere unlisted reads as unconfirmed on
// the page and sends the reader to Coinbase's own signup, which asks for a country first.
export const CURATED = {
  // ---- Comprehensively sanctioned. No route on this page reaches them, and we do not
  // send anyone to a local workaround. Three of the four rows are read facts: MetaMask's
  // coverage list has no entry for any of these countries; Kraken names all four on its
  // own prohibited list; and Coinbase's "Prohibited regions" page (read 2026-09-05) says
  // it "does not permit access to its website or mobile application in any jurisdiction
  // that is subject to the sanctions programs administered by the U.S. Treasury", though
  // it names no countries itself. Binance's row is the one inference left, and it is the
  // safe direction to be wrong in.
  IR: { legal: 'sanctioned', kr: { ok: 0 }, bn: { st: 'no' }, cb: { acct: 0 }, notes: ['SANCTIONED.1'] },
  CU: { legal: 'sanctioned', kr: { ok: 0 }, bn: { st: 'no' }, cb: { acct: 0 }, notes: ['SANCTIONED.1'] },
  KP: { legal: 'sanctioned', kr: { ok: 0 }, bn: { st: 'no' }, cb: { acct: 0 }, notes: ['SANCTIONED.1'] },
  SY: { legal: 'sanctioned', kr: { ok: 0 }, bn: { st: 'no' }, cb: { acct: 0 }, notes: ['SANCTIONED.1'] },

  // ---- The rest, in user-base order.
  US: {
    cb: { acct: 1, cash: 1, buy: 1, rails: ['ach'] },
    notes: ['US.1', 'US.2', 'US.3'],
    loc: [
      { n: 'Gemini', d: 'www.gemini.com', reg: 'NYDFS trust', rails: ['ach', 'wire', 'debit'], buy: 1, sell: 1, wd: 1 },
      { n: 'Robinhood Crypto', d: 'robinhood.com', reg: 'NYDFS BitLicense', rails: ['ach', 'debit'], buy: 1, sell: 1, wd: 1 },
      // Crypto.com holds state money-transmitter licences but is not on the NYDFS list.
      { n: 'Crypto.com', d: 'crypto.com', reg: 'State MTLs', rails: ['ach', 'wire', 'card'], buy: 1, sell: 1, wd: 1, notIn: ['NY'] },
    ],
  },
  RU: {
    legal: 'restricted', legalNote: 'gm.geo.legal.RU',
    kr: { ok: 0 },
    notes: ['RU.1'],
  },
  TR: {
    cb: { acct: 1, cash: 0, buy: 0 },
    notes: ['TR.1', 'TR.2'],
  },
  IQ: { kr: { ok: 0 }, notes: ['IQ.1'] },
  BR: {
    cb: { acct: 1, cash: 1, buy: 1, rails: ['pix'] },
    notes: ['BR.1', 'BR.2'],
  },
  CA: { notes: ['CA.1', 'CA.2'] },
  IN: {
    notes: ['IN.1', 'IN.2', 'IN.3'],
    loc: [{ n: 'ZebPay', d: 'zebpay.com', reg: 'FIU-IND registered', rails: ['imps'], buy: 1, sell: 1, wd: 1 }],
  },
  ID: {
    notes: ['ID.1', 'ID.2', 'ID.3'],
    loc: [
      { n: 'Indodax', d: 'indodax.com', reg: 'OJK licensed', rails: ['bank', 'qris'], buy: 1, sell: 1, wd: 1 },
      { n: 'Tokocrypto', d: 'tokocrypto.com', reg: 'OJK licensed, Binance-owned', rails: ['bank'], buy: 1, sell: 1, wd: 1 },
      { n: 'Pintu', d: 'pintu.co.id', reg: 'OJK licensed', rails: ['bank'], buy: 1, sell: 1, wd: 1 },
      { n: 'Reku', d: 'reku.id', reg: 'OJK licensed', rails: ['bank', 'qris'], buy: 1, sell: 1, wd: 1 },
    ],
  },
  PH: {
    notes: ['PH.1', 'PH.2', 'PH.3'],
    loc: [
      { n: 'Coins.ph', d: 'coins.ph', reg: 'BSP VASP', rails: ['instapay', 'gcash'], buy: 1, sell: 1, wd: 1 },
      { n: 'PDAX', d: 'pdax.ph', reg: 'BSP VASP', rails: ['instapay', 'gcash'], buy: 1, sell: 1, wd: 1 },
      { n: 'GCrypto, inside GCash', d: 'www.gcash.com', reg: 'run by PDAX', rails: ['gcash'], buy: 1, sell: 1, wd: 1 },
    ],
  },
  EG: { notes: ['EG.1'] },
  GB: {
    cb: { acct: 1, cash: 1, buy: 1, rails: ['fps'] },
    notes: ['GB.1'],
  },
  UA: { notes: ['UA.1'] },
  DZ: { notes: ['DZ.1'] },
  BY: { legal: 'restricted', legalNote: 'gm.geo.legal.RU', kr: { ok: 0 }, notes: ['BY.1'] },
  AU: { notes: ['AU.1'] },
  JP: { kr: { ok: 0 }, notes: ['JP.1'] },
};
