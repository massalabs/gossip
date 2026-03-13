import i18n from 'i18next';
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

// FR
import frCommon from './locales/fr/common.json';
import frAuth from './locales/fr/auth.json';
import frDiscussions from './locales/fr/discussions.json';
import frSettings from './locales/fr/settings.json';
import frWallet from './locales/fr/wallet.json';
import frOnboarding from './locales/fr/onboarding.json';
import frErrors from './locales/fr/errors.json';
import frTime from './locales/fr/time.json';

// ZH-CN
import zhCommon from './locales/zh-CN/common.json';
import zhAuth from './locales/zh-CN/auth.json';
import zhDiscussions from './locales/zh-CN/discussions.json';
import zhSettings from './locales/zh-CN/settings.json';
import zhWallet from './locales/zh-CN/wallet.json';
import zhOnboarding from './locales/zh-CN/onboarding.json';
import zhErrors from './locales/zh-CN/errors.json';
import zhTime from './locales/zh-CN/time.json';

// RU
import ruCommon from './locales/ru/common.json';
import ruAuth from './locales/ru/auth.json';
import ruDiscussions from './locales/ru/discussions.json';
import ruSettings from './locales/ru/settings.json';
import ruWallet from './locales/ru/wallet.json';
import ruOnboarding from './locales/ru/onboarding.json';
import ruErrors from './locales/ru/errors.json';
import ruTime from './locales/ru/time.json';

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
  },
};

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
    ],

    interpolation: {
      escapeValue: true,
    },

    detection: {
      order: ['navigator'],
      caches: [],
    },

    saveMissing: false,
    missingKeyHandler: false,
  });

export default i18n;
