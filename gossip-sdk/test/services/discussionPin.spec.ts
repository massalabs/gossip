import { describe, it, expect, beforeEach } from 'vitest';
import { DiscussionService } from '../../src/services/discussion';
import { AnnouncementService } from '../../src/services/announcement';
import { RefreshService } from '../../src/services/refresh';
import { SessionModule } from '../../src/wasm/session';
import { SdkEventEmitter } from '../../src/core/SdkEventEmitter';
import { Queries } from '../../src/db/queries/index';
import { getTestQueries, clearAllTables } from '../testDb';
import { SELF_CONTACT_ID } from '../../src/services/selfMessage';

describe('DiscussionService pin with self discussion', () => {
  let queries: Queries;

  beforeEach(() => {
    queries = getTestQueries();
  });

  it('can pin and unpin a self discussion without decoding userId', async () => {
    await clearAllTables();

    const ownerUserId = 'owner-pin-self';

    // Create a self discussion row directly
    const discussionId = await queries.discussions.insert({
      ownerUserId,
      contactUserId: SELF_CONTACT_ID,
      weAccepted: true,
      direction: 'initiated',
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      pinned: false,
    } as unknown as Parameters<typeof queries.discussions.insert>[0]);

    // Minimal session/announcement/refresh to construct DiscussionService,
    // but pin() itself only goes through updateDiscussionPin -> queries.
    const session = {
      userIdEncoded: ownerUserId,
    } as unknown as SessionModule;

    const announcementService = {} as AnnouncementService;
    const refreshService = {} as RefreshService;
    const eventEmitter = new SdkEventEmitter();

    const service = new DiscussionService(
      announcementService,
      session,
      eventEmitter,
      queries,
      refreshService
    );

    // Pin
    const pinResult = await service.pin(discussionId, true);
    expect(pinResult.success).toBe(true);

    let row = await queries.discussions.getById(discussionId);
    expect(row?.pinned).toBe(true);

    // Unpin
    const unpinResult = await service.pin(discussionId, false);
    expect(unpinResult.success).toBe(true);

    row = await queries.discussions.getById(discussionId);
    expect(row?.pinned).toBe(false);
  });
});
