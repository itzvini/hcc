const SUPPORTED_LANGS = ['en', 'pt', 'es', 'ru', 'fr', 'de', 'tr'];
// Only a language you picked from the switcher is saved, and under this key. The old
// key held more than picks: every first visit saved the browser's language there, and
// from 22 July to 24 August 2026 the closed phone menu left the language row live but
// invisible over mid-screen. A tap on a poll option or a filter switched the site,
// mostly to Spanish or Russian (the middle pills), and saved it for good. Nothing told
// those values from real picks, so initI18n() reads the old key once and drops it.
const LANG_KEY = 'hcc-lang-pick';
const OLD_LANG_KEY = 'hcc-lang';
let translations = {};
let fallback = {};        // English, used for any key missing in the active language
let currentLang = 'en';

export function getCurrentLang() { return currentLang; }

// The glossary decorator, loaded on its own and allowed to fail. One request, cached,
// and if it never arrives the page is simply a page without glossary links.
let linkerPromise = null;
function glossaryLinker() {
  if (!linkerPromise) {
    linkerPromise = import('./glossary-link.js')
      .then(mod => mod.linkGlossaryTerms)
      .catch(error => {
        console.error('[i18n] glossary-link.js did not load — prose keeps its plain words.', error);
        return null;
      });
  }
  return linkerPromise;
}

export function t(key) {
  return translations[key] ?? fallback[key] ?? key;
}

// Does the ACTIVE language really carry this key, or is t() about to hand back English?
// A view that formats its own names, dates or lists through Intl needs to know: formatting
// them in the reader's language while the sentence around them falls back to English
// produces a line in two languages. Ask about one key from the family you're rendering.
export function hasTranslation(key) {
  return key in translations;
}

async function loadLocale(lang) {
  const res = await fetch(`/locales/${lang}.json`);
  if (!res.ok) throw new Error();
  return res.json();
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  // Attribute translations — the hardcoded attribute stays as the pre-init fallback.
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', t(el.dataset.i18nTitle));
  });
  document.querySelectorAll('[data-i18n-alt]').forEach(el => {
    el.setAttribute('alt', t(el.dataset.i18nAlt));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  });
  // Glossary links go in HERE, not in app.js's re-render lists, because the loop above
  // has just reset every translated element to plain textContent and taken any existing
  // anchors with it. Decorating anywhere else means the links are silently gone for
  // anyone who has touched the language switcher, with nothing erroring to say so.
  //
  // Fetched rather than imported: this module is the one thing every other module waits
  // on, and a decoration must never be able to take the site's translations down with it.
  glossaryLinker().then(link => link && link(document)).catch(() => {});
  // Plain numbers group differently per language (11,111 vs 11.111). The count-up in
  // app.js formats while it animates; this catches the settled value on load, on every
  // language switch, and under reduced motion, where nothing animates at all.
  document.querySelectorAll('[data-countup]').forEach(el => {
    const n = Number(el.dataset.countup);
    if (Number.isFinite(n)) el.textContent = n.toLocaleString(currentLang);
  });
}

// `save` is for a pick from the switcher. The language chosen on load, and English
// standing in for a locale that failed to load, are not choices, and saving them
// would stop the next visit from asking the browser (or retrying the locale).
export async function setLanguage(lang, { save = true } = {}) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = 'en';
  // Ensure the English fallback dictionary is loaded for any untranslated keys
  if (!Object.keys(fallback).length) {
    try { fallback = await loadLocale('en'); } catch {}
  }
  try {
    translations = lang === 'en' ? fallback : await loadLocale(lang);
  } catch {
    if (lang !== 'en') { await setLanguage('en', { save: false }); return; }
  }
  currentLang = lang;
  // Storage throws when the browser blocks it (Safari private browsing, "block all
  // cookies"). Losing the saved preference is a small cost; letting it throw here cost
  // the whole switch, because every visible change below was skipped — the page stayed
  // in the old language and the click looked like it had done nothing.
  if (save) { try { localStorage.setItem(LANG_KEY, lang); } catch {} }
  document.documentElement.lang = lang;
  applyTranslations();
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.lang === lang);
  });
  const langCur = document.getElementById('lang-current');
  if (langCur) langCur.textContent = lang.toUpperCase();
}

export async function initI18n() {
  const browser = (navigator.language || '').split('-')[0].toLowerCase();
  let saved = null;
  try {
    saved = localStorage.getItem(LANG_KEY);
    const old = localStorage.getItem(OLD_LANG_KEY);
    if (old !== null) {
      localStorage.removeItem(OLD_LANG_KEY);
      // An old value survives only where it can't strand anyone: English, which the
      // whole community reads, or a language the browser itself lists. Anything else
      // may be a stray tap, and costs a real picker one tap to set again.
      const listed = (navigator.languages?.length ? navigator.languages : [navigator.language || ''])
        .map(l => String(l).split('-')[0].toLowerCase());
      if (!saved && SUPPORTED_LANGS.includes(old) && (old === 'en' || listed.includes(old))) {
        saved = old;
        localStorage.setItem(LANG_KEY, old);
      }
    }
  } catch {}
  const lang = saved || (SUPPORTED_LANGS.includes(browser) ? browser : 'en');
  await setLanguage(lang, { save: false });
}
