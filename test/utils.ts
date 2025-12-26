import { db as appDb, Contact } from '../src/db';
import { initializeDiscussion } from '../src/services/discussion';
import { encodeUserId } from '../src/utils/userId';
import {
  MockSessionModule,
  MockUserPublicKeys,
  MockUserSecretKeys,
} from './wasm/mock';

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
  publicKeys: MockUserPublicKeys,
  secretKeys: MockUserSecretKeys
): MockSessionModule {
  const userId = publicKeys.user_id;
  const userIdEncoded = encodeUserId(userId);
  const session = new MockSessionModule(publicKeys, secretKeys);
  session.userId = userId;
  session.userIdEncoded = userIdEncoded;

  return session;
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
  alicePk: MockUserPublicKeys,
  aliceSk: MockUserSecretKeys,
  bobPk: MockUserPublicKeys,
  bobSk: MockUserSecretKeys,
  db = appDb,
  aliceSession: MockSessionModule,
  bobSession: MockSessionModule
): Promise<InitSessionResult> {
  const aliceUserId = encodeUserId(alicePk.user_id);
  const bobUserId = encodeUserId(bobPk.user_id);

  const aliceBobContact: Omit<Contact, 'id'> = {
    ownerUserId: aliceUserId,
    userId: bobUserId,
    name: 'Bob',
    publicKeys: bobPk.to_bytes(),
    avatar: undefined,
    isOnline: false,
    lastSeen: new Date(),
    createdAt: new Date(),
  };

  const bobAliceContact: Omit<Contact, 'id'> = {
    ownerUserId: bobUserId,
    userId: aliceUserId,
    name: 'Alice',
    publicKeys: alicePk.to_bytes(),
    avatar: undefined,
    isOnline: false,
    lastSeen: new Date(),
    createdAt: new Date(),
  };

  // Add contacts
  await db.contacts.add(aliceBobContact);
  await db.contacts.add(bobAliceContact);

  // Mock announcements
  const aliceAnnouncement = new Uint8Array(200);
  crypto.getRandomValues(aliceAnnouncement);
  aliceSession.establishOutgoingSession.mockReturnValue(aliceAnnouncement);

  const bobAnnouncement = new Uint8Array(200);
  crypto.getRandomValues(bobAnnouncement);
  bobSession.establishOutgoingSession.mockReturnValue(bobAnnouncement);

  // Initialize discussions
  const { discussionId: aliceDiscussionId } = await initializeDiscussion(
    aliceBobContact,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    aliceSession as any,
    aliceUserId
  );
  const { discussionId: bobDiscussionId } = await initializeDiscussion(
    bobAliceContact,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bobSession as any,
    bobUserId
  );

  return {
    aliceDiscussionId,
    bobDiscussionId,
    aliceAnnouncement,
    bobAnnouncement,
  };
}
