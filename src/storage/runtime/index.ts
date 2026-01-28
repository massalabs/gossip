/**
 * Runtime detection and adapters
 */

export {
  detectCapabilities,
  resetCapabilitiesCache,
  getBestRuntimeType,
  supportsEncryptedSqlite,
  supportsDexie,
  getRuntimeDescription,
} from './detect';

export { BrowserWorkerRuntime } from './BrowserWorkerRuntime';
export { NodeRuntime, type NodeRuntimeOptions } from './NodeRuntime';
export {
  NodeEncryptedRuntime,
  type NodeEncryptedRuntimeOptions,
} from './NodeEncryptedRuntime';

// Factory function to create the appropriate runtime
import type { IRuntimeAdapter } from '../interfaces';
import { detectCapabilities, getBestRuntimeType } from './detect';
import { BrowserWorkerRuntime } from './BrowserWorkerRuntime';
import { NodeRuntime } from './NodeRuntime';
import { NodeEncryptedRuntime } from './NodeEncryptedRuntime';

export interface CreateRuntimeOptions {
  /**
   * Force a specific runtime mode
   */
  mode?: 'worker' | 'sync' | 'auto';

  /**
   * Database path for Node.js runtime
   */
  dbPath?: string;

  /**
   * Storage path for encrypted files (Node.js encrypted mode)
   */
  storagePath?: string;

  /**
   * Enable debug logging
   */
  debug?: boolean;

  /**
   * Use encrypted storage on Node.js (plausible deniability)
   * Default: true if WASM is available
   */
  encrypted?: boolean;
}

/**
 * Create the appropriate runtime adapter for the current environment
 */
export async function createRuntime(
  options: CreateRuntimeOptions = {}
): Promise<IRuntimeAdapter> {
  const capabilities = detectCapabilities();
  const runtimeType = getBestRuntimeType(capabilities, options.mode);

  let runtime: IRuntimeAdapter;

  switch (runtimeType) {
    case 'browser-worker':
      runtime = new BrowserWorkerRuntime({ debug: options.debug });
      break;

    case 'browser-sync':
      // For now, fall back to worker runtime even for sync mode
      // A true sync runtime would run WASM directly in main thread
      console.warn(
        '[createRuntime] Browser sync mode not fully implemented, using worker'
      );
      runtime = new BrowserWorkerRuntime({ debug: options.debug });
      break;

    case 'node':
      // Use encrypted runtime by default on Node.js for plausible deniability
      if (options.encrypted !== false) {
        runtime = new NodeEncryptedRuntime({
          storagePath: options.storagePath || options.dbPath,
          debug: options.debug,
        });
      } else {
        // Unencrypted mode (faster, no WASM required)
        runtime = new NodeRuntime({
          dbPath: options.dbPath,
          debug: options.debug,
        });
      }
      break;

    default:
      throw new Error(`Unknown runtime type: ${runtimeType}`);
  }

  await runtime.initialize();
  return runtime;
}
