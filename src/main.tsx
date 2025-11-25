import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { ThemeProvider } from './context/theme-provider.tsx';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';

// Polyfill for Buffer
import { Buffer } from 'buffer';

// WASM initialization service
import { startWasmInitialization } from './wasm';

// Setup SHA-512 for @noble/ed25519 (required for massa-web3)
import { sha512 } from '@noble/hashes/sha2';
import * as ed from '@noble/ed25519';
ed.utils.sha512Sync = (...m) => sha512(ed.utils.concatBytes(...m));

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

// Configure status bar overlay for native platforms (style will be set by theme provider)
if (Capacitor.isNativePlatform()) {
  StatusBar.setOverlaysWebView({ overlay: false });
}

// Start WASM initialization in the background (non-blocking)
startWasmInitialization();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="gossip-theme">
      <App />
    </ThemeProvider>
  </StrictMode>
);
