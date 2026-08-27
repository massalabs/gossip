import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { configureAppLogging, logger } from './utils/logger.ts';
import { showInitError } from './utils/initError.ts';
import { installSafariWorkerDedup } from './utils/safariWorkerDedup';
import { createSdk } from './sdk';
import { useSdkStore } from './stores/sdkStore';
import { protocolConfig } from './config/protocol';
import { SECURE_STORAGE_ENABLED } from './config/features';
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
      logger.error('[Gossip] Failed to initialize:', error);
    }
    showInitError(error);
  });
