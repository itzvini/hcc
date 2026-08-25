const SUPPORTED_LANGS = ['en', 'pt', 'es', 'ru', 'fr', 'de', 'tr'];
let translations = {};
let fallback = {};        // English, used for any key missing in the active language
let currentLang = 'en';

export function getCurrentLang() { return currentLang; }

export function t(key) {
  return translations[key] ?? fallback[key] ?? key;
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
  // Plain numbers group differently per language (11,111 vs 11.111). The count-up in
  // app.js formats while it animates; this catches the settled value on load, on every
  // language switch, and under reduced motion, where nothing animates at all.
  document.querySelectorAll('[data-countup]').forEach(el => {
    const n = Number(el.dataset.countup);
    if (Number.isFinite(n)) el.textContent = n.toLocaleString(currentLang);
  });
}

export async function setLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = 'en';
  // Ensure the English fallback dictionary is loaded for any untranslated keys
  if (!Object.keys(fallback).length) {
    try { fallback = await loadLocale('en'); } catch {}
  }
  try {
    translations = lang === 'en' ? fallback : await loadLocale(lang);
  } catch {
    if (lang !== 'en') { await setLanguage('en'); return; }
  }
  currentLang = lang;
  // Storage throws when the browser blocks it (Safari private browsing, "block all
  // cookies"). Losing the saved preference is a small cost; letting it throw here cost
  // the whole switch, because every visible change below was skipped — the page stayed
  // in the old language and the click looked like it had done nothing.
  try { localStorage.setItem('hcc-lang', lang); } catch {}
  document.documentElement.lang = lang;
  applyTranslations();
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.lang === lang);
  });
  const langCur = document.getElementById('lang-current');
  if (langCur) langCur.textContent = lang.toUpperCase();
}

export async function initI18n() {
  let saved = null;
  try { saved = localStorage.getItem('hcc-lang'); } catch {}
  const browser = (navigator.language || '').split('-')[0];
  const lang    = saved || (SUPPORTED_LANGS.includes(browser) ? browser : 'en');
  await setLanguage(lang);
}
