import { create } from 'zustand';
import { Network } from '@capacitor/network';
import { createSelectors } from './utils/createSelectors';

type OnlineStore = {
  isOnline: boolean;
  setOnline: (value: boolean) => void;
  initOnlineStore: () => Promise<void>;
};

// Ensure listeners are only registered once, even if init is called multiple times
let listenersRegistered = false;

export const useOnlineStoreBase = create<OnlineStore>(set => ({
  isOnline: true,

  setOnline: value => set({ isOnline: value }),

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
    });

    const handleBrowserChange = () => {
      set({ isOnline: navigator.onLine });
    };

    window.addEventListener('online', handleBrowserChange);
    window.addEventListener('offline', handleBrowserChange);
  },
}));

export const useOnlineStore = createSelectors(useOnlineStoreBase);
