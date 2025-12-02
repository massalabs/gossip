import { db as appDb, Contact } from '../src/db';
import { initializeDiscussion } from '../src/services/discussion';
import { encodeUserId } from '../src/utils/userId';
import {
  MockSessionModule,
  MockUserPublicKeys,
  MockUserSecretKeys,
} from '../src/wasm/mock';

interface InitSessionResult {
  aliceDiscussionId: number;
  bobDiscussionId: number;
  aliceAnnouncement: Uint8Array;
  bobAnnouncement: Uint8Array;
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
    alicePk,
    aliceSk,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    aliceSession as any,
    aliceUserId
  );
  const { discussionId: bobDiscussionId } = await initializeDiscussion(
    bobAliceContact,
    bobPk,
    bobSk,
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
