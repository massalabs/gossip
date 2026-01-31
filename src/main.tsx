import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
// import App from './App.tsx';  // TEMP: disabled for storage testing
import EncryptedStorageTest from './EncryptedStorageTest.tsx'; // TEMP: Storage test UI
import { enableDebugLogger } from './utils/logger.ts';

// Polyfill for Buffer
import { Buffer } from 'buffer';

// SDK configuration
import { gossipSdk } from '@massalabs/gossip-sdk';
import { protocolConfig } from './config/protocol';
import { db } from './db';

// Setup SHA-512 for @noble/ed25519 (required for massa-web3)
import { sha512 } from '@noble/hashes/sha2';
import * as ed from '@noble/ed25519';
ed.utils.sha512Sync = (...m) => sha512(ed.utils.concatBytes(...m));

// Capacitor imports
import { Capacitor } from '@capacitor/core';
import { SafeArea } from 'capacitor-plugin-safe-area';

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

// Initialize SDK (also starts WASM initialization in background)
gossipSdk.init({
  db,
  protocolBaseUrl: protocolConfig.baseUrl,
});

// Only enable the debug logger in development to avoid persisting
// potentially sensitive console output in production builds.
// if (import.meta.env.DEV) {
// We keep it during development phase
// TODO - Remove this once we have a proper debug mode in settings
enableDebugLogger();
// }

/**
 * Initialize safe area insets using capacitor-plugin-safe-area.
 * This plugin injects CSS variables --safe-area-inset-* that work on both iOS and Android.
 */
async function initSafeArea(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const { insets } = await SafeArea.getSafeAreaInsets();
    const root = document.documentElement;

    // Set CSS variables for safe areas
    root.style.setProperty('--sat', `${insets.top}px`);
    root.style.setProperty('--sab', `${insets.bottom}px`);
    root.style.setProperty('--sal', `${insets.left}px`);
    root.style.setProperty('--sar', `${insets.right}px`);

    console.log('[SafeArea] Insets applied:', insets);
  } catch (error) {
    console.error('[SafeArea] Failed to get insets:', error);
  }
}

// Initialize safe areas then render app
initSafeArea().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/* TEMP: Storage test UI - replace with <App /> for production */}
      <EncryptedStorageTest />
      {/* <App /> */}
    </StrictMode>
  );
});
