/**
 * WASM Module Loader and Initialization Service
 *
 * This file handles both WASM core initialization and module loading.
 * It ensures WASM modules are initialized once and properly throughout
 * the application lifecycle.
 */

import init from '@/assets/generated/wasm/gossip_wasm';

/**
 * Check if we're running in Node.js environment
 */
function isNodeEnvironment(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null
  );
}

/**
 * Load WASM module for Node.js environment using fs.readFileSync
 */
async function loadWasmForNode(): Promise<WebAssembly.Module> {
  // Dynamic import to avoid bundling Node.js modules in browser builds
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  // Get the directory of the current module
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // Resolve path to WASM file - WASM is in the SDK's generated folder
  const wasmPath = path.resolve(
    __dirname,
    '../assets/generated/wasm/gossip_wasm_bg.wasm'
  );

  // Read WASM file as binary
  const wasmBuffer = fs.readFileSync(wasmPath);

  // Instantiate WASM module
  const wasmModule = await WebAssembly.compile(wasmBuffer);
  return wasmModule;
}

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
      // In Node.js environment, load WASM using fs.readFileSync
      if (isNodeEnvironment()) {
        const wasmModule = await loadWasmForNode();
        await init(wasmModule);
      } else {
        // In browser/jsdom, use default init (which uses fetch)
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
