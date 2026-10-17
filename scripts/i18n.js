// Tiny i18n: t('key') for UI strings, tr({fr,en}) for bilingual config values.
const strings = {};
let lang = 'fr';

export async function initI18n(defaultLang) {
  let saved = null;
  try { saved = localStorage.getItem('metis.lang'); } catch {}
  lang = saved || defaultLang || 'fr';
  // Always revalidate (cheap 304 when unchanged): a stale translation file next to new code shows raw keys after an update.
  for (const l of ['fr', 'en']) strings[l] = await (await fetch(`i18n/${l}.json`, { cache: 'no-cache' })).json();
  document.documentElement.lang = lang;
}

export const getLang = () => lang;
export function setLang(l) {
  lang = l;
  try { localStorage.setItem('metis.lang', l); } catch {}
  document.documentElement.lang = l;
}
export const t = key => strings[lang]?.[key] ?? strings.en?.[key] ?? key;
export const tr = v => (v && typeof v === 'object' ? v[lang] ?? v.en ?? v.fr ?? '' : v ?? '');

// Fill every [data-i18n] element (text) and [data-i18n-ph] (placeholder).
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => (el.textContent = t(el.dataset.i18n)));
  root.querySelectorAll('[data-i18n-ph]').forEach(el => (el.placeholder = t(el.dataset.i18nPh)));
}
