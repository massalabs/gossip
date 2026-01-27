import { Contact, db as localAppDb } from '../src/db';
import { MockSessionModule } from './wasm/mock';
import {
  UserPublicKeys,
  UserSecretKeys,
  generateUserKeys,
  UserKeys,
  encodeUserId,
  SessionModule,
} from '@massalabs/gossip-sdk';
import { MockMessageProtocol } from './mocks/mockMessageProtocol';

interface InitSessionResult {
  aliceDiscussionId: number;
  bobDiscussionId: number;
  aliceAnnouncement: Uint8Array;
  bobAnnouncement: Uint8Array;
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

/**
 * Create a GossipSdk instance for testing with a mock session.
 * This is the recommended way to set up services for tests.
 */
export function createTestSdk(
  session: MockSessionModule,
  appDb = localAppDb
): GossipSdk {
  const mockProtocol = new MockMessageProtocol();
  return createGossipSdk(
    appDb,
    mockProtocol,
    session as unknown as SessionModule
  );
}

/**
 * Initialize an active discussion session between Alice and Bob for message tests.
 * This helper:
 * - Creates reciprocal contacts
 * - Initializes discussions for both parties
 * - Marks discussions as ACTIVE
 * - Mocks announcement sending
 */
export async function initSession(
  alicePk: UserPublicKeys,
  aliceSk: UserSecretKeys,
  bobPk: UserPublicKeys,
  bobSk: UserSecretKeys,
  appDb = localAppDb,
  aliceSession: MockSessionModule,
  bobSession: MockSessionModule
): Promise<InitSessionResult> {
  // Create SDK instances for each user
  const aliceSdk = createTestSdk(aliceSession, appDb);
  const bobSdk = createTestSdk(bobSession, appDb);

  const aliceBobContact: Omit<Contact, 'id'> = {
    ownerUserId: aliceSession.userIdEncoded,
    userId: bobSession.userIdEncoded,
    name: 'Bob',
    publicKeys: bobPk.to_bytes(),
    avatar: undefined,
    isOnline: false,
    lastSeen: new Date(),
    createdAt: new Date(),
  };

  const bobAliceContact: Omit<Contact, 'id'> = {
    ownerUserId: bobSession.userIdEncoded,
    userId: aliceSession.userIdEncoded,
    name: 'Alice',
    publicKeys: alicePk.to_bytes(),
    avatar: undefined,
    isOnline: false,
    lastSeen: new Date(),
    createdAt: new Date(),
  };

  // Add contacts
  await appDb.contacts.add(aliceBobContact);
  await appDb.contacts.add(bobAliceContact);

  // Mock announcements
  const aliceAnnouncement = new Uint8Array(200);
  crypto.getRandomValues(aliceAnnouncement);
  aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

  const bobAnnouncement = new Uint8Array(200);
  crypto.getRandomValues(bobAnnouncement);
  bobSession.establishOutgoingSession.mockReturnValue(bobAnnouncement);

  // Initialize discussions - each user uses their own SDK
  const { discussionId: aliceDiscussionId } =
    await aliceSdk.discussion.initialize(aliceBobContact);
  const { discussionId: bobDiscussionId } =
    await bobSdk.discussion.initialize(bobAliceContact);

  return {
    aliceDiscussionId,
    bobDiscussionId,
    aliceAnnouncement,
    bobAnnouncement,
  };
}
