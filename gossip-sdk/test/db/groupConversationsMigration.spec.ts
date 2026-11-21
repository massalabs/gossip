/**
 * Migration 0011: the one-to-one discussions of a database from before group
 * chats become archives (§5.12), contacts carry their connection marker, and a
 * discussion can be linked to the direct chat that continues it.
 *
 * The test database already holds every migration; the rows are written as an
 * older release would have left them (with the defaults of the new columns),
 * and the data statement of the migration is run on them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MIGRATIONS } from '../../src/db/generated-migrations';
import {
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../../src/db';
import { SELF_CONTACT_ID } from '../../src/services/selfMessage';
import { encodeUserId } from '../../src/utils/userId';
import { clearAllTables, getTestDb, getTestQueries } from '../testDb';

const OWNER = encodeUserId(new Uint8Array(32).fill(1));
const ALICE = encodeUserId(new Uint8Array(32).fill(2));
const BOB = encodeUserId(new Uint8Array(32).fill(3));

const migration = MIGRATIONS.find(m => m.tag === '0011_group_conversations');

async function runDataStatements(): Promise<void> {
  if (!migration) throw new Error('migration 0011 is not embedded');
  for (const statement of migration.statements) {
    if (/^\s*ALTER TABLE/i.test(statement)) continue;
    await getTestDb().run(sql.raw(statement));
  }
}

function insertDiscussion(contactUserId: string, weAccepted = true) {
  return getTestQueries().discussions.insert({
    ownerUserId: OWNER,
    contactUserId,
    direction: DiscussionDirection.INITIATED,
    weAccepted,
    sendAnnouncement: null,
    unreadCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('migration 0011_group_conversations', () => {
  beforeEach(async () => {
    await clearAllTables();
  });

  it('adds the columns with defaults that leave a new row as before', async () => {
    expect(migration?.statements.slice(0, 5)).toEqual([
      "ALTER TABLE `contacts` ADD `connection` text DEFAULT 'accepted' NOT NULL;",
      'ALTER TABLE `discussions` ADD `isArchive` integer DEFAULT false NOT NULL;',
      'ALTER TABLE `discussions` ADD `archived` integer DEFAULT false NOT NULL;',
      'ALTER TABLE `discussions` ADD `linkedGroupId` text;',
      'ALTER TABLE `discussions` ADD `directChatOwed` integer DEFAULT false NOT NULL;',
    ]);
    await getTestQueries().contacts.insert({
      ownerUserId: OWNER,
      userId: ALICE,
      name: 'Alice',
      publicKeys: new Uint8Array([1]),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });
    const contact = await getTestQueries().contacts.getByOwnerAndUser(
      OWNER,
      ALICE
    );
    expect(contact?.connection).toBe('accepted');
    const id = await insertDiscussion(ALICE);
    const d = await getTestQueries().discussions.getById(id);
    expect(d).toMatchObject({
      isArchive: false,
      archived: false,
      linkedGroupId: null,
      directChatOwed: false,
    });
  });

  it('turns every earlier discussion into an archive, keeping its messages', async () => {
    const alice = await insertDiscussion(ALICE);
    const bob = await insertDiscussion(BOB, false);
    const self = await insertDiscussion(SELF_CONTACT_ID);
    await getTestQueries().messages.insert({
      ownerUserId: OWNER,
      contactUserId: ALICE,
      content: 'not sent yet',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    await runDataStatements();

    const q = getTestQueries().discussions;
    expect((await q.getById(alice))?.isArchive).toBe(true);
    expect((await q.getById(bob))?.isArchive).toBe(true);
    expect((await q.getById(self))?.isArchive).toBe(false);
    for (const id of [alice, bob]) {
      expect(await q.getById(id)).toMatchObject({
        archived: false,
        linkedGroupId: null,
      });
    }
    // The pending message stays, unsent, in the archive.
    const [row] = await getTestQueries().messages.getByOwnerAndContact(
      OWNER,
      ALICE
    );
    expect(row).toMatchObject({
      content: 'not sent yet',
      status: MessageStatus.WAITING_SESSION,
    });
  });
});
