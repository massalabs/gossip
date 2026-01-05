import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { enableDebugLogger } from './utils/logger.ts';

// Polyfill for Buffer
import { Buffer } from 'buffer';

// WASM initialization service
import { startWasmInitialization } from './wasm';

// Setup SHA-512 for @noble/ed25519 (required for massa-web3)
import { sha512 } from '@noble/hashes/sha2';
import * as ed from '@noble/ed25519';
ed.utils.sha512Sync = (...m) => sha512(ed.utils.concatBytes(...m));

// Capacitor imports for early safe area capture
import { Capacitor } from '@capacitor/core';
import { EdgeToEdge } from '@capawesome/capacitor-android-edge-to-edge-support';

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

// Start WASM initialization in the background (non-blocking)
startWasmInitialization();

// Only enable the debug logger in development to avoid persisting
// potentially sensitive console output in production builds.
// if (import.meta.env.DEV) {
// We keep it during development phase
// TODO - Remove this once we have a proper debug mode in settings
enableDebugLogger();
// }

/**
 * Capture Android safe area insets BEFORE the app renders.
 * This must happen early because:
 * 1. EdgeToEdge.getInsets() only returns valid values before EdgeToEdge.disable()
 * 2. The service worker may trigger a reload shortly after app start
 * 3. We store insets in sessionStorage to survive reloads
 */
async function captureAndroidSafeAreaInsets(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;

  const STORAGE_KEY = 'safe-area-insets';
  const stored = sessionStorage.getItem(STORAGE_KEY);

  // Skip if already captured (survives reloads)
  if (stored) {
    const { sat, sab, sal, sar } = JSON.parse(stored);
    const root = document.documentElement;
    root.style.setProperty('--sat', `${sat}px`);
    root.style.setProperty('--sab', `${sab}px`);
    root.style.setProperty('--sal', `${sal}px`);
    root.style.setProperty('--sar', `${sar}px`);
    console.log('[SafeArea] Applied stored insets:', { sat, sab });
    return;
  }

  try {
    // Get insets BEFORE disabling edge-to-edge
    const insets = await EdgeToEdge.getInsets();
    console.log('[SafeArea] Raw Android insets:', insets);

    if (insets.top > 0 || insets.bottom > 0) {
      // Convert from physical pixels to CSS pixels
      const density = window.devicePixelRatio || 1;
      const safeInsets = {
        sat: Math.round(insets.top / density),
        sab: Math.round(insets.bottom / density),
        sal: Math.round(insets.left / density),
        sar: Math.round(insets.right / density),
      };

      // Store for future reloads
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(safeInsets));

      // Apply to CSS
      const root = document.documentElement;
      root.style.setProperty('--sat', `${safeInsets.sat}px`);
      root.style.setProperty('--sab', `${safeInsets.sab}px`);
      root.style.setProperty('--sal', `${safeInsets.sal}px`);
      root.style.setProperty('--sar', `${safeInsets.sar}px`);

      console.log(
        '[SafeArea] Captured and stored insets (density=' + density + '):',
        safeInsets
      );
    }

    // Disable edge-to-edge after capturing insets
    await EdgeToEdge.disable();
  } catch (error) {
    console.error('[SafeArea] Failed to capture insets:', error);
  }
}

// Capture safe area insets immediately, then render app
captureAndroidSafeAreaInsets().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
