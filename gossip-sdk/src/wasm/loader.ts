/**
 * WASM Module Loader and Initialization Service
 *
 * This file handles WASM initialization. The actual wasm module is resolved
 * via the #wasm import which conditionally loads the correct target:
 * - Browser: web target (has init function, uses import.meta.url + fetch)
 * - Node: nodejs target (auto-initializes, no init function needed)
 */

import * as wasmModule from '#wasm';

// The web target has a default export (init function), nodejs target doesn't
const init = (wasmModule as { default?: (input?: unknown) => Promise<unknown> })
  .default;

/**
 * WASM Initialization State
 */
let isInitializing = false;
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;
let initError: Error | null = null;

/**
 * Initialize WASM modules if not already initialized
 * This function is idempotent - safe to call multiple times
 */
export async function initializeWasm(): Promise<void> {
  // If already initialized, return immediately
  if (isInitialized) {
    return;
  }

  // If initialization is in progress, wait for it to complete
  if (isInitializing && initializationPromise) {
    return initializationPromise;
  }

  // Start initialization
  isInitializing = true;
  initError = null;

  initializationPromise = (async () => {
    try {
      // The #wasm import resolves to the correct target based on environment:
      // - Browser (web target): has init() function that needs to be called
      // - Node (nodejs target): auto-initializes on import, no init needed
      if (typeof init === 'function') {
        await init();
      }
      // For nodejs target, wasm is already initialized on import
      isInitialized = true;
      isInitializing = false;
    } catch (error) {
      initError = error as Error;
      isInitializing = false;
      console.error('[WASM] Failed to initialize WASM modules:', error);
      throw error;
    }
  })();

  return initializationPromise;
}

/**
 * Ensure WASM is initialized, throwing an error if initialization failed
 */
export async function ensureWasmInitialized(): Promise<void> {
  await initializeWasm();

  if (initError) {
    throw new Error(`WASM initialization failed: ${initError.message}`);
  }

  if (!isInitialized) {
    throw new Error('WASM not initialized');
  }
}

/**
 * Start WASM initialization in the background.
 * Call this early in the app lifecycle (for example in main.tsx).
 */
export function startWasmInitialization(): void {
  // Fire and forget - start initialization in background
  initializeWasm().catch(error => {
    console.error('[WASM] Background initialization error:', error);
  });
}
