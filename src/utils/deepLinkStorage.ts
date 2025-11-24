import { Preferences } from '@capacitor/preferences';

const PENDING_DEEPLINK_KEY = 'pending_deeplink';

export const setPendingDeepLink = async (url: string): Promise<void> => {
  await Preferences.set({ key: PENDING_DEEPLINK_KEY, value: url });
};

export const getPendingDeepLink = async (): Promise<string | null> => {
  const { value } = await Preferences.get({ key: PENDING_DEEPLINK_KEY });
  if (!value) return null;
  await Preferences.remove({ key: PENDING_DEEPLINK_KEY });
  return value;
};

export const clearPendingDeepLink = async (): Promise<void> => {};
