import { describe, it, expect } from 'vitest';
import i18n from '../../../src/i18n';
import {
  validateUsernameFormat,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
} from '../../../src/utils/validation';

describe('validateUsernameFormat (app)', () => {
  it('should reject empty username', () => {
    const result = validateUsernameFormat('');
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      i18n.t('validation:username.required', { lng: 'en' })
    );
  });

  it('should reject username with only whitespace', () => {
    const result = validateUsernameFormat('   ');
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      i18n.t('validation:username.required', { lng: 'en' })
    );
  });

  it('should reject username shorter than 3 characters', () => {
    const result = validateUsernameFormat('ab');
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      i18n.t('validation:username.min_length', {
        min: USERNAME_MIN_LENGTH,
        lng: 'en',
      })
    );
  });

  it('should reject username shorter than 3 characters after trimming', () => {
    const result = validateUsernameFormat('  ab  ');
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      i18n.t('validation:username.min_length', {
        min: USERNAME_MIN_LENGTH,
        lng: 'en',
      })
    );
  });

  it('should accept username with exactly 3 characters', () => {
    const result = validateUsernameFormat('abc');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should accept valid username', () => {
    const result = validateUsernameFormat('validUser');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should accept username with numbers', () => {
    const result = validateUsernameFormat('user123');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should accept username with special characters', () => {
    const result = validateUsernameFormat('user_name-123');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should handle username with leading/trailing whitespace', () => {
    const result = validateUsernameFormat('  user  ');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should reject username with internal spaces', () => {
    const result = validateUsernameFormat('user name');
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      i18n.t('validation:username.no_spaces', { lng: 'en' })
    );
  });

  it('should reject username longer than 35 characters', () => {
    const result = validateUsernameFormat('a'.repeat(36));
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      i18n.t('validation:username.max_length', {
        max: USERNAME_MAX_LENGTH,
        lng: 'en',
      })
    );
  });
});
