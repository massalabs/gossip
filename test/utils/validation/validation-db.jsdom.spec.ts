import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';
import {
  validateUsernameAvailability,
  validateUsernameFormatAndAvailability,
} from '../../../gossip-sdk/src/utils/validation';
import {
  initDb,
  closeSqlite,
  getSqliteDb,
  clearAllTables,
} from '../../../gossip-sdk/src/sqlite';
import * as schema from '../../../gossip-sdk/src/schema';
import { encodeUserId } from '../../../gossip-sdk/src/utils/userId';

const require = createRequire(import.meta.url);
const waSqlitePath = dirname(require.resolve('wa-sqlite/package.json'));
const waSqliteWasm = readFileSync(resolve(waSqlitePath, 'dist/wa-sqlite.wasm'));

const TEST_USER_ID = encodeUserId(new Uint8Array(32).fill(42));

const TEST_PROFILE = {
  userId: TEST_USER_ID,
  username: 'existinguser',
  security: JSON.stringify({
    encKeySalt: [],
    authMethod: 'password',
    mnemonicBackup: {
      encryptedMnemonic: [],
      createdAt: Date.now(),
      backedUp: false,
    },
  }),
  session: new Uint8Array(1),
  status: 'online',
  lastSeen: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('utils/validation.ts - Database tests', () => {
  beforeAll(async () => {
    const wasmBinary = waSqliteWasm.buffer.slice(
      waSqliteWasm.byteOffset,
      waSqliteWasm.byteOffset + waSqliteWasm.byteLength
    );
    await initDb({ wasmBinary });
  });

  afterAll(async () => {
    try {
      await closeSqlite();
    } catch {
      // SQLite might already be closed
    }
  });

  describe('validateUsernameAvailability()', () => {
    beforeEach(async () => {
      await clearAllTables();
    });

    it('should accept username that does not exist', async () => {
      const result = await validateUsernameAvailability('newuser');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject username that already exists', async () => {
      await getSqliteDb().insert(schema.userProfile).values(TEST_PROFILE);

      const result = await validateUsernameAvailability('existinguser');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'This username is already in use. Please choose another.'
      );
    });

    it('should reject username case-insensitively', async () => {
      await getSqliteDb()
        .insert(schema.userProfile)
        .values({ ...TEST_PROFILE, username: 'testuser' });

      const result = await validateUsernameAvailability('TestUser');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'This username is already in use. Please choose another.'
      );
    });

    it('should handle username with whitespace', async () => {
      await getSqliteDb()
        .insert(schema.userProfile)
        .values({ ...TEST_PROFILE, username: 'testuser' });

      const result = await validateUsernameAvailability('  testuser  ');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'This username is already in use. Please choose another.'
      );
    });
  });

  describe('validateUsernameFormatAndAvailability()', () => {
    beforeEach(async () => {
      await clearAllTables();
    });

    it('should reject if format is invalid', async () => {
      const result = await validateUsernameFormatAndAvailability('ab');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Username must be at least 3 characters long');
    });

    it('should reject if format is valid but username exists', async () => {
      await getSqliteDb().insert(schema.userProfile).values(TEST_PROFILE);

      const result =
        await validateUsernameFormatAndAvailability('existinguser');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'This username is already in use. Please choose another.'
      );
    });

    it('should accept if format is valid and username is available', async () => {
      const result = await validateUsernameFormatAndAvailability('newuser123');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});
