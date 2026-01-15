/**
 * Common type utilities for the SDK
 */

export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };
