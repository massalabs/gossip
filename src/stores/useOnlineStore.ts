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

/** Told of every change of the device's network, connection type included. */
const networkChangeListeners = new Set<() => void>();

/**
 * Calls `listener` whenever the network changes (a connection comes or goes,
 * or another one replaces it). Returns the function that removes it.
 */
export function onNetworkChange(listener: () => void): () => void {
  networkChangeListeners.add(listener);
  return () => networkChangeListeners.delete(listener);
}

function networkChanged(): void {
  for (const listener of networkChangeListeners) {
    try {
      listener();
    } catch {
      // one listener must not keep the others from hearing it
    }
  }
}

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
      networkChanged();
    });

    const handleBrowserChange = () => {
      set({ isOnline: navigator.onLine });
      networkChanged();
    };

    window.addEventListener('online', handleBrowserChange);
    window.addEventListener('offline', handleBrowserChange);
  },
}));

export const useOnlineStore = createSelectors(useOnlineStoreBase);
