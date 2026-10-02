// Interface language. The source texts are the Spanish ones, written as they are in the code;
// tr() returns the translation for the chosen language, or the Spanish text if there isn't one.
// Variables go as {name}: tr('{n} canciones', { n: 12 }). (Named tr because t is a track all over the code.)
// The language is read synchronously (a copy kept in localStorage) so that lists built when the
// modules load (sidebar items, presets…) come out translated too; changing it reloads the window.
import EN from './i18n/en.js';

const DICTS = { en: EN };
export const LANGUAGES = [['es', 'Español'], ['en', 'English']];

let lang = (() => { try { return JSON.parse(localStorage.getItem('bc.uiLang')) || 'es'; } catch { return 'es'; } })();
if (!(lang in DICTS) && lang !== 'es') lang = 'es';
document.documentElement.lang = lang;

export const uiLang = () => lang;
/** Locale for numbers and dates (decimal comma or point…). */
export const locale = () => (lang === 'en' ? 'en-US' : 'es-ES');

export function tr(s, vars) {
  let out = (lang !== 'es' && DICTS[lang]?.[s]) || s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}

/** Keeps the synchronous copy in step with the saved setting; true if it changed (reload). */
export function syncUiLang(saved) {
  const want = saved && (saved === 'es' || saved in DICTS) ? saved : 'es';
  if (want === lang) return false;
  try { localStorage.setItem('bc.uiLang', JSON.stringify(want)); } catch {}
  return true;
}

/** Texts written in index.html: titles, placeholders and elements marked with data-i18n. */
export function translateStatic(root = document) {
  if (lang === 'es') return;
  for (const el of root.querySelectorAll('[title]')) el.title = tr(el.title);
  for (const el of root.querySelectorAll('[placeholder]')) el.placeholder = tr(el.placeholder);
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = tr(el.textContent.trim());
}
