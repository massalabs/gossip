import { logger } from '../utils/logger.ts';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { NetworkName, Provider } from '@massalabs/massa-web3';
import { createSelectors } from './utils/createSelectors';
import { STORAGE_KEYS } from '../utils/localStorage';
import { ParsedInvite } from '../utils/invite';
import { mnsService } from '../services/mns';
import { UserProfile } from '@massalabs/gossip-sdk';

// Debug console button position
interface DebugButtonPosition {
  x: number;
  y: number;
}

interface AppStoreState {
  // Terms of Service acceptance
  tosAccepted: boolean;
  setTosAccepted: (value: boolean) => void;
  // Network config (read by accountStore)
  networkName: NetworkName;
  setNetworkName: (networkName: NetworkName) => void;
  // Debug options visibility
  showDebugOption: boolean;
  setShowDebugOption: (show: boolean) => void;
  // Debug overlay visibility
  debugOverlayVisible: boolean;
  setDebugOverlayVisible: (visible: boolean) => void;
  // Native screenshot protection
  disableNativeScreenshot: boolean;
  setDisableNativeScreenshot: (disabled: boolean) => void;
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
  // Default retention duration for new discussions (seconds), null = off
  defaultRetentionDuration: number | null;
  setDefaultRetentionDuration: (duration: number | null) => void;
  // Auto-lock timeout (seconds), null = disabled
  autoLockTimeout: number | null;
  setAutoLockTimeout: (timeout: number | null) => void;
}

const useAppStoreBase = create<AppStoreState>()(
  persist(
    (set, get) => ({
      // Terms of Service acceptance
      tosAccepted: false,
      setTosAccepted: (value: boolean) => {
        set({ tosAccepted: value });
      },
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
      // Native screenshot protection (off by default)
      disableNativeScreenshot: false,
      setDisableNativeScreenshot: (disabled: boolean) => {
        set({ disableNativeScreenshot: disabled });
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
      // Default retention duration for new discussions (1 month = 2592000s)
      defaultRetentionDuration: 2592000,
      setDefaultRetentionDuration: (duration: number | null) => {
        set({ defaultRetentionDuration: duration });
      },
      // Auto-lock timeout (disabled by default)
      autoLockTimeout: null,
      setAutoLockTimeout: (timeout: number | null) => {
        set({ autoLockTimeout: timeout });
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
          logger.error('Error fetching MNS domains:', error);
          set({ mnsDomains: [] });
        }
      },
    }),
    {
      name: STORAGE_KEYS.APP_STORE,
      storage: createJSONStorage(() => localStorage),
      partialize: state => ({
        tosAccepted: state.tosAccepted,
        showDebugOption: state.showDebugOption,
        debugOverlayVisible: state.debugOverlayVisible,
        debugButtonPosition: state.debugButtonPosition,
        isInitialized: state.isInitialized,
        networkName: state.networkName,
        mnsEnabled: state.mnsEnabled,
        mnsDomains: state.mnsDomains,
        disableNativeScreenshot: state.disableNativeScreenshot,
        defaultRetentionDuration: state.defaultRetentionDuration,
        autoLockTimeout: state.autoLockTimeout,
      }),
    }
  )
);

export const useAppStore = createSelectors(useAppStoreBase);
