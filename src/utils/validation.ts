import { db } from '../db';
import { isValidUserId } from './userId';

export type ValidationResult =
  | { valid: true; error?: never }
  | { valid: false; error: string };

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

export function validateUsernameFormat(value: string): ValidationResult {
  if (!value || value.trim().length === 0) {
    return { valid: false, error: 'Username is required' };
  }

  if (value.length < 3) {
    return {
      valid: false,
      error: 'Username must be at least 3 characters long',
    };
  }

  return { valid: true };
}

export async function validateUsernameAvailability(
  value: string
): Promise<ValidationResult> {
  try {
    if (!db.isOpen()) {
      await db.open();
    }

    const existingProfile = await db.userProfile
      .filter(
        profile => profile.username.toLowerCase() === value.trim().toLowerCase()
      )
      .first();

    if (existingProfile) {
      return {
        valid: false,
        error: 'This username is already in use. Please choose another.',
      };
    }

    return { valid: true };
  } catch (error) {
    // TODO: It might be a problem because it's not a validation error
    return {
      valid: false,
      error:
        error instanceof Error
          ? error.message
          : 'Unable to verify username availability. Please try again.',
    };
  }
}

export async function validateUsernameFormatAndAvailability(
  value: string
): Promise<ValidationResult> {
  const result = validateUsernameFormat(value);
  if (!result.valid) {
    return result;
  }

  return await validateUsernameAvailability(value);
}

export function validateUserIdFormat(value: string): ValidationResult {
  const userId = value.trim();

  if (!isValidUserId(userId)) {
    return {
      valid: false,
      error: 'Invalid format — must be a complete gossip1... address',
    };
  }

  return { valid: true };
}
