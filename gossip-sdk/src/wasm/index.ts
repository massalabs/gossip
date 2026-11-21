/**
 * WASM Module Exports
 *
 * This file provides a clean interface for importing WASM modules
 * and related functionality.
 */

// Export modules
export {
  SessionModule,
  sessionStatusToString,
  SESSION_PACKET_MAX_BYTES,
  SESSION_OVERHEAD_MAX_BYTES,
  SESSION_MESSAGE_MAX_BYTES,
  SessionMessageTooLargeError,
} from './session.js';
export type { SessionConfigSource } from './session.js';

// Export initialization functions
export {
  initializeWasm,
  ensureWasmInitialized,
  startWasmInitialization,
} from './loader.js';

export * from './encryption.js';
export * from './userKeys.js';

export {
  SessionStatus,
  SessionConfig,
  UserPublicKeys,
  UserSecretKeys,
  SendMessageOutput,
  ReceiveMessageOutput,
  AnnouncementResult,
} from './bindings.js';
