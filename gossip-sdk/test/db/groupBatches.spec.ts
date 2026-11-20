/**
 * The group tables apply an engine batch as the engine's conformance check
 * (node::conformance::check_batch_with_erase) requires, on the real SQLite
 * transaction: all or nothing, epoch changes, then erasure, then node records.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseConnection } from '../../src/db/sqlite';
import { GroupQueries, type GroupBatch } from '../../src/db/queries/groups';
import { getTestStorageConfig } from '../testDb';

const [a, b, c] = ['a1', 'b2', 'c3'].map(x => x.repeat(32));
const object = (n: number) => '0'.repeat(62) + n.toString(16).padStart(2, '0');

function changes(chats: string[], n: number, nextSeq: number): GroupBatch {
  return {
    rows: [],
    removedRows: [],
    edges: [],
    removedEdges: [],
    objects: chats.map(chatId => ({
      chatId,
      syncObjId: object(n),
      fields: '{}',
    })),
    removedObjects: [],
    node: [{ kind: 'meta', key: 'null', fields: `{"next_seq":${nextSeq}}` }],
    erase: [],
  };
}

const event = (n: number) => 'e'.repeat(46) + n.toString(16).padStart(2, '0');

describe('group batches on SQLite (engine conformance)', () => {
  it('applies a batch with an erase all or nothing, in the order of the trait', async () => {
    const conn = await DatabaseConnection.create({
      storage: getTestStorageConfig(),
    });
    const q = new GroupQueries(conn);
    const owner = 'owner';
    await q.applyBatches(owner, [changes([a, b, c], 1, 1)]);
    const second = { ...changes([a, c], 2, 2), erase: [b, c] };

    // A failure inside the transaction leaves everything as it was.
    await expect(
      q.applyBatches(owner, [second], async () => {
        throw new Error('injected');
      })
    ).rejects.toThrow('injected');
    const count = (
      snap: Awaited<ReturnType<GroupQueries['loadSnapshot']>>,
      chat: string
    ) => snap.objects.filter(o => o.chatId === chat).length;
    let snap = await q.loadSnapshot(owner);
    expect([count(snap, a), count(snap, b), count(snap, c)]).toEqual([1, 1, 1]);
    expect(snap.node).toEqual([
      { kind: 'meta', key: 'null', fields: '{"next_seq":1}' },
    ]);

    // Applied: the changes, then the erase (which also removes what the batch
    // wrote in an erased epoch), then the node records.
    await q.applyBatches(owner, [second]);
    snap = await q.loadSnapshot(owner);
    expect([count(snap, a), count(snap, b), count(snap, c)]).toEqual([2, 0, 0]);
    expect(snap.node).toEqual([
      { kind: 'meta', key: 'null', fields: '{"next_seq":2}' },
    ]);
    // Another account's records are untouched by either batch.
    expect((await q.loadSnapshot('other')).objects).toEqual([]);
    await conn.close();
  });

  it('deletes the rows, edges and objects the message timer erases, and only those', async () => {
    const conn = await DatabaseConnection.create({
      storage: getTestStorageConfig(),
    });
    const q = new GroupQueries(conn);
    const owner = 'owner';
    const written: GroupBatch = {
      ...changes([a], 1, 1),
      rows: [1, 2, 3].map(n => ({
        chatId: a,
        eventId: event(n),
        state: 'pruned',
        fields: null,
      })),
      edges: [1, 2, 3].map(n => ({
        chatId: a,
        eventId: event(n),
        parents: '[]',
      })),
      objects: [1, 2, 3].map(n => ({
        chatId: a,
        syncObjId: object(n),
        fields: '{}',
      })),
    };
    await q.applyBatches(owner, [written]);
    // Another account holds the same keys.
    await q.applyBatches('other', [written]);
    const erased: GroupBatch = {
      ...changes([], 0, 2),
      removedRows: [1, 2].map(n => ({ chatId: a, eventId: event(n) })),
      removedEdges: [1, 2].map(n => ({ chatId: a, eventId: event(n) })),
      removedObjects: [1, 2].map(n => ({ chatId: a, syncObjId: object(n) })),
    };
    await q.applyBatches(owner, [erased]);
    const snap = await q.loadSnapshot(owner);
    expect(snap.rows.map(r => r.eventId)).toEqual([event(3)]);
    expect(snap.edges.map(e => e.eventId)).toEqual([event(3)]);
    expect(snap.objects.map(o => o.syncObjId)).toEqual([object(3)]);
    const other = await q.loadSnapshot('other');
    expect([
      other.rows.length,
      other.edges.length,
      other.objects.length,
    ]).toEqual([3, 3, 3]);
    await conn.close();
  });
});
