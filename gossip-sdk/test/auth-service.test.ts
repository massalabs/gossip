/**
 * AuthService Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AuthService,
  PUBLIC_KEY_NOT_FOUND_MESSAGE,
} from '../src/services/auth';
import { db } from '../src/db';
import type { IMessageProtocol } from '../src/api/messageProtocol/types';
import type { UserPublicKeys } from '../src/assets/generated/wasm/gossip_wasm';
import { encodeUserId } from '../src/utils/userId';

const TEST_USER_ID = encodeUserId(new Uint8Array(32).fill(7));

function createMockProtocol(
  overrides: Partial<IMessageProtocol> = {}
): IMessageProtocol {
  return {
    fetchMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAnnouncement: vi.fn().mockResolvedValue('1'),
    fetchAnnouncements: vi.fn().mockResolvedValue([]),
    fetchPublicKeyByUserId: vi.fn().mockResolvedValue(''),
    postPublicKey: vi.fn().mockResolvedValue('hash'),
    changeNode: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

function createUserProfile(userId: string) {
  return {
    userId,
    username: 'testuser',
    security: {
      encKeySalt: new Uint8Array(),
      authMethod: 'password' as const,
      mnemonicBackup: {
        encryptedMnemonic: new Uint8Array(),
        createdAt: new Date(),
        backedUp: false,
      },
    },
    session: new Uint8Array(),
    status: 'online' as const,
    lastSeen: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('AuthService', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
  });

  it('returns friendly error when public key is missing', async () => {
    const messageProtocol = createMockProtocol({
      fetchPublicKeyByUserId: vi
        .fn()
        .mockRejectedValue(new Error('Public key not found')),
    });
    const authService = new AuthService(db, messageProtocol);

    const result = await authService.fetchPublicKeyByUserId(TEST_USER_ID);

    expect(result.publicKey).toBeUndefined();
    expect(result.error).toBe(PUBLIC_KEY_NOT_FOUND_MESSAGE);
  });

  it('skips publishing when public key was pushed recently', async () => {
    const messageProtocol = createMockProtocol();
    const authService = new AuthService(db, messageProtocol);
    await db.userProfile.put({
      ...createUserProfile(TEST_USER_ID),
      lastPublicKeyPush: new Date(),
    });

    const publicKeys = {
      to_bytes: () => new Uint8Array([1, 2, 3]),
    } as unknown as UserPublicKeys;

    await authService.ensurePublicKeyPublished(publicKeys, TEST_USER_ID);

    expect(messageProtocol.postPublicKey).not.toHaveBeenCalled();
  });

  it('throws when user profile is missing', async () => {
    const messageProtocol = createMockProtocol();
    const authService = new AuthService(db, messageProtocol);

    const publicKeys = {
      to_bytes: () => new Uint8Array([1, 2, 3]),
    } as unknown as UserPublicKeys;

    await expect(
      authService.ensurePublicKeyPublished(publicKeys, TEST_USER_ID)
    ).rejects.toThrow('User profile not found');
  });
});
