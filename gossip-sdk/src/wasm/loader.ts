/**
 * WASM Module Loader and Initialization Service
 *
 * This file handles WASM initialization. It uses a single web-target build
 * and detects the runtime to load the WASM binary appropriately:
 * - Browser: init() with no args (uses import.meta.url + fetch internally)
 * - Node.js / Jiti: init(bytes) with WASM bytes read from the filesystem
 */

import { init } from './bindings.js';

/**
 * WASM Initialization State
 */
let isInitializing = false;
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;
let initError: Error | null = null;

/**
 * Detect if running in a Node.js-like environment (Node, Bun, Jiti, etc.)
 */
function isNodeRuntime(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null
  );
}

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
      if (isNodeRuntime()) {
        // Node.js / Jiti: read WASM bytes from filesystem and pass to init()
        // Dynamic imports ensure these Node.js modules are tree-shaken in browser builds
        const fs = await import('node:fs');
        const url = await import('node:url');
        const path = await import('node:path');

        const currentDir = path.dirname(url.fileURLToPath(import.meta.url));
        const wasmPath = path.resolve(
          currentDir,
          '../assets/generated/wasm/gossip_wasm_bg.wasm'
        );
        const wasmBytes = fs.readFileSync(wasmPath);
        await init(wasmBytes);
      } else {
        // Browser: use default loading (import.meta.url + fetch internally)
        await init();
      }

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
