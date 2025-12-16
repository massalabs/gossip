/**
 * SDK Test Helpers
 *
 * Helper functions for creating test data and utilities
 */

import type { Contact, Discussion, Message, UserProfile } from '../../src/db';
import type { UserPublicKeys } from '../../src/assets/generated/wasm/gossip_wasm';
import {
  MessageType,
  MessageDirection,
  MessageStatus,
  DiscussionStatus,
  DiscussionDirection,
} from '../../src/db';

/**
 * Create a test contact
 */
export function createTestContact(
  ownerUserId: string,
  userId: string,
  name: string,
  publicKeys: UserPublicKeys
): Omit<Contact, 'id'> {
  return {
    ownerUserId,
    userId,
    name,
    publicKeys: publicKeys.to_bytes(),
    isOnline: false,
    lastSeen: new Date(),
    createdAt: new Date(),
  };
}

/**
 * Create a test discussion
 */
export function createTestDiscussion(
  ownerUserId: string,
  contactUserId: string,
  status: DiscussionStatus = DiscussionStatus.ACTIVE,
  direction: DiscussionDirection = DiscussionDirection.INITIATED
): Omit<Discussion, 'id'> {
  return {
    ownerUserId,
    contactUserId,
    direction,
    status,
    unreadCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Create a test message
 */
export function createTestMessage(
  ownerUserId: string,
  contactUserId: string,
  content: string,
  direction: MessageDirection = MessageDirection.OUTGOING,
  status: MessageStatus = MessageStatus.SENT
): Omit<Message, 'id'> {
  return {
    ownerUserId,
    contactUserId,
    content,
    type: MessageType.TEXT,
    direction,
    status,
    timestamp: new Date(),
  };
}

/**
 * Create a test user profile
 */
export function createTestUserProfile(
  userId: string,
  username: string
): Omit<UserProfile, 'session'> {
  return {
    userId,
    username,
    security: {
      encKeySalt: new Uint8Array(32),
      authMethod: 'password',
      mnemonicBackup: {
        encryptedMnemonic: new Uint8Array(64),
        createdAt: new Date(),
        backedUp: false,
      },
    },
    status: 'online',
    lastSeen: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Wait for a condition to be true
 */
export function waitFor(
  condition: () => boolean,
  timeout: number = 5000,
  interval: number = 100
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error('Timeout waiting for condition'));
      } else {
        setTimeout(check, interval);
      }
    };
    check();
  });
}
