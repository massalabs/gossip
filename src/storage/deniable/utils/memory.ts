/**
 * Secure memory operations
 *
 * This module provides utilities for securely wiping sensitive data
 * from memory after use.
 *
 * @module utils/memory
 */

/**
 * Securely wipes a Uint8Array by overwriting it with random data
 *
 * This provides defense against:
 * - Memory dumps
 * - Cold boot attacks
 * - Memory residue after GC
 *
 * Strategy: Overwrite with random data multiple times to prevent
 * recovery via memory forensics.
 *
 * @param buffer - The buffer to wipe
 *
 * @example
 * ```typescript
 * const sensitiveData = new TextEncoder().encode('secret');
 * // ... use data ...
 * secureWipe(sensitiveData);
 * // sensitiveData is now filled with random bytes
 * ```
 */
export function secureWipe(buffer: Uint8Array): void {
  if (!buffer || buffer.length === 0) {
    return;
  }

  // Multiple overwrite passes to prevent memory recovery
  // Pass 1: Random data
  crypto.getRandomValues(buffer);

  // Pass 2: Zeros
  buffer.fill(0);

  // Pass 3: Ones
  buffer.fill(0xff);

  // Pass 4: Random again
  crypto.getRandomValues(buffer);

  // Final pass: Zeros
  buffer.fill(0);
}

/**
 * Securely zeros a Uint8Array
 *
 * Simpler than secureWipe, but still prevents basic memory residue.
 * Use this when performance is critical and multiple passes aren't needed.
 *
 * @param buffer - The buffer to zero
 *
 * @example
 * ```typescript
 * const key = new Uint8Array(32);
 * // ... use key ...
 * secureZero(key);
 * ```
 */
export function secureZero(buffer: Uint8Array): void {
  if (!buffer || buffer.length === 0) {
    return;
  }

  buffer.fill(0);
}

/**
 * Creates a secure context for working with sensitive data
 *
 * Automatically wipes the buffer when the callback completes or throws.
 *
 * @param size - Size of the buffer to allocate
 * @param callback - Function to execute with the buffer
 * @returns The result of the callback
 *
 * @example
 * ```typescript
 * const result = await withSecureBuffer(32, async (buffer) => {
 *   // Use buffer for sensitive operations
 *   crypto.getRandomValues(buffer);
 *   return processData(buffer);
 * });
 * // buffer is automatically wiped
 * ```
 */
export async function withSecureBuffer<T>(
  size: number,
  callback: (buffer: Uint8Array) => Promise<T> | T
): Promise<T> {
  const buffer = new Uint8Array(size);

  try {
    return await callback(buffer);
  } finally {
    secureWipe(buffer);
  }
}

/**
 * Wipes multiple buffers in sequence
 *
 * @param buffers - Buffers to wipe
 *
 * @example
 * ```typescript
 * wipeAll(key, nonce, plaintext, ciphertext);
 * ```
 */
export function wipeAll(...buffers: Uint8Array[]): void {
  for (const buffer of buffers) {
    secureWipe(buffer);
  }
}
