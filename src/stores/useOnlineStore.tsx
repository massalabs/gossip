import { create } from 'zustand';
import { Network } from '@capacitor/network';
import { createSelectors } from './utils/createSelectors';
import { protocolConfig } from '../config/protocol';

const API_CHECK_INTERVAL_MS = 10_000;

type OnlineStore = {
  isOnline: boolean;
  isApiReachable: boolean;
  setOnline: (value: boolean) => void;
  setApiReachable: (value: boolean) => void;
  initOnlineStore: () => Promise<void>;
  startApiCheck: () => void;
  stopApiCheck: () => void;
};

// Ensure listeners are only registered once, even if init is called multiple times
let listenersRegistered = false;
let apiCheckInterval: ReturnType<typeof setInterval> | null = null;

async function checkApi(set: (s: Partial<OnlineStore>) => void) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    // mode: 'no-cors' avoids CORS failures — an opaque response still
    // proves the server is reachable, while a network error (connection
    // refused / timeout) correctly signals unreachable.
    await fetch(protocolConfig.baseUrl, {
      mode: 'no-cors',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    set({ isApiReachable: true });
  } catch {
    set({ isApiReachable: false });
  }
}

export const useOnlineStoreBase = create<OnlineStore>(set => ({
  isOnline: true,
  isApiReachable: true,

  setOnline: value => set({ isOnline: value }),
  setApiReachable: value => set({ isApiReachable: value }),

  initOnlineStore: async () => {
    if (listenersRegistered) return;
    listenersRegistered = true;

    const updateFromNative = async () => {
      try {
        const status = await Network.getStatus();
        set({ isOnline: status.connected });
      } catch {
        set({ isOnline: navigator.onLine });
      }
    };

    await updateFromNative();

    Network.addListener('networkStatusChange', status => {
      set({ isOnline: status.connected });
      // Re-check API immediately when network comes back
      if (status.connected) {
        checkApi(set);
      }
    });

    const handleBrowserChange = () => {
      set({ isOnline: navigator.onLine });
      if (navigator.onLine) {
        checkApi(set);
      }
    };

    window.addEventListener('online', handleBrowserChange);
    window.addEventListener('offline', handleBrowserChange);
  },

  startApiCheck: () => {
    if (apiCheckInterval) return;
    checkApi(set);
    apiCheckInterval = setInterval(() => checkApi(set), API_CHECK_INTERVAL_MS);
  },

  stopApiCheck: () => {
    if (apiCheckInterval) {
      clearInterval(apiCheckInterval);
      apiCheckInterval = null;
    }
  },
}));

export const useOnlineStore = createSelectors(useOnlineStoreBase);
