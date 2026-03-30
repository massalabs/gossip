/**
 * DiscussionService.setMuted tests
 *
 * Covers:
 * - setMuted(true): sets mutedNotifications = true in the local DB
 * - setMuted(false): sets mutedNotifications = false in the local DB
 * - default value for new discussions is false
 * - toggling mute multiple times persists each change correctly
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DiscussionService } from '../../src/services/discussion';
import { AnnouncementService } from '../../src/services/announcement';
import { SessionModule } from '../../src/wasm/session';
import { SdkEventEmitter } from '../../src/core/SdkEventEmitter';
import { DiscussionDirection } from '../../src/db';
import { getTestQueries, clearAllTables } from '../testDb';

const OWNER_USER_ID = 'owner-mute-test';
const CONTACT_USER_ID = 'contact-mute-test';

async function insertTestDiscussion(
  ownerUserId = OWNER_USER_ID,
  contactUserId = CONTACT_USER_ID
) {
  const queries = getTestQueries();
  return queries.discussions.insert({
    ownerUserId,
    contactUserId,
    weAccepted: true,
    direction: DiscussionDirection.INITIATED,
    unreadCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Parameters<typeof queries.discussions.insert>[0]);
}

function createService() {
  const session = { userIdEncoded: OWNER_USER_ID } as unknown as SessionModule;
  return new DiscussionService(
    {} as AnnouncementService,
    session,
    new SdkEventEmitter(),
    getTestQueries()
    // refreshService omitted — optional, avoids calling stateUpdate() on a stub
  );
}

describe('DiscussionService.setMuted', () => {
  beforeEach(clearAllTables);

  it('new discussions default to mutedNotifications = false', async () => {
    await insertTestDiscussion();
    const row = await getTestQueries().discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(row?.mutedNotifications).toBe(false);
  });

  it('setMuted(true) persists mutedNotifications = true in the DB', async () => {
    const discussionId = await insertTestDiscussion();
    await createService().setMuted(discussionId, true);

    const row = await getTestQueries().discussions.getById(discussionId);
    expect(row?.mutedNotifications).toBe(true);
  });

  it('setMuted(false) persists mutedNotifications = false in the DB', async () => {
    const discussionId = await insertTestDiscussion();
    const service = createService();

    await service.setMuted(discussionId, true);
    await service.setMuted(discussionId, false);

    const row = await getTestQueries().discussions.getById(discussionId);
    expect(row?.mutedNotifications).toBe(false);
  });

  it('toggling mute multiple times reflects the last value', async () => {
    const discussionId = await insertTestDiscussion();
    const service = createService();

    await service.setMuted(discussionId, true);
    await service.setMuted(discussionId, false);
    await service.setMuted(discussionId, true);

    const row = await getTestQueries().discussions.getById(discussionId);
    expect(row?.mutedNotifications).toBe(true);
  });

  it('muting one discussion does not affect another', async () => {
    const CONTACT_USER_ID_2 = 'contact-mute-other';
    const queries = getTestQueries();

    const id1 = await insertTestDiscussion();
    await queries.contacts.insert({
      ownerUserId: OWNER_USER_ID,
      userId: CONTACT_USER_ID_2,
      name: 'Other Contact',
      publicKeys: new Uint8Array(32),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });
    const id2 = await queries.discussions.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID_2,
      weAccepted: true,
      direction: DiscussionDirection.INITIATED,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Parameters<typeof queries.discussions.insert>[0]);

    await createService().setMuted(id1, true);

    const row1 = await queries.discussions.getById(id1);
    const row2 = await queries.discussions.getById(id2);
    expect(row1?.mutedNotifications).toBe(true);
    expect(row2?.mutedNotifications).toBe(false);
  });
});
