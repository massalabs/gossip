/**
 * Plausibly Deniable Multi-Session Encrypted Storage
 *
 * This library implements a cryptographic storage system that enables multiple
 * encrypted sessions while maintaining plausible deniability about their existence.
 *
 * ## Features
 * - Multiple password-protected sessions in a single storage
 * - Plausible deniability: no way to prove hidden sessions exist
 * - Timing-safe operations to prevent side-channel attacks
 * - Platform-agnostic via adapter pattern
 *
 * ## Usage
 *
 * ```typescript
 * import { DeniableStorage, WebAdapter } from './storage/deniable';
 *
 * const storage = new DeniableStorage({
 *   adapter: new WebAdapter('my-storage'),
 * });
 *
 * await storage.initialize();
 *
 * // Create a session
 * await storage.createSession('password123', data);
 *
 * // Unlock a session
 * const result = await storage.unlockSession('password123');
 * console.log(result.data);
 *
 * // Update a session
 * await storage.updateSession('password123', newData);
 *
 * // Delete a session (secure wipe)
 * await storage.deleteSession('password123');
 * ```
 *
 * @module deniable-storage
 */

// Public API exports
export { DeniableStorage } from './DeniableStorage';

// Types
export type {
  DeniableStorageConfig,
  StorageAdapter,
  UnlockResult,
  StorageStats,
} from './types';

export { DeniableStorageError, DeniableStorageException } from './types';

// Adapters
export { WebAdapter } from './adapters/WebAdapter';
export { CapacitorAdapter } from './adapters/CapacitorAdapter';
