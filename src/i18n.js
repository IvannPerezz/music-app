// Interface language on the main-process side (tray menu, taskbar buttons, dialogs and the error
// messages the window shows). Same dictionary and rules as renderer/i18n.js: the Spanish text is
// the key, tr() returns the translation for Ajustes > General > Idioma de la interfaz.
import EN from '../renderer/i18n/en.js';
import * as settings from './settings.js';

const DICTS = { en: EN };

export function tr(s, vars) {
  const lang = settings.get('uiLanguage') || 'es';
  let out = (lang !== 'es' && DICTS[lang]?.[s]) || s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}
