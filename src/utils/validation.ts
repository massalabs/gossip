import type { ValidationResult } from '@massalabs/gossip-sdk';
import i18n from '../i18n';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 35;

/**
 * App-defined username rules (format only — availability is checked via the SDK).
 */
export function validateUsernameFormat(value: string): ValidationResult {
  const trimmed = value.trim();

  if (!trimmed) {
    return {
      valid: false,
      error: i18n.t('validation:username.required'),
    };
  }

  if (/\s/.test(trimmed)) {
    return {
      valid: false,
      error: i18n.t('validation:username.no_spaces'),
    };
  }

  if (trimmed.length < USERNAME_MIN_LENGTH) {
    return {
      valid: false,
      error: i18n.t('validation:username.min_length', {
        min: USERNAME_MIN_LENGTH,
      }),
    };
  }

  if (trimmed.length > USERNAME_MAX_LENGTH) {
    return {
      valid: false,
      error: i18n.t('validation:username.max_length', {
        max: USERNAME_MAX_LENGTH,
      }),
    };
  }

  return { valid: true };
}

const DEFAULT_USERNAME_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * Placeholder username for accounts created without asking for one.
 * Onboarding no longer collects a username; the user renames the account
 * from Settings. It must stay non-empty because backup previews reject
 * profiles with an empty username.
 */
export function generateDefaultUsername(): string {
  const random = crypto.getRandomValues(new Uint8Array(4));
  let suffix = '';
  for (const byte of random) {
    suffix +=
      DEFAULT_USERNAME_ALPHABET[byte % DEFAULT_USERNAME_ALPHABET.length];
  }
  return `user-${suffix}`;
}
