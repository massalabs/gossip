/**
 * Validation utility tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  validatePassword,
  validateUsernameFormat,
  validateUsernameAvailability,
  validateUsernameFormatAndAvailability,
  validateUserIdFormat,
} from '../src/utils/validation';
import { db } from '../src/db';
import { encodeUserId } from '../src/utils/userId';

const ownerUserId = encodeUserId(new Uint8Array(32).fill(13));

describe('validation utilities', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
  });

  it('validates password requirements', () => {
    expect(validatePassword('')).toEqual({
      valid: false,
      error: 'Password is required',
    });
    expect(validatePassword('short')).toEqual({
      valid: false,
      error: 'Password must be at least 8 characters long',
    });
    expect(validatePassword('longenough')).toEqual({ valid: true });
  });

  it('validates username format', () => {
    expect(validateUsernameFormat('')).toEqual({
      valid: false,
      error: 'Username is required',
    });
    expect(validateUsernameFormat('ab')).toEqual({
      valid: false,
      error: 'Username must be at least 3 characters long',
    });
    expect(validateUsernameFormat('a b')).toEqual({
      valid: false,
      error: 'Username cannot contain spaces',
    });
    expect(validateUsernameFormat('validname')).toEqual({ valid: true });
  });

  it('checks username availability case-insensitively', async () => {
    await db.userProfile.put({
      userId: ownerUserId,
      username: 'Alice',
      security: {
        encKeySalt: new Uint8Array(),
        authMethod: 'password',
        mnemonicBackup: {
          encryptedMnemonic: new Uint8Array(),
          createdAt: new Date(),
          backedUp: false,
        },
      },
      session: new Uint8Array(),
      status: 'online',
      lastSeen: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await validateUsernameAvailability('alice', db);
    expect(result.valid).toBe(false);
  });

  it('validates username format and availability', async () => {
    const invalid = await validateUsernameFormatAndAvailability('ab', db);
    expect(invalid.valid).toBe(false);

    const valid = await validateUsernameFormatAndAvailability('validname', db);
    expect(valid.valid).toBe(true);
  });

  it('validates userId format', () => {
    expect(validateUserIdFormat('invalid')).toEqual({
      valid: false,
      error: 'Invalid format — must be a valid user ID',
    });
  });
});
