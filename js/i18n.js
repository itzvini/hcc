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
  localStorage.setItem('hcc-lang', lang);
  document.documentElement.lang = lang;
  applyTranslations();
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.lang === lang);
  });
}

export async function initI18n() {
  const saved   = localStorage.getItem('hcc-lang');
  const browser = (navigator.language || '').split('-')[0];
  const lang    = saved || (SUPPORTED_LANGS.includes(browser) ? browser : 'en');
  await setLanguage(lang);
}
