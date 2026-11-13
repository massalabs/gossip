/**
 * Migration 0009: user ids not stored in lowercase are brought to lowercase.
 *
 * A bech32 id is valid in all lowercase or all uppercase. Earlier versions
 * stored a contact id as it was given, so a database can hold the uppercase
 * spelling, and even the same person in several spellings. A mix of cases is
 * not a valid id and the app's screens refuse it, but a row holding one is
 * brought to lowercase too: nothing can use it as it is.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { MIGRATIONS } from '../../src/db/generated-migrations';
import * as schema from '../../src/db/schema';
import {
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../../src/db';
import { encodeUserId } from '../../src/utils/userId';
import { clearAllTables, getTestDb, getTestQueries } from '../testDb';

const OWNER = encodeUserId(new Uint8Array(32).fill(1));
const ALICE = encodeUserId(new Uint8Array(32).fill(2));
const BOB = encodeUserId(new Uint8Array(32).fill(3));
const publicKeys = new Uint8Array([1, 2, 3]);

async function runMigration(): Promise<void> {
  const migration = MIGRATIONS.find(m => m.tag === '0009_lowercase_user_ids');
  if (!migration) throw new Error('migration 0009 is not embedded');
  for (const statement of migration.statements) {
    await getTestDb().run(sql.raw(statement));
  }
}

function insertContact(userId: string, name: string) {
  return getTestQueries().contacts.insert({
    ownerUserId: OWNER,
    userId,
    name,
    publicKeys,
    isOnline: false,
    lastSeen: new Date(),
    createdAt: new Date(),
  });
}

function insertDiscussion(
  contactUserId: string,
  unreadCount: number,
  last?: { content: string; at: number }
) {
  return getTestQueries().discussions.insert({
    ownerUserId: OWNER,
    contactUserId,
    direction: DiscussionDirection.INITIATED,
    weAccepted: true,
    sendAnnouncement: null,
    unreadCount,
    lastMessageContent: last?.content ?? null,
    lastMessageTimestamp: last ? new Date(last.at) : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function insertMessage(contactUserId: string, content: string) {
  return getTestQueries().messages.insert({
    ownerUserId: OWNER,
    contactUserId,
    content,
    type: MessageType.TEXT,
    direction: MessageDirection.INCOMING,
    status: MessageStatus.DELIVERED,
    timestamp: new Date(),
  });
}

describe('migration 0009_lowercase_user_ids', () => {
  beforeEach(async () => {
    await clearAllTables();
  });

  it('brings a person stored only in uppercase to lowercase', async () => {
    const upper = ALICE.toUpperCase();
    await insertContact(upper, 'Alice');
    await insertDiscussion(upper, 2);
    await insertMessage(upper, 'hello');
    await getTestQueries().discardedPeers.raise(OWNER, upper, 10);

    await runMigration();

    const queries = getTestQueries();
    expect(
      (await queries.contacts.getByOwner(OWNER)).map(c => c.userId)
    ).toEqual([ALICE]);
    const discussion = await queries.discussions.getByOwnerAndContact(
      OWNER,
      ALICE
    );
    expect(discussion?.unreadCount).toBe(2);
    const messages = await getTestDb().select().from(schema.messages);
    expect(messages.map(m => m.contactUserId)).toEqual([ALICE]);
    expect(await queries.discardedPeers.getFloor(OWNER, ALICE)).toBe(10);
  });

  it('merges a person stored in both spellings into the lowercase one', async () => {
    const upper = ALICE.toUpperCase();
    await insertContact(ALICE, 'Alice');
    await insertContact(upper, 'Alice again');
    await insertDiscussion(ALICE, 1, { content: 'older', at: 1000 });
    await insertDiscussion(upper, 3, { content: 'newer', at: 2000 });
    await insertMessage(ALICE, 'older');
    await insertMessage(upper, 'newer');
    await getTestQueries().discardedPeers.raise(OWNER, ALICE, 10);
    await getTestQueries().discardedPeers.raise(OWNER, upper, 20);

    await runMigration();

    const queries = getTestQueries();
    const contacts = await queries.contacts.getByOwner(OWNER);
    expect(contacts.map(c => [c.userId, c.name])).toEqual([[ALICE, 'Alice']]);

    const discussions = await getTestDb()
      .select()
      .from(schema.discussions)
      .where(eq(schema.discussions.ownerUserId, OWNER));
    expect(discussions).toHaveLength(1);
    expect(discussions[0].contactUserId).toBe(ALICE);
    // unread messages of both, and the newer last message
    expect(discussions[0].unreadCount).toBe(4);
    expect(discussions[0].lastMessageContent).toBe('newer');

    const messages = await getTestDb().select().from(schema.messages);
    expect(messages.map(m => [m.contactUserId, m.content]).sort()).toEqual([
      [ALICE, 'newer'],
      [ALICE, 'older'],
    ]);
    expect(await queries.discardedPeers.getFloor(OWNER, ALICE)).toBe(20);
  });

  it('keeps the last message of the lowercase discussion when it is the newer', async () => {
    await insertDiscussion(ALICE, 0, { content: 'newer', at: 2000 });
    await insertDiscussion(ALICE.toUpperCase(), 0, {
      content: 'older',
      at: 1000,
    });

    await runMigration();

    const discussion = await getTestQueries().discussions.getByOwnerAndContact(
      OWNER,
      ALICE
    );
    expect(discussion?.lastMessageContent).toBe('newer');
  });

  it('brings a mix of upper and lower case to lowercase', async () => {
    const mixed = ALICE.slice(0, 20) + ALICE.slice(20).toUpperCase();
    expect(mixed).not.toBe(ALICE);
    expect(mixed).not.toBe(ALICE.toUpperCase());
    await insertContact(mixed, 'Alice');
    await insertDiscussion(mixed, 2);
    await insertMessage(mixed, 'hello');
    await getTestQueries().discardedPeers.raise(OWNER, mixed, 10);

    await runMigration();

    const queries = getTestQueries();
    expect(
      (await queries.contacts.getByOwner(OWNER)).map(c => c.userId)
    ).toEqual([ALICE]);
    expect(
      (await queries.discussions.getByOwnerAndContact(OWNER, ALICE))
        ?.unreadCount
    ).toBe(2);
    const messages = await getTestDb().select().from(schema.messages);
    expect(messages.map(m => m.contactUserId)).toEqual([ALICE]);
    expect(await queries.discardedPeers.getFloor(OWNER, ALICE)).toBe(10);
  });

  it('merges several spellings when none of them is the lowercase one', async () => {
    const upper = ALICE.toUpperCase();
    const mixed = ALICE.slice(0, 20) + ALICE.slice(20).toUpperCase();
    await insertContact(upper, 'First');
    await insertContact(mixed, 'Second');
    await insertDiscussion(upper, 1, { content: 'older', at: 1000 });
    await insertDiscussion(mixed, 2, { content: 'newer', at: 2000 });
    await insertMessage(upper, 'older');
    await insertMessage(mixed, 'newer');
    await getTestQueries().discardedPeers.raise(OWNER, upper, 30);
    await getTestQueries().discardedPeers.raise(OWNER, mixed, 20);

    await runMigration();

    const queries = getTestQueries();
    // the first one stored is kept
    const contacts = await queries.contacts.getByOwner(OWNER);
    expect(contacts.map(c => [c.userId, c.name])).toEqual([[ALICE, 'First']]);

    const discussions = await getTestDb()
      .select()
      .from(schema.discussions)
      .where(eq(schema.discussions.ownerUserId, OWNER));
    expect(discussions).toHaveLength(1);
    expect(discussions[0].contactUserId).toBe(ALICE);
    expect(discussions[0].unreadCount).toBe(3);
    expect(discussions[0].lastMessageContent).toBe('newer');

    const messages = await getTestDb().select().from(schema.messages);
    expect(messages.map(m => m.contactUserId)).toEqual([ALICE, ALICE]);
    expect(await queries.discardedPeers.getFloor(OWNER, ALICE)).toBe(30);
  });

  it('merges three spellings into the lowercase one', async () => {
    const upper = ALICE.toUpperCase();
    const mixed = ALICE.slice(0, 20) + ALICE.slice(20).toUpperCase();
    await insertDiscussion(upper, 1);
    await insertDiscussion(ALICE, 2);
    await insertDiscussion(mixed, 4);
    await insertContact(upper, 'Upper');
    await insertContact(ALICE, 'Lower');
    await insertContact(mixed, 'Mixed');

    await runMigration();

    const discussions = await getTestDb().select().from(schema.discussions);
    expect(discussions.map(d => [d.contactUserId, d.unreadCount])).toEqual([
      [ALICE, 7],
    ]);
    const contacts = await getTestQueries().contacts.getByOwner(OWNER);
    expect(contacts.map(c => [c.userId, c.name])).toEqual([[ALICE, 'Lower']]);
  });

  it('leaves lowercase rows and other people untouched', async () => {
    await insertContact(ALICE, 'Alice');
    await insertContact(BOB, 'Bob');
    await insertDiscussion(BOB, 5, { content: 'hi', at: 1000 });
    await insertMessage(BOB, 'hi');

    await runMigration();

    const queries = getTestQueries();
    expect(
      (await queries.contacts.getByOwner(OWNER)).map(c => c.userId).sort()
    ).toEqual([ALICE, BOB].sort());
    const discussion = await queries.discussions.getByOwnerAndContact(
      OWNER,
      BOB
    );
    expect(discussion?.unreadCount).toBe(5);
    expect(discussion?.lastMessageContent).toBe('hi');
  });
});
