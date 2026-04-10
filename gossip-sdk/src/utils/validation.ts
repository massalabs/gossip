/**
 * Validation Utilities
 *
 * Functions for validating user input like usernames, passwords, and user IDs.
 */

import { isValidUserId } from './userId.js';

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
 * Validate a username is available (not already in use)
 *




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
