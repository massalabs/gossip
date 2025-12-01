import { create } from 'zustand';
import { createSelectors } from './utils/createSelectors';

interface NetworkStoreState {
  isOnline: boolean;
  lastChangedAt: number | null;
  setIsOnline: (online: boolean) => void;
}

const useNetworkStoreBase = create<NetworkStoreState>(set => ({
  isOnline:
    typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
      ? navigator.onLine
      : true,
  lastChangedAt: null,
  setIsOnline: (online: boolean) =>
    set({
      isOnline: online,
      lastChangedAt: Date.now(),
    }),
}));

export const useNetworkStore = createSelectors(useNetworkStoreBase);
