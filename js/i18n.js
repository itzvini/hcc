const SUPPORTED_LANGS = ['en', 'pt', 'es', 'ru', 'fr', 'de', 'tr'];
let translations = {};
let currentLang = 'en';

export function getCurrentLang() { return currentLang; }

export function t(key) {
  return translations[key] || key;
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
  try {
    const res = await fetch(`/locales/${lang}.json`);
    if (!res.ok) throw new Error();
    translations = await res.json();
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
