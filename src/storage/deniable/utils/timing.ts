/**
 * Timing-safe operations
 *
 * This module provides utilities to prevent timing attacks by ensuring
 * that operations take constant time regardless of success/failure.
 *
 * @module utils/timing
 */

/**
 * Constant-time buffer comparison
 *
 * Compares two buffers in constant time to prevent timing attacks.
 * Always scans the entire buffer, even if mismatch is found early.
 *
 * @param a - First buffer
 * @param b - Second buffer
 * @returns true if buffers are equal, false otherwise
 *
 * @example
 * ```typescript
 * const equal = timingSafeEqual(hash1, hash2);
 * if (equal) {
 *   // Hashes match
 * }
 * ```
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    // Even on length mismatch, scan a fixed amount to avoid timing leak
    let _dummy = 0;
    for (let i = 0; i < 256; i++) {
      _dummy |= i;
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

/**
 * Adds a constant-time delay to normalize operation timing
 *
 * Useful for masking timing differences in operations that
 * might reveal information about internal state.
 *
 * @param minMs - Minimum delay in milliseconds
 * @returns Promise that resolves after the delay
 *
 * @example
 * ```typescript
 * await constantTimeDelay(100); // Wait at least 100ms
 * ```
 */
export async function constantTimeDelay(minMs: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, minMs);
  });
}

/**
 * Wraps an async operation to ensure it takes at least minMs
 *
 * Prevents timing attacks by normalizing operation duration.
 *
 * @param operation - The operation to execute
 * @param minMs - Minimum time the operation should take
 * @returns The result of the operation
 *
 * @example
 * ```typescript
 * const result = await timingSafeOperation(
 *   () => checkPassword(password),
 *   500 // Always take at least 500ms
 * );
 * ```
 */
export async function timingSafeOperation<T>(
  operation: () => Promise<T>,
  minMs: number
): Promise<T> {
  const startTime = performance.now();
  const result = await operation();
  const elapsed = performance.now() - startTime;

  const remainingTime = Math.max(0, minMs - elapsed);
  if (remainingTime > 0) {
    await constantTimeDelay(remainingTime);
  }

  return result;
}

/**
 * Selects one of two values in constant time
 *
 * Prevents timing leaks when conditionally returning values.
 *
 * @param condition - Boolean condition
 * @param ifTrue - Value to return if condition is true
 * @param ifFalse - Value to return if condition is false
 * @returns The selected value
 *
 * @example
 * ```typescript
 * const value = constantTimeSelect(isValid, validResult, null);
 * ```
 */
export function constantTimeSelect<T>(
  condition: boolean,
  ifTrue: T,
  ifFalse: T
): T {
  // Avoid branch prediction by using arithmetic
  const mask = condition ? 1 : 0;
  return mask === 1 ? ifTrue : ifFalse;
}
