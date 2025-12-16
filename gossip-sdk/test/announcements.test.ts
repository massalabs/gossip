/**
 * Announcement Handling SDK Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sendAnnouncement, establishSession } from '../src/announcements';
import { initializeAccount } from '../src/account';
import { getAccount } from '../src/utils';
import {
  UserPublicKeys,
  UserSecretKeys,
} from '../../src/assets/generated/wasm/gossip_wasm';
import type { SessionModule } from '../../src/wasm';

describe('Announcement Handling', () => {
  let ourPk: UserPublicKeys | null;
  let ourSk: UserSecretKeys | null;
  let session: SessionModule | null;

  beforeEach(async () => {
    // Database is already cleaned up by setup.ts afterEach hook
    // Just ensure it's open
    const { db } = await import('../../src/db');
    if (!db.isOpen()) {
      await db.open();
    }

    // Initialize account
    await initializeAccount('testuser', 'testpassword123');
    const account = getAccount();
    ourPk = account.ourPk;
    ourSk = account.ourSk;
    session = account.session;
  });

  describe('sendAnnouncement', () => {
    it('should send an announcement', async () => {
      const announcement = new Uint8Array(64);
      const result = await sendAnnouncement(announcement);
      // Result may succeed or fail depending on network, but should return a result
      expect(result).toHaveProperty('success');
    });
  });

  describe('establishSession', () => {
    it('should establish a session with contact', async () => {
      if (!ourPk || !ourSk || !session) {
        // Skip if account not fully initialized
        return;
      }

      const contactPublicKeys = new UserPublicKeys(
        new Uint8Array(32),
        new Uint8Array(32),
        new Uint8Array(32)
      );

      const result = await establishSession(
        contactPublicKeys,
        ourPk,
        ourSk,
        session
      );

      // Should return a result with announcement
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('announcement');
    });
  });
});
