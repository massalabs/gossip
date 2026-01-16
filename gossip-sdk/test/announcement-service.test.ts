/**
 * AnnouncementService Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnnouncementService } from '../src/services/announcement';
import { db } from '../src/db';
import type { IMessageProtocol } from '../src/api/messageProtocol/types';
import type { SessionModule } from '../src/wasm/session';

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

const fakeSession = {} as SessionModule;

describe('AnnouncementService', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
  });

  it('returns success and counter when sendAnnouncement succeeds', async () => {
    const messageProtocol = createMockProtocol({
      sendAnnouncement: vi.fn().mockResolvedValue('42'),
    });
    const service = new AnnouncementService(db, messageProtocol, fakeSession);

    const result = await service.sendAnnouncement(new Uint8Array([1, 2, 3]));

    expect(result.success).toBe(true);
    expect(result.counter).toBe('42');
  });

  it('returns error when sendAnnouncement fails', async () => {
    const messageProtocol = createMockProtocol({
      sendAnnouncement: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const service = new AnnouncementService(db, messageProtocol, fakeSession);

    const result = await service.sendAnnouncement(new Uint8Array([1, 2, 3]));

    expect(result.success).toBe(false);
    expect(result.error).toBe('network error');
  });

  it('keeps pending announcements when processing fails', async () => {
    const messageProtocol = createMockProtocol();
    const session = { userIdEncoded: 'gossip1test' } as SessionModule;
    const service = new AnnouncementService(db, messageProtocol, session);

    await db.userProfile.put({
      userId: session.userIdEncoded,
      username: 'test',
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

    await db.pendingAnnouncements.add({
      announcement: new Uint8Array([1, 2, 3]),
      fetchedAt: new Date(),
      counter: '1',
    });

    (
      service as unknown as {
        _processIncomingAnnouncement?: (data: Uint8Array) => unknown;
      }
    )._processIncomingAnnouncement = vi
      .fn()
      .mockRejectedValue(new Error('decode failed'));

    await service.fetchAndProcessAnnouncements();

    const remaining = await db.pendingAnnouncements.toArray();
    expect(remaining.length).toBe(1);
  });
});
