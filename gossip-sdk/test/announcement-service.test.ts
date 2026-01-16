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
});
