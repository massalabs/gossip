import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { configureAppLogging, logger } from './utils/logger.ts';
import { showInitError } from './utils/initError.ts';
import { installSafariWorkerDedup } from './utils/safariWorkerDedup';
import { createSdk } from './sdk';
import { useSdkStore } from './stores/sdkStore';
import { useAppStore } from './stores/appStore';
import { establishFirstInstallCreationGrant } from './hooks/useProfileLoader';
import { protocolConfig } from './config/protocol';
import { SECURE_STORAGE_ENABLED } from './config/features';
import { Capacitor } from '@capacitor/core';
import waSqliteWasmUrl from 'wa-sqlite/dist/wa-sqlite.wasm?url';
import waSqliteAsyncWasmUrl from 'wa-sqlite/dist/wa-sqlite-async.wasm?url';
import secureStorageWasmUrl from '@massalabs/gossip-sdk/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';
import UnsupportedStorageReset from './components/UnsupportedStorageReset';
import {
  isUnsupportedStorageResetRequested,
  isUnsupportedStorageVersionError,
  requestUnsupportedStorageReset,
} from './services/unsupportedStorageReset';

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

// Pull-to-refresh is disabled via CSS (`overscroll-behavior: none` on
// html/body in styles/base.css). No JS touchstart guard: the previous one
// keyed on `window.scrollY === 0`, which is always true in this
// inner-scroll layout, making every element in the top 20px tap-dead.

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

// Configure the shared app/SDK logger before creating the SDK so all
// runtime logging uses the same sinks. Release builds configure no sinks.
configureAppLogging();

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

  await initSafeArea();
  return sdk;
}

const renderUnsupportedStorageReset = () => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <UnsupportedStorageReset />
    </StrictMode>
  );
};

async function start() {
  if (isUnsupportedStorageResetRequested()) {
    renderUnsupportedStorageReset();
    return;
  }
  const sdk = await bootstrap();
  useSdkStore.getState().setSdk(sdk);
  try {
    await establishFirstInstallCreationGrant(sdk);
  } catch (error) {
    if (sdk.isSecureStorage && sdk.storageState === 'locked') {
      const appState = useAppStore.getState();
      appState.setSecureStartupRouting(appState.isInitialized, true);
    } else {
      throw error;
    }
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void start().catch(error => {
  if (isUnsupportedStorageVersionError(error)) {
    requestUnsupportedStorageReset();
    return;
  }
  // PD: do not log raw production errors: state-specific text can reveal
  // storage state. Development keeps details for diagnostics.
  if (import.meta.env.DEV) {
    logger.error('[Gossip] Failed to initialize:', error);
  }
  showInitError(error);
});
