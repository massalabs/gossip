/**
 * WASM Module Exports
 *
 * This file provides a clean interface for importing WASM modules
 * and related functionality.
 */

// Export modules
export { SessionModule, sessionStatusToString } from './session.js';

// Export initialization functions
export {
  initializeWasm,
  ensureWasmInitialized,
  startWasmInitialization,
} from './loader.js';

// Export specialized WASM functionality
export * from './encryption.js';
export * from './userKeys.js';
