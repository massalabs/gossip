/**
 * Runtime environment detection utilities.
 *
 * Detects capabilities to choose the appropriate runtime adapter:
 * - Browser with Worker + OPFS → BrowserWorkerRuntime
 * - Browser without Worker → BrowserSyncRuntime
 * - Node.js → NodeRuntime
 */

import type { RuntimeCapabilities } from '../interfaces';

/**
 * Cached capabilities (computed once)
 */
let cachedCapabilities: RuntimeCapabilities | null = null;

/**
 * Detect runtime capabilities
 */
export function detectCapabilities(): RuntimeCapabilities {
  if (cachedCapabilities) {
    return cachedCapabilities;
  }

  const capabilities: RuntimeCapabilities = {
    hasWorker: false,
    hasOPFS: false,
    isNode: false,
    isBrowser: false,
    hasSharedArrayBuffer: false,
  };

  // Check for Node.js
  if (
    typeof process !== 'undefined' &&
    process.versions &&
    process.versions.node
  ) {
    capabilities.isNode = true;
    // Node has worker_threads but we'll use sync mode for simplicity
    capabilities.hasWorker = false;
    capabilities.hasOPFS = false;
    // Node 16+ has SharedArrayBuffer by default
    capabilities.hasSharedArrayBuffer =
      typeof SharedArrayBuffer !== 'undefined';
  }
  // Check for browser
  else if (typeof window !== 'undefined' || typeof self !== 'undefined') {
    capabilities.isBrowser = true;

    // Check for Web Workers
    capabilities.hasWorker = typeof Worker !== 'undefined';

    // Check for OPFS (Origin Private File System)
    capabilities.hasOPFS =
      typeof navigator !== 'undefined' &&
      typeof navigator.storage !== 'undefined' &&
      typeof navigator.storage.getDirectory === 'function';

    // Check for SharedArrayBuffer (needed for Atomics in worker communication)
    capabilities.hasSharedArrayBuffer =
      typeof SharedArrayBuffer !== 'undefined' &&
      typeof Atomics !== 'undefined';
  }

  cachedCapabilities = capabilities;
  return capabilities;
}

/**
 * Reset cached capabilities (for testing)
 */
export function resetCapabilitiesCache(): void {
  cachedCapabilities = null;
}

/**
 * Determine the best runtime type based on capabilities
 */
export function getBestRuntimeType(
  capabilities: RuntimeCapabilities,
  preferredMode?: 'worker' | 'sync' | 'auto'
): 'browser-worker' | 'browser-sync' | 'node' {
  // Node.js always uses sync runtime
  if (capabilities.isNode) {
    return 'node';
  }

  // Browser - check for worker preference
  if (capabilities.isBrowser) {
    // If user explicitly wants sync mode
    if (preferredMode === 'sync') {
      return 'browser-sync';
    }

    // If user explicitly wants worker mode
    if (preferredMode === 'worker') {
      if (!capabilities.hasWorker) {
        console.warn(
          'Worker mode requested but Workers not available. Falling back to sync mode.'
        );
        return 'browser-sync';
      }
      if (!capabilities.hasOPFS) {
        console.warn(
          'Worker mode requested but OPFS not available. Falling back to sync mode.'
        );
        return 'browser-sync';
      }
      return 'browser-worker';
    }

    // Auto mode - prefer worker if available
    if (capabilities.hasWorker && capabilities.hasOPFS) {
      return 'browser-worker';
    }

    return 'browser-sync';
  }

  // Fallback (shouldn't happen)
  console.warn('Unknown runtime environment, defaulting to browser-sync');
  return 'browser-sync';
}

/**
 * Check if the current environment supports the encrypted SQLite backend
 */
export function supportsEncryptedSqlite(): boolean {
  const caps = detectCapabilities();

  // Node.js: needs filesystem access (always available)
  if (caps.isNode) {
    return true;
  }

  // Browser: needs either OPFS (for worker mode) or IndexedDB (for sync fallback)
  if (caps.isBrowser) {
    // OPFS is preferred but IndexedDB can be used as fallback for blob storage
    const hasIndexedDB = typeof indexedDB !== 'undefined';
    return caps.hasOPFS || hasIndexedDB;
  }

  return false;
}

/**
 * Check if the current environment supports the Dexie backend
 */
export function supportsDexie(): boolean {
  const caps = detectCapabilities();

  // Dexie requires IndexedDB (browser only)
  if (caps.isBrowser) {
    return typeof indexedDB !== 'undefined';
  }

  return false;
}

/**
 * Get a human-readable description of the current runtime
 */
export function getRuntimeDescription(): string {
  const caps = detectCapabilities();

  if (caps.isNode) {
    return `Node.js (sync mode, filesystem storage)`;
  }

  if (caps.isBrowser) {
    const features: string[] = [];
    if (caps.hasWorker) features.push('Worker');
    if (caps.hasOPFS) features.push('OPFS');
    if (caps.hasSharedArrayBuffer) features.push('SharedArrayBuffer');

    const runtimeType = getBestRuntimeType(caps);
    return `Browser (${runtimeType}, features: ${features.join(', ') || 'none'})`;
  }

  return 'Unknown environment';
}
