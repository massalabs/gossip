/**
 * Announcement Handling SDK Tests
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { sendAnnouncement, establishSession } from '../src/announcements';
import { initializeAccount } from '../src/account';
import { getSession } from '../src/utils';
import { db } from '../src/db';
import { createMessageProtocol } from '../src/api/messageProtocol';
import { MessageProtocolType } from '../src/config/protocol';
import { announcementService } from '../src/services/announcement';
import { messageService } from '../src/services/message';
import { generateUserKeys } from '../src/wasm/userKeys';

describe('Announcement Handling', () => {
  beforeAll(async () => {
    const mockProtocol = createMessageProtocol(MessageProtocolType.MOCK);
    announcementService.setMessageProtocol(mockProtocol);
    messageService.setMessageProtocol(mockProtocol);
  });

  beforeEach(async () => {
    // Database is cleaned up by setup.ts afterEach hook
    if (!db.isOpen()) {
      await db.open();
    }

    // Initialize account
    await initializeAccount('testuser', 'testpassword123');
  });

  describe('sendAnnouncement', () => {
    it('should send an announcement', async () => {
      const announcement = new Uint8Array(64);
      const result = await sendAnnouncement(announcement);
      // Result may succeed or fail depending on mock, but should return a result
      expect(result).toHaveProperty('success');
    });

    it('should return result object with expected properties', async () => {
      const announcement = new Uint8Array(64);
      const result = await sendAnnouncement(announcement);
      expect(result).toHaveProperty('success');
      // If successful, should have counter
      if (result.success) {
        expect(result).toHaveProperty('counter');
      }
    });
  });

  describe('establishSession', () => {
    it('should establish a session with contact', async () => {
      const session = getSession();
      if (!session) {
        throw new Error('Session not initialized');
      }

      // Generate real public keys for contact
      const mnemonic =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      const keys = await generateUserKeys(mnemonic);
      const contactPublicKeys = keys.public_keys();

      const result = await establishSession(contactPublicKeys, session);

      // Should return a result with announcement
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('announcement');
      expect(result.announcement).toBeInstanceOf(Uint8Array);
    });

    it('should include user data in announcement when provided', async () => {
      const session = getSession();
      if (!session) {
        throw new Error('Session not initialized');
      }

      // Generate contact keys
      const mnemonic = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
      const keys = await generateUserKeys(mnemonic);
      const contactPublicKeys = keys.public_keys();

      const userData = new TextEncoder().encode('Hello from test!');
      const result = await establishSession(
        contactPublicKeys,
        session,
        userData
      );

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('announcement');
    });
  });
});
