/**
 * MessageService Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageService } from '../src/services/message';
import { db, MessageStatus, MessageDirection, MessageType } from '../src/db';
import type { IMessageProtocol } from '../src/api/messageProtocol/types';
import type { SessionModule } from '../src/wasm/session';
import { encodeUserId } from '../src/utils/userId';

const OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(11));
const CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(12));

function createMockProtocol(): IMessageProtocol {
  return {
    fetchMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAnnouncement: vi.fn().mockResolvedValue('1'),
    fetchAnnouncements: vi.fn().mockResolvedValue([]),
    fetchPublicKeyByUserId: vi.fn().mockResolvedValue(''),
    postPublicKey: vi.fn().mockResolvedValue('hash'),
    changeNode: vi.fn().mockResolvedValue({ success: true }),
  };
}

const fakeSession = {} as SessionModule;

describe('MessageService', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
  });

  it('finds message by seeker', async () => {
    const seeker = new Uint8Array(32).fill(5);
    await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker,
    });

    const service = new MessageService(db, createMockProtocol(), fakeSession);
    const message = await service.findMessageBySeeker(seeker, OWNER_USER_ID);

    expect(message).toBeDefined();
    expect(message?.content).toBe('Hello');
  });

  it('returns undefined for missing seeker', async () => {
    const seeker = new Uint8Array(32).fill(9);

    const service = new MessageService(db, createMockProtocol(), fakeSession);
    const message = await service.findMessageBySeeker(seeker, OWNER_USER_ID);

    expect(message).toBeUndefined();
  });
});
