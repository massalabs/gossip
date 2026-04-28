import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { enableDebugLogger } from './utils/logger.ts';
import { showInitError } from './utils/initError.ts';
import { installSafariWorkerDedup } from './utils/safariWorkerDedup';
import { createSdk } from './sdk';
import { useSdkStore } from './stores/sdkStore';
import { protocolConfig } from './config/protocol';
import {
  SECURE_STORAGE_ENABLED,
  DEV_HARDCODED_PASSWORD,
} from './config/features';
import { Capacitor } from '@capacitor/core';
import waSqliteWasmUrl from 'wa-sqlite/dist/wa-sqlite.wasm?url';
import waSqliteAsyncWasmUrl from 'wa-sqlite/dist/wa-sqlite-async.wasm?url';
import secureStorageWasmUrl from '@massalabs/gossip-sdk/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';

// Must run before createSdk() so the SDK's SQLite worker is wrapped.
installSafariWorkerDedup();

// Polyfill for Buffer
import { Buffer } from 'buffer';

// Setup SHA-512 for @noble/ed25519 (required for massa-web3)
import { sha512 } from '@noble/hashes/sha2';
import * as ed from '@noble/ed25519';
ed.utils.sha512Sync = (...m) => sha512(ed.utils.concatBytes(...m));

// Capacitor imports
import { initSafeArea } from './styles/initSafeArea.ts';

// Extend Window interface to include Buffer
declare global {
  interface Window {
    Buffer: typeof Buffer;
  }
}

window.Buffer = Buffer;

// Prevent pull-to-refresh and accidental page refreshes
document.addEventListener(
  'touchstart',
  e => {
    // Only prevent pull-to-refresh when touching at the very top of the page
    // and when the page is already at the top
    if (e.touches[0].clientY < 20 && window.scrollY === 0) {
      e.preventDefault();
    }
  },
  { passive: false }
);

// Prevent refresh on certain key combinations
document.addEventListener('keydown', e => {
  // Prevent Ctrl+R, F5, etc. (but allow in development)
  if (
    import.meta.env.PROD &&
    ((e.ctrlKey && e.key === 'r') || e.key === 'F5')
  ) {
    e.preventDefault();
  }
});

// Prevent context menu on long press (optional) - disabled to avoid interfering with normal interactions
// document.addEventListener('contextmenu', (e) => {
//   e.preventDefault();
// });

// Handle page refresh gracefully
window.addEventListener('beforeunload', () => {
  // Store current state before page unload
  const currentPath = window.location.pathname;
  const currentState = {
    path: currentPath,
    timestamp: Date.now(),
  };
  sessionStorage.setItem('gossip-app-state', JSON.stringify(currentState));
});

// Restore state on page load
window.addEventListener('load', () => {
  const savedState = sessionStorage.getItem('gossip-app-state');
  if (savedState) {
    try {
      const state = JSON.parse(savedState);
      // If the page was refreshed recently (within 5 seconds), it was likely accidental
      if (Date.now() - state.timestamp < 5000) {
        console.log('Page refresh detected, restoring state...');
        // You could add logic here to restore the previous screen
      }
    } catch (e) {
      console.log('Could not restore app state:', e);
    }
  }
});

// Only enable the debug logger in development to avoid persisting
// potentially sensitive console output in production builds.
// if (import.meta.env.DEV) {
// We keep it during development phase
// TODO - Remove this once we have a proper debug mode in settings
enableDebugLogger();
// }

const isNative = Capacitor.isNativePlatform();

async function bootstrap() {
  const sdk = await createSdk({
    protocolBaseUrl: protocolConfig.baseUrl,
    config: { polling: { enabled: true } },
    storage: SECURE_STORAGE_ENABLED
      ? {
          type: 'secureStorage',
          domain: 'gossip',
          secureStorageWasmUrl,
        }
      : isNative
        ? { type: 'opfs', path: '/gossip-db', wasmUrl: waSqliteWasmUrl }
        : { type: 'idb', name: 'gossip-db', wasmUrl: waSqliteAsyncWasmUrl },
  });

  if (SECURE_STORAGE_ENABLED) {
    if (import.meta.env.PROD) {
      // The hardcoded-password bootstrap wipes existing data on unlock
      // failure and uses a known-bad password. Refuse to run in
      // production builds - the real unlock UX lives behind the
      // user-credential flow.
      throw new Error(
        'VITE_SECURE_STORAGE cannot be used in production builds yet'
      );
    }
    if (sdk.storageState === 'locked') {
      const ok = await sdk.secureStorageUnlock(DEV_HARDCODED_PASSWORD);
      if (!ok) {
        // Unlock failed - likely stale data from a previous dev build
        // with a different storage format. Silently re-provision and
        // create fresh; surfacing the reset in the console would leak
        // to any observer that the underlying storage was reset (PD
        // distinguisher from a fresh install).
        await sdk.secureStorageProvision();
        await sdk.secureStorageCreate(0, DEV_HARDCODED_PASSWORD);
      }
    } else {
      // storageState === 'empty' on fresh install (decoys provisioned
      // automatically by init(); we only need to claim slot 0).
      await sdk.secureStorageCreate(0, DEV_HARDCODED_PASSWORD);
    }
  }

  await initSafeArea();
  return sdk;
}

bootstrap()
  .then(sdk => {
    useSdkStore.getState().setSdk(sdk);

    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  })
  .catch(error => {
    // PD: do not log the raw error in production. The error message and
    // stack can carry state-specific text (e.g. "namespace allocation
    // failed: existing data") that an observer of the browser console
    // history can use to fingerprint storage state. In DEV we keep the
    // detail for debugging; the user-facing showInitError() renders one
    // of two generic strings.
    if (import.meta.env.DEV) {
      console.error('[Gossip] Failed to initialize:', error);
    }
    showInitError(error);
  });
