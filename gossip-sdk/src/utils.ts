/**
 * SDK Utilities
 *
 * Helper functions for SDK configuration.
 *
 * @example
 * ```typescript
 * import { configureSdk } from 'gossip-sdk';
 *
 * configureSdk({
 *   db,
 *   protocolBaseUrl: 'https://api.example.com',
 * });
 * ```
 */

import type { GossipDatabase } from './db.js';
import { setDb } from './db.js';
import { startWasmInitialization } from './wasm/loader.js';
import { setProtocolBaseUrl } from './config/protocol.js';

export interface SdkRuntimeConfig {
  db?: GossipDatabase;
  protocolBaseUrl?: string;
}

/**
 * Configure runtime adapters for the SDK.
 * Call this once during application startup.
 *
 * This also starts WASM initialization in the background.
 *
 * Note: Service instances (MessageService, AnnouncementService, etc.)
 * should be created by the app with the required dependencies.
 */
export function configureSdk(config: SdkRuntimeConfig): void {
  if (config.db) {
    setDb(config.db);
  }

  if (config.protocolBaseUrl) {
    setProtocolBaseUrl(config.protocolBaseUrl);
  }

  // Start WASM initialization in the background (non-blocking)
  startWasmInitialization();
}
