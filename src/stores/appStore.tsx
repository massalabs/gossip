import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { NetworkName, Provider } from '@massalabs/massa-web3';
import { createSelectors } from './utils/createSelectors';
import { STORAGE_KEYS } from '../utils/localStorage';
import { ParsedInvite } from '../utils/qrCodeParser';
import { mnsService } from '../services/mns';
import { UserProfile } from '../db';

// Debug console button position
interface DebugButtonPosition {
  x: number;
  y: number;
}

interface AppStoreState {
  // Network config (read by accountStore)
  networkName: NetworkName;
  setNetworkName: (networkName: NetworkName) => void;
  // Debug options visibility
  showDebugOption: boolean;
  setShowDebugOption: (show: boolean) => void;
  // Debug overlay visibility
  debugOverlayVisible: boolean;
  setDebugOverlayVisible: (visible: boolean) => void;
  // Debug console button position
  debugButtonPosition: DebugButtonPosition;
  setDebugButtonPosition: (position: DebugButtonPosition) => void;
  // App initialization state (whether app has checked for existing accounts)
  isInitialized: boolean;
  setIsInitialized: (value: boolean) => void;
  // Pending deep link
  pendingDeepLinkInfo: ParsedInvite | null;
  setPendingDeepLinkInfo: (value: ParsedInvite | null) => void;
  // Pending shared content from other apps
  pendingSharedContent: string | null;
  setPendingSharedContent: (content: string | null) => void;
  // Pending forward message id (used during discussion selection)
  pendingForwardMessageId: number | null;
  setPendingForwardMessageId: (messageId: number | null) => void;
  // MNS support enabled/disabled
  mnsEnabled: boolean;
  setMnsEnabled: (enabled: boolean) => void;
  // MNS domains cache
  mnsDomains: string[];
  setMnsDomains: (domains: string[]) => void;
  fetchMnsDomains: (
    userProfile: UserProfile | null,
    provider: Provider | null
  ) => Promise<void>;
}

const useAppStoreBase = create<AppStoreState>()(
  persist(
    (set, get) => ({
      // Network config
      networkName: NetworkName.Buildnet,
      setNetworkName: (networkName: NetworkName) => {
        set({ networkName });
      },
      // Debug options visibility
      showDebugOption: false,
      setShowDebugOption: (show: boolean) => {
        set({ showDebugOption: show });
      },

      // Debug overlay visibility
      debugOverlayVisible: false,
      setDebugOverlayVisible: (visible: boolean) => {
        set({ debugOverlayVisible: visible });
      },
      // Debug console button position (default: bottom-left)
      debugButtonPosition: { x: 8, y: 80 },
      setDebugButtonPosition: (position: DebugButtonPosition) => {
        set({ debugButtonPosition: position });
      },
      // App initialization state
      isInitialized: false,
      setIsInitialized: (value: boolean) => {
        set({ isInitialized: value });
      },
      // Pending deep link
      pendingDeepLinkInfo: null,
      setPendingDeepLinkInfo: (value: ParsedInvite | null) => {
        set({ pendingDeepLinkInfo: value });
      },
      // Pending shared content
      pendingSharedContent: null,
      setPendingSharedContent: (content: string | null) => {
        set({ pendingSharedContent: content });
      },
      // Pending forward message id
      pendingForwardMessageId: null,
      setPendingForwardMessageId: (messageId: number | null) => {
        set({ pendingForwardMessageId: messageId });
      },
      // MNS support (disabled by default)
      mnsEnabled: false,
      setMnsEnabled: (enabled: boolean) => {
        set({ mnsEnabled: enabled });
        // If disabling, clear cache
        if (!enabled) {
          set({ mnsDomains: [] });
        }
      },
      // MNS domains cache
      mnsDomains: [],
      setMnsDomains: (domains: string[]) => {
        set({ mnsDomains: domains });
      },
      fetchMnsDomains: async (
        userProfile: UserProfile | null,
        provider: Provider | null
      ) => {
        const state = get();

        if (!state.mnsEnabled || !userProfile?.userId || !provider) {
          set({ mnsDomains: [] });
          return;
        }

        try {
          const domains = await mnsService.getDomainsFromGossipId(
            userProfile.userId
          );
          const domainsWithSuffix = domains.map(domain => `${domain}.massa`);
          set({ mnsDomains: domainsWithSuffix });
        } catch (error) {
          console.error('Error fetching MNS domains:', error);
          set({ mnsDomains: [] });
        }
      },
    }),
    {
      name: STORAGE_KEYS.APP_STORE,
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({
        showDebugOption: state.showDebugOption,
        debugOverlayVisible: state.debugOverlayVisible,
        debugButtonPosition: state.debugButtonPosition,
        isInitialized: state.isInitialized,
        networkName: state.networkName,
        mnsEnabled: state.mnsEnabled,
        mnsDomains: state.mnsDomains,
      }),
    }
  )
);

export const useAppStore = createSelectors(useAppStoreBase);
