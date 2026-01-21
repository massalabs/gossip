/**
 * SDK Test Helpers
 *
 * Helper functions for creating test data and utilities.
 */

import type { Contact, Discussion, Message, UserProfile } from '../src/db';
import {
  UserPublicKeys,
  UserSecretKeys,
  UserKeys,
} from '../src/assets/generated/wasm/gossip_wasm';
import { generateUserKeys } from '../src/wasm/userKeys';
import {
  MessageType,
  MessageDirection,
  MessageStatus,
  DiscussionStatus,
  DiscussionDirection,
} from '../src/db';
import { encodeUserId } from '../src/utils/userId';
import { MockSessionModule } from './mocks';

/**
 * Create a test contact object (without id).
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
 * Create a test discussion object (without id).
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
 * Create a test message object (without id).
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
 * Create a test user profile object (without session).
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
 * Wait for a condition to be true.
 */
export function waitFor(
  condition: () => boolean,
  timeout = 5000,
  interval = 100
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

/**
 * Wait for a specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Initialize a session mock with provided keys.
 * This helper:
 * - Encodes the user ID from public keys
 * - Creates and configures a MockSessionModule
 * - Returns the configured session
 */
export function initializeSessionMock(
  publicKeys: UserPublicKeys,
  secretKeys: UserSecretKeys
): MockSessionModule {
  const userIdEncoded = encodeUserId(publicKeys.derive_id());
  const session = new MockSessionModule(publicKeys, secretKeys);
  session.userIdEncoded = userIdEncoded;

  return session;
}

/**
 * Initialize a session mock, generating keys if not provided.
 * This helper:
 * - Generates keys using WASM if not provided
 * - Encodes the user ID from public keys
 * - Creates and configures a MockSessionModule
 * - Returns the configured session
 */
export async function initializeSessionMockWithOptionalKeys(
  publicKeys?: UserPublicKeys,
  secretKeys?: UserSecretKeys
): Promise<MockSessionModule> {
  let finalPublicKeys: UserPublicKeys;
  let finalSecretKeys: UserSecretKeys;

  if (!publicKeys || !secretKeys) {
    // Generate keys using WASM
    const passphrase = `test-passphrase-${Date.now()}-${Math.random()}`;
    let userKeys: UserKeys | null = null;
    try {
      userKeys = await generateUserKeys(passphrase);
      if (!userKeys) {
        throw new Error(
          'Failed to generate user keys for MockSessionModule: userKeys is undefined or null'
        );
      }
      // Extract keys before freeing the parent object
      // The extracted keys are independent objects
      finalPublicKeys = userKeys.public_keys();
      finalSecretKeys = userKeys.secret_keys();
      if (!finalPublicKeys || !finalSecretKeys) {
        throw new Error(
          'Failed to extract user keys for MockSessionModule: extracted keys are undefined or null'
        );
      }
    } finally {
      // Free the UserKeys object to prevent memory leaks, even if extraction failed
      if (userKeys) {
        userKeys.free();
      }
    }
  } else {
    finalPublicKeys = publicKeys;
    finalSecretKeys = secretKeys;
  }

  const userIdEncoded = encodeUserId(finalPublicKeys.derive_id());
  const session = new MockSessionModule(finalPublicKeys, finalSecretKeys);
  session.userIdEncoded = userIdEncoded;

  return session;
}
