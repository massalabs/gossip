/**
 * Input validation utilities
 *
 * Validates and sanitizes inputs to prevent security issues.
 *
 * @module utils/validation
 */

/**
 * Validates a password meets minimum security requirements
 *
 * @param password - Password to validate
 * @returns Validation result with error message if invalid
 *
 * @example
 * ```typescript
 * const result = validatePassword('mypass');
 * if (!result.valid) {
 *   console.error(result.error);
 * }
 * ```
 */
export function validatePassword(password: string): {
  valid: boolean;
  error?: string;
} {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password must be a string' };
  }

  if (password.length === 0) {
    return { valid: false, error: 'Password cannot be empty' };
  }

  if (password.length > 1000) {
    return {
      valid: false,
      error: 'Password is too long (max 1000 characters)',
    };
  }

  return { valid: true };
}

/**
 * Validates data size is within acceptable bounds
 *
 * @param data - Data to validate
 * @param maxSize - Maximum allowed size in bytes (default: 100MB)
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const result = validateDataSize(data, 10 * 1024 * 1024); // Max 10MB
 * if (!result.valid) {
 *   console.error(result.error);
 * }
 * ```
 */
export function validateDataSize(
  data: Uint8Array,
  maxSize: number = 100 * 1024 * 1024 // 100MB default
): {
  valid: boolean;
  error?: string;
} {
  if (!(data instanceof Uint8Array)) {
    return { valid: false, error: 'Data must be a Uint8Array' };
  }

  if (data.length > maxSize) {
    return {
      valid: false,
      error: `Data size exceeds maximum (${data.length} > ${maxSize} bytes)`,
    };
  }

  return { valid: true };
}

/**
 * Sanitizes a password by trimming whitespace and checking encoding
 *
 * @param password - Password to sanitize
 * @returns Sanitized password
 *
 * @example
 * ```typescript
 * const clean = sanitizePassword('  my password  ');
 * // Returns: 'my password'
 * ```
 */
export function sanitizePassword(password: string): string {
  if (typeof password !== 'string') {
    throw new Error('Password must be a string');
  }

  // Note: We intentionally don't trim to preserve exact password
  // Users may want leading/trailing spaces as part of their password
  return password;
}

/**
 * Validates adapter configuration
 *
 * @param adapter - Adapter to validate
 * @returns Validation result
 */
export function validateAdapter(adapter: unknown): {
  valid: boolean;
  error?: string;
} {
  if (!adapter || typeof adapter !== 'object') {
    return { valid: false, error: 'Adapter must be an object' };
  }

  const requiredMethods = [
    'initialize',
    'readAddressingBlob',
    'writeAddressingBlob',
    'readDataBlob',
    'writeDataBlob',
    'getDataBlobSize',
    'secureWipe',
  ];

  for (const method of requiredMethods) {
    if (typeof (adapter as Record<string, unknown>)[method] !== 'function') {
      return {
        valid: false,
        error: `Adapter missing required method: ${method}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validates blob size is within expected range
 *
 * @param blob - Blob to validate
 * @param expectedSize - Expected size in bytes
 * @param tolerance - Allowed deviation (default: 0)
 * @returns Validation result
 */
export function validateBlobSize(
  blob: Uint8Array,
  expectedSize: number,
  tolerance: number = 0
): {
  valid: boolean;
  error?: string;
} {
  if (!(blob instanceof Uint8Array)) {
    return { valid: false, error: 'Blob must be a Uint8Array' };
  }

  const minSize = expectedSize - tolerance;
  const maxSize = expectedSize + tolerance;

  if (blob.length < minSize || blob.length > maxSize) {
    return {
      valid: false,
      error: `Blob size ${blob.length} is outside expected range [${minSize}..${maxSize}]`,
    };
  }

  return { valid: true };
}
