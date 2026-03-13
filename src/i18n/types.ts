import type enCommon from './locales/en/common.json';
import type enAuth from './locales/en/auth.json';
import type enDiscussions from './locales/en/discussions.json';
import type enSettings from './locales/en/settings.json';
import type enWallet from './locales/en/wallet.json';
import type enOnboarding from './locales/en/onboarding.json';
import type enErrors from './locales/en/errors.json';
import type enTime from './locales/en/time.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof enCommon;
      auth: typeof enAuth;
      discussions: typeof enDiscussions;
      settings: typeof enSettings;
      wallet: typeof enWallet;
      onboarding: typeof enOnboarding;
      errors: typeof enErrors;
      time: typeof enTime;
    };
  }
}
