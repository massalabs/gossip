/**
 * SDK Test Utilities
 *
 * Helper functions for creating test data and utilities.
 * Uses real WASM SessionModule - no mocks needed.
 */

import type { Contact, Message, UserProfile } from '../src/db';
import { UserPublicKeys, UserKeys } from '../src/wasm/bindings';
import { generateUserKeys } from '../src/wasm/userKeys';
import { SessionModule } from '../src/wasm/session';
import { MessageType, MessageDirection, MessageStatus } from '../src/db';
import { GossipSdkImpl } from '../src/gossipSdk';
import { SessionStatus } from '../src/assets/generated/wasm/gossip_wasm';

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
 * Test session data structure returned by createTestSession.
 */
export interface TestSessionData {
  session: SessionModule;
  userKeys: UserKeys;
}

/**
 * Create a real SessionModule using WASM.
 * This creates a fully functional session with real crypto.
 *
 * @param passphrase - Optional passphrase for key generation (defaults to random)
 * @param onPersist - Optional persistence callback
 * @returns Object containing session and userKeys (remember to call cleanupTestSession when done)
 */
export async function createTestSession(
  passphrase?: string,
  onPersist?: () => Promise<void>
): Promise<TestSessionData> {
  const finalPassphrase =
    passphrase ?? `test-passphrase-${Date.now()}-${Math.random()}`;
  const userKeys = await generateUserKeys(finalPassphrase);

  if (!userKeys) {
    throw new Error('Failed to generate user keys for test session');
  }

  const session = new SessionModule(userKeys, onPersist);
  return { session, userKeys };
}

/**
 * Create a pair of test sessions (e.g., Alice and Bob) for e2e testing.
 * Both sessions use real WASM crypto.
 *
 * @returns Object containing both sessions and their keys
 */
export async function createTestSessionPair(): Promise<{
  alice: TestSessionData;
  bob: TestSessionData;
}> {
  const [alice, bob] = await Promise.all([
    createTestSession(`alice-test-key-${Date.now()}`),
    createTestSession(`bob-test-key-${Date.now()}`),
  ]);

  return { alice, bob };
}

/**
 * Helper to cleanup test sessions and free WASM memory.
 * Call this in afterEach/afterAll.
 */
export function cleanupTestSession(sessionData: TestSessionData): void {
  try {
    sessionData.session.cleanup();
  } catch {
    // Session might already be cleaned up
  }
  try {
    sessionData.userKeys.free();
  } catch {
    // Keys might already be freed
  }
}

/**
 * Helper to cleanup multiple test sessions.
 */
export function cleanupTestSessions(sessions: TestSessionData[]): void {
  sessions.forEach(cleanupTestSession);
}

/**
 * Setup a discussion session between two SDK instances.
 * The first SDK initiates the discussion, the second accepts it.
 *
 * @param initiatorSdk - SDK instance that will start the discussion
 * @param acceptorSdk - SDK instance that will accept the discussion
 * @param initiatorContactName - Name for the contact from initiator's perspective (default: 'Contact')
 * @param acceptorContactName - Name for the contact from acceptor's perspective (default: 'Contact')
 * @param announcementMessage - Optional message to include in the announcement
 * @returns Promise that resolves when the session is fully established
 */
export async function setupSession(
  initiatorSdk: GossipSdkImpl,
  acceptorSdk: GossipSdkImpl,
  initiatorContactName: string = 'Contact 1',
  acceptorContactName: string = 'Contact 2',
  announcementMessage?: string
): Promise<void> {
  // Create contacts for both sides
  await initiatorSdk.contacts.add(
    initiatorSdk.userId,
    acceptorSdk.userId,
    initiatorContactName,
    acceptorSdk.publicKeys
  );
  const initiatorContact = await initiatorSdk.contacts.get(
    initiatorSdk.userId,
    acceptorSdk.userId
  );
  if (!initiatorContact) {
    throw new Error('Initiator contact not found');
  }
  await acceptorSdk.contacts.add(
    acceptorSdk.userId,
    initiatorSdk.userId,
    acceptorContactName,
    initiatorSdk.publicKeys
  );
  const acceptorContact = await acceptorSdk.contacts.get(
    acceptorSdk.userId,
    initiatorSdk.userId
  );
  if (!acceptorContact) {
    throw new Error('Acceptor contact not found');
  }
  // Initiator starts the discussion
  const startResult = announcementMessage
    ? await initiatorSdk.discussions.start(initiatorContact, {
        username: initiatorContactName,
        message: announcementMessage,
      })
    : await initiatorSdk.discussions.start(initiatorContact);

  if (!startResult.success) {
    throw new Error(`Failed to start discussion: ${startResult.error}`);
  }

  // Acceptor fetches announcements and accepts
  await acceptorSdk.announcements.fetch();
  const acceptorDiscussion = await acceptorSdk.discussions.get(
    acceptorSdk.userId,
    initiatorSdk.userId
  );

  if (!acceptorDiscussion) {
    throw new Error('Acceptor discussion not found');
  }

  const acceptResult = await acceptorSdk.discussions.accept(acceptorDiscussion);
  if (!acceptResult.success) {
    throw new Error(`Failed to accept discussion: ${acceptResult.error}`);
  }

  // Initiator fetches acceptor's acceptance
  await initiatorSdk.announcements.fetch();

  // Verify session is active on both sides
  if (
    initiatorSdk.discussions.getStatus(acceptorSdk.userId) !==
    SessionStatus.Active
  ) {
    throw new Error(
      `Initiator session is not active. Status: ${initiatorSdk.discussions.getStatus(acceptorSdk.userId)}`
    );
  }
  if (
    acceptorSdk.discussions.getStatus(initiatorSdk.userId) !==
    SessionStatus.Active
  ) {
    throw new Error(
      `Acceptor session is not active. Status: ${acceptorSdk.discussions.getStatus(initiatorSdk.userId)}`
    );
  }
}
