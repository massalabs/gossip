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
    objects: chats.map(chatId => ({
      chatId,
      syncObjId: object(n),
      fields: '{}',
    })),
    node: [{ kind: 'meta', key: 'null', fields: `{"next_seq":${nextSeq}}` }],
    erase: [],
  };
}

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
});
