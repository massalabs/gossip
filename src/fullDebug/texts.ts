/** The texts of the full debug build, added to i18n only in that build. */
import i18n from '../i18n';
import en from './locales/en.json';
import fr from './locales/fr.json';
import zh from './locales/zh-CN.json';
import ru from './locales/ru.json';

export const FULL_DEBUG_NS = 'fullDebug';

export function registerFullDebugTexts(): void {
  const bundles: Record<string, Record<string, string>> = {
    en,
    fr,
    'zh-CN': zh,
    ru,
  };
  for (const [lng, texts] of Object.entries(bundles)) {
    if (!i18n.hasResourceBundle(lng, FULL_DEBUG_NS)) {
      i18n.addResourceBundle(lng, FULL_DEBUG_NS, texts);
    }
  }
}
