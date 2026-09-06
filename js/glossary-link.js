import { codexHref } from './entity-url.js';

// Glossary links in running prose: the first mention of a term on a page becomes a link to
// its page, the way a wiki does. Imports nothing but codexHref, so it can be pulled into
// i18n.js without dragging a feature module into the critical path of every other module.
//
// The rule that shapes all of this: a link on the wrong word is worse than no link. Every
// form below was checked against every sentence on the site that contains it.

// The Security guide gets its own rule, because its sentences are about fakes and a link
// on the thing being faked reads as an endorsement of it. Only wallet and chain hygiene is
// welcome there. Everything else was caught doing real damage in draft: "a limited free
// mint" is a scammer's bait rather than our Mint page, "a free Nitro offer" is not a
// marketplace offer at all, and "anything sold as a Gen 2 creature today is fake" must not
// carry a confident link to what Gen 2 is.
const SAFETY = '#panel-guides [data-subpanel="safety"]';
const SAFETY_ALLOWS = new Set(['seed-phrase', 'wallet', 'metamask', 'token-trove',
  'immutable-zkevm', 'ethereum-mainnet', 'bridging', 'gas']);

// `cs` marks a form whose meaning lives in its casing: LAND the parcel against land the
// verb, NFT against nothing at all.
//
// What is absent is absent for a reason, and each reason was a real sentence:
//   release   faq.a6, "its Decides power grows release by release"
//   approval  faq.a5, "canceled following Steam approval"
//   piece     gx.a3, "the Gen 2 piece attaches to the NFT you already hold", which is the
//             entitlement, not the garment inside an Outfit that our Piece page defines
//   estate    guide.scam.t1.how, a warning about "a fake Highrise Estate"
//   slime     rm.ghost.p, a ghost that "dissolved into glowing green slime"
//   cash out  three of its four uses name the button, not the idea
//   Creature  the site's own subject, 81 prose keys. Linking it is what turns a reference
//             into a link farm, and nobody reading this site needs it defined.
const LINKABLE = [
  { slug: 'immutable-zkevm',  form: 'Immutable zkEVM' },
  { slug: 'ethereum-mainnet', form: 'Ethereum mainnet' },
  { slug: 'token-trove',      form: 'Token Trove' },
  { slug: 'player-council',   form: 'Player Council' },
  { slug: 'all-in-price',     form: 'all-in price' },
  { slug: 'rarity-rank',      form: 'rarity rank' },
  { slug: 'seed-phrase',      form: 'seed phrase' },
  { slug: 'metamask',         form: 'MetaMask' },
  { slug: 'bridging',         form: 'bridging' },
  { slug: 'on-ramp',          form: 'on-ramp' },
  { slug: 'wallet',           form: 'wallet' },
  { slug: 'listing',          form: 'listing' },
  { slug: 'offer',            form: 'offer' },
  { slug: 'floor',            form: 'floor' },
  { slug: 'trait',            form: 'trait' },
  { slug: 'mint',             form: 'mint' },
  { slug: 'deed',             form: 'Deed' },
  { slug: 'gas',              form: 'gas' },
  { slug: 'nft',              form: 'NFT',  cs: true },
  { slug: 'land',             form: 'LAND', cs: true },
  { slug: 'creature-coins',   form: 'Creature Coins' },
  { slug: 'creature-store',   form: 'Creature Store' },
  { slug: 'premium-land',     form: 'Premium LAND' },
  { slug: 'gen-2',            form: 'Gen 2' },
  { slug: 'grab',             form: 'grab' },
  { slug: 'drop',             form: 'drop' },
].sort((a, b) => b.form.length - a.form.length);

// Where prose lives, across the whole site. An allowlist, not an
// allow-everything-minus-exceptions: this site is mostly interface, and interface copy
// reads exactly like prose to a regex.
const PROSE = [
  // Section leads, card bodies and FAQ answers, wherever they appear
  'p.lead', '.perk p', 'details > p', '.honest p', '.card.tilt > p', 'p.apply-fineprint',
  // The Club
  '#panel-club .info-card p', '#panel-club p.info-note', '#panel-club .tnode p',
  '#panel-club .faq-body p', '#panel-club p.faq-warn',
  '#panel-club li.faq-venue > span > span[data-i18n]',
  '#panel-club li.faq-venue > span > span[data-i18n-html]',
  // Council
  '#panel-council [data-subpanel="about"] > section.wrap > p[data-i18n]',
  '#panel-council p.cb-foot > span[data-i18n]',
  // Roadmap, the Gen 2 boards and Gen 2 Explained
  '#panel-roadmap p.rm-desc', '#panel-roadmap p.rm-note', '#panel-roadmap .gx-item p',
  '#panel-roadmap .gx-open-row > span > span[data-i18n]', '#panel-roadmap p.gx-swap-note',
  '#panel-roadmap p.gx-source', '#panel-roadmap .gx-warn p', '#panel-roadmap .gx-swap-side p',
  '#panel-roadmap .g2-stage p', 'p.perx-hero-p',
  // Guides
  'p.guide-intro', 'p.guide-note', 'div.guide-note', 'ol.guide-steps > li',
  '.wt-mkt > p.wt-mkt-where', '.wt-mkt > p.guide-note', '#panel-guides .gm-calm-card p',
  // Cash out, leg 2. Only the always-visible blocks: decorateElement skips anything with
  // no client rects, so the collapsed region <details> would come back half-linked.
  '#panel-guides p.gm-paid-lead', '#panel-guides p.gm-paid-note',
  '#panel-guides .gm-pick-p', '#panel-guides .gm-opt-what', '#panel-guides .gm-rule-t p',
  // The country picker's answer, rendered by region-pick.js, which calls the linker itself.
  '#panel-guides .gm-geo-verdict p', '#panel-guides .gm-geo-notes li',
  // Security, filtered to chain hygiene by SAFETY_ALLOWS above
  '#panel-guides .scam-block p', '#panel-guides .scam-block li',
  '#panel-guides .scam-flow-t p', '#panel-guides .scam-rule-t p',
  '#panel-guides p.scam-hero-p', '#panel-guides p.scam-er-note',
  '#panel-guides .scam-er-steps p',
  // Perks
  '#panel-perks .perx-card p', '#panel-perks .perx-step p', '#panel-perks .perx-req p',
  // Codex prose: a release note and a Creature's own description. Term pages link their
  // own bodies at render time in codex.js, so they are not listed here.
  '#codex-view .cdx-prose p',
].join(', ');

// Never decorate inside these, whatever the allowlist says. An <a> inside an <a>, a
// <button> or a <summary> is invalid HTML: it steals the click, breaks the control and
// makes a screen reader announce a link inside a button. 103 of the site's translated
// elements sit inside one of those three, and one of them is the landing page's Data card,
// whose text is "Floor prices, sale history, and who holds what."
const FORBIDDEN = 'a, button, summary, label, code, kbd, h1, h2, h3, h4, [data-no-gloss]';

// Whole regions where a glossary word is a control label, somebody else's words, or a
// contract. The marketplace alone is 500KB of buy and sell UI in which Floor, Listing,
// Offer, Mint and Gas are all buttons.
const OFF_LIMITS = [
  '#trade-app', '#market-content', '#collections-app', '#traits-app', '#holders-chart-wrap',
  '#ballot-app', '#vote-app', '#apply-app', '#election-board', '#polls-app',
  '#announcements-app', '.gdemo', '.legal-body', '.changelog-grid', 'a.cdx-gloss-row',
].join(', ');

const MAX_PER_ELEMENT = 3;

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A word-boundary match that also accepts a trailing plural, so "listing" catches
// "listings" without "Gen 2" ever matching inside "Gen 20" or "land" inside "landing".
function formPattern(form, caseSensitive) {
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}-])(${escaped}s?)(?![\\p{L}\\p{N}-])`,
    caseSensitive ? 'u' : 'iu');
}

const PATTERNS = LINKABLE.map(term => ({ ...term, pattern: formPattern(term.form, term.cs) }));

function anchor(slug, text) {
  return `<a class="gloss-link" href="${codexHref('term', slug)}">${escapeAttr(text)}</a>`;
}

// Decorate one element in place. Works on text nodes only and never re-parses the
// element's own HTML, so existing markup inside it survives untouched.
function decorateElement(el, used) {
  // Already done. There is no separate flag, on purpose: applyTranslations resets these
  // elements to plain textContent, which takes the anchors with it, and the absence of an
  // anchor is then exactly the signal that the work needs doing again.
  if (el.querySelector('a.gloss-link')) return 0;
  if (el.closest(OFF_LIMITS)) return 0;
  // Text nobody can see must not eat the first mention. Five walkthrough lines carrying
  // "Immutable zkEVM" are display:none at every width (.gm-card .wt-mkt-where).
  if (!el.getClientRects().length) return 0;

  let placed = 0;
  const inSafety = !!el.closest(SAFETY);

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(FORBIDDEN)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);

  for (const node of nodes) {
    if (placed >= MAX_PER_ELEMENT) break;
    for (const term of PATTERNS) {
      if (used.has(term.slug) || placed >= MAX_PER_ELEMENT) continue;
      if (inSafety && !SAFETY_ALLOWS.has(term.slug)) continue;
      const match = term.pattern.exec(node.nodeValue);
      if (!match) continue;
      // Split the text node around the match and drop a real anchor between the halves.
      const start = match.index + match[1].length;
      const tail = node.splitText(start);
      tail.nodeValue = tail.nodeValue.slice(match[2].length);
      const link = document.createElement('a');
      link.className = 'gloss-link';
      link.href = codexHref('term', term.slug);
      link.textContent = match[2];
      tail.parentNode.insertBefore(link, tail);
      used.add(term.slug);
      placed++;
      break;   // one term per text node keeps a sentence from filling up with links
    }
  }
  return placed;
}

// Decorate every prose block under `root`. Safe to call as often as you like: an element
// that already carries a glossary link is left alone, and a term already linked on a page
// is not linked again.
//
// "First mention" is counted per page, not per paragraph. Per paragraph, the Gen 2
// Explained page linked the words "Gen 2" six times, which is the link farm this was meant
// to avoid, on the one page where the reader plainly already knows the term.
export function linkGlossaryTerms(root = document) {
  const scope = root && root.querySelectorAll ? root : document;
  const perPage = new Map();
  let placed = 0;
  scope.querySelectorAll(PROSE).forEach(el => {
    // A sub-panel is a page to the reader: Guides holds five of them behind one tab, and
    // counting them as one meant a term spent on Walkthroughs went missing on Marketplace.
    const page = el.closest('[data-subpanel]') || el.closest('.tab-panel') || document.body;
    let used = perPage.get(page);
    if (!used) {
      // Seed from what is already linked here, so calling this again after a tab switch
      // tops up the page rather than doubling up on it.
      used = new Set([...page.querySelectorAll('a.gloss-link')]
        .map(a => a.getAttribute('href').split('/').pop()));
      perPage.set(page, used);
    }
    placed += decorateElement(el, used);
  });
  return placed;
}

// The string form, for HTML that modules build themselves. Takes text that is ALREADY
// escaped and returns it with anchors woven in. `phrases` is [[slug, text], …]; the caller
// supplies them because it owns the translations, which keeps this file free of any i18n
// import and out of the cycle that would create.
// `seen`, when passed, is a set of slugs already linked elsewhere on the same page. It is
// read and added to, which turns a run of separate calls into one page obeying the same
// first-mention rule the prose linker follows: a reader needs the link once, not in every
// paragraph that happens to say Creature.
export function linkPhrasesInHtml(escapedText, phrases, { skip = null, max = 2, seen = null } = {}) {
  const text = String(escapedText);
  const skipped = new Set(Array.isArray(skip) ? skip : skip ? [skip] : []);
  if (seen) for (const slug of seen) skipped.add(slug);

  // Every candidate is found against the ORIGINAL text, and the whole set is resolved
  // before a single anchor is written. Rewriting as you go looks simpler and is wrong: the
  // anchor for "Premium LAND" puts the word LAND back into the string, the next pattern
  // matches inside it, and the parser silently repairs the illegal nested <a> by splitting
  // it. What you get is an empty link followed by a stray one, which is exactly what this
  // produced before.
  const found = [];
  for (const [slug, form] of phrases) {
    if (!form || skipped.has(slug)) continue;
    const match = formPattern(form, false).exec(text);
    if (!match) continue;
    const start = match.index + match[1].length;
    found.push({ slug, start, end: start + match[2].length, text: match[2] });
  }

  // Earliest wins, and the longer phrase wins a tie, so "Creature Coins" beats the
  // "Creature" sitting at the same index. Then take only what does not overlap.
  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const taken = [];
  const used = new Set();
  let reach = -1;
  for (const hit of found) {
    if (taken.length >= max) break;
    if (hit.start < reach || used.has(hit.slug)) continue;
    taken.push(hit);
    used.add(hit.slug);
    reach = hit.end;
  }

  if (seen) for (const hit of taken) seen.add(hit.slug);

  // Splice from the end so the earlier offsets stay valid.
  let out = text;
  for (let i = taken.length - 1; i >= 0; i--) {
    const hit = taken[i];
    out = out.slice(0, hit.start) + anchor(hit.slug, hit.text) + out.slice(hit.end);
  }
  return out;
}
