/**
 * Validation Utilities
 *
 * Functions for validating user input like usernames, passwords, and user IDs.
 */

import { isValidUserId } from './userId';
import { getUserProfileByUsernameLower } from '../queries';

export type ValidationResult =
  | { valid: true; error?: never }
  | { valid: false; error: string };

/**
 * Validate a password meets requirements
 *
 * @param value - The password to validate
 * @returns Validation result
 */
export function validatePassword(value: string): ValidationResult {
  if (!value || value.trim().length === 0) {
    return { valid: false, error: 'Password is required' };
  }

  if (value.length < 8) {
    return {
      valid: false,
      error: 'Password must be at least 8 characters long',
    };
  }

  return { valid: true };
}

/**
 * Validate a username format (without checking availability)
 *
 * @param value - The username to validate
 * @returns Validation result
 */
export function validateUsernameFormat(value: string): ValidationResult {
  const trimmed = value.trim();

  if (!trimmed) {
    return { valid: false, error: 'Username is required' };
  }

  // Disallow any whitespace inside the username (single token only)
  if (/\s/.test(trimmed)) {
    return {
      valid: false,
      error: 'Username cannot contain spaces',
    };
  }

  if (trimmed.length < 3) {
    return {
      valid: false,
      error: 'Username must be at least 3 characters long',
    };
  }

  return { valid: true };
}

/**
 * Validate a username is available (not already in use)
 *
 * @param value - The username to check
 * @returns Validation result
 */
export async function validateUsernameAvailability(
  value: string
): Promise<ValidationResult> {
  try {
    const existingProfile = await getUserProfileByUsernameLower(value);

    if (existingProfile) {
      return {
        valid: false,
        error: 'This username is already in use. Please choose another.',
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error:
        error instanceof Error
          ? error.message
          : 'Unable to verify username availability. Please try again.',
    };
  }
}

/**
 * Validate a username format and availability
 *
 * @param value - The username to validate
 * @param db - Database instance
 * @returns Validation result
 */
export async function validateUsernameFormatAndAvailability(
  value: string
): Promise<ValidationResult> {
  const result = validateUsernameFormat(value);
  if (!result.valid) {
    return result;
  }

  return await validateUsernameAvailability(value);
}

/**
 * Validate a user ID format (Bech32 gossip1... format)
 *
 * @param value - The user ID to validate
 * @returns Validation result
 */
export function validateUserIdFormat(value: string): ValidationResult {
  const userId = value.trim();

  if (!isValidUserId(userId)) {
    return {
      valid: false,
      error: 'Invalid format — must be a valid user ID',
    };
  }

  return { valid: true };
}
