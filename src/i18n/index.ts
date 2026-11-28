import i18n, { type LoggerModule } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// EN
import enCommon from './locales/en/common.json';
import enAuth from './locales/en/auth.json';
import enDiscussions from './locales/en/discussions.json';
import enSettings from './locales/en/settings.json';
import enWallet from './locales/en/wallet.json';
import enOnboarding from './locales/en/onboarding.json';
import enErrors from './locales/en/errors.json';
import enTime from './locales/en/time.json';
import enContacts from './locales/en/contacts.json';
import enValidation from './locales/en/validation.json';
import enGroups from './locales/en/groups.json';

// FR
import frCommon from './locales/fr/common.json';
import frAuth from './locales/fr/auth.json';
import frDiscussions from './locales/fr/discussions.json';
import frSettings from './locales/fr/settings.json';
import frWallet from './locales/fr/wallet.json';
import frOnboarding from './locales/fr/onboarding.json';
import frErrors from './locales/fr/errors.json';
import frTime from './locales/fr/time.json';
import frContacts from './locales/fr/contacts.json';
import frValidation from './locales/fr/validation.json';
import frGroups from './locales/fr/groups.json';

// ZH-CN
import zhCommon from './locales/zh-CN/common.json';
import zhAuth from './locales/zh-CN/auth.json';
import zhDiscussions from './locales/zh-CN/discussions.json';
import zhSettings from './locales/zh-CN/settings.json';
import zhWallet from './locales/zh-CN/wallet.json';
import zhOnboarding from './locales/zh-CN/onboarding.json';
import zhErrors from './locales/zh-CN/errors.json';
import zhTime from './locales/zh-CN/time.json';
import zhContacts from './locales/zh-CN/contacts.json';
import zhValidation from './locales/zh-CN/validation.json';
import zhGroups from './locales/zh-CN/groups.json';

// RU
import ruCommon from './locales/ru/common.json';
import ruAuth from './locales/ru/auth.json';
import ruDiscussions from './locales/ru/discussions.json';
import ruSettings from './locales/ru/settings.json';
import ruWallet from './locales/ru/wallet.json';
import ruOnboarding from './locales/ru/onboarding.json';
import ruErrors from './locales/ru/errors.json';
import ruTime from './locales/ru/time.json';
import ruContacts from './locales/ru/contacts.json';
import ruValidation from './locales/ru/validation.json';
import ruGroups from './locales/ru/groups.json';

export const SUPPORTED_LANGUAGES = ['en', 'fr', 'zh-CN', 'ru'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: 'English',
  fr: 'Français',
  'zh-CN': '简体中文',
  ru: 'Русский',
};

const resources = {
  en: {
    common: enCommon,
    auth: enAuth,
    discussions: enDiscussions,
    settings: enSettings,
    wallet: enWallet,
    onboarding: enOnboarding,
    errors: enErrors,
    time: enTime,
    contacts: enContacts,
    validation: enValidation,
    groups: enGroups,
  },
  fr: {
    common: frCommon,
    auth: frAuth,
    discussions: frDiscussions,
    settings: frSettings,
    wallet: frWallet,
    onboarding: frOnboarding,
    errors: frErrors,
    time: frTime,
    contacts: frContacts,
    validation: frValidation,
    groups: frGroups,
  },
  'zh-CN': {
    common: zhCommon,
    auth: zhAuth,
    discussions: zhDiscussions,
    settings: zhSettings,
    wallet: zhWallet,
    onboarding: zhOnboarding,
    errors: zhErrors,
    time: zhTime,
    contacts: zhContacts,
    validation: zhValidation,
    groups: zhGroups,
  },
  ru: {
    common: ruCommon,
    auth: ruAuth,
    discussions: ruDiscussions,
    settings: ruSettings,
    wallet: ruWallet,
    onboarding: ruOnboarding,
    errors: ruErrors,
    time: ruTime,
    contacts: ruContacts,
    validation: ruValidation,
    groups: ruGroups,
  },
};

// i18next writes its errors to the console even with `debug` off. A release
// build writes no log, so unless debug logging is on (dev server or
// VITE_DEBUG_LOGS, as in src/utils/logger.ts) it gets a logger that writes
// nothing.
const isDebugLoggingEnabled =
  import.meta.env.DEV || import.meta.env.VITE_DEBUG_LOGS === 'true';
if (!isDebugLoggingEnabled) {
  const silentLogger: LoggerModule = {
    type: 'logger',
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  i18n.use(silentLogger);
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: [
      'common',
      'auth',
      'discussions',
      'settings',
      'wallet',
      'onboarding',
      'errors',
      'time',
      'contacts',
      'validation',
      'groups',
    ],

    interpolation: {
      escapeValue: false, // React already handles XSS
    },

    detection: {
      order: ['navigator'],
      caches: [],
    },
  });

export default i18n;
