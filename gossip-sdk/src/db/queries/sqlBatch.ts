import { QueryBuilder } from 'drizzle-orm/sqlite-core';
import type { GossipDatabase, GossipSqliteTx } from '../sqlite.js';

/**
 * A db context accepted by SqlBatch operations.
 *
 * Both the root database instance and an active transaction expose the same
 * drizzle query-builder API (insert / update / delete / select), so batch ops
 * can be written generically and replayed on either surface.
 */
export type DbContext = GossipDatabase | GossipSqliteTx;

type BatchOp = (db: DbContext) => Promise<void>;

/**
 * A collection of deferred database write operations that can be executed
 * atomically within an explicit transaction context.
 *
 * ## Motivation
 *
 * When a helper method needs to produce DB writes that must be committed
 * together with the caller's own writes, passing a `tx` reference through
 * every layer couples each helper to whatever transaction the caller happens
 * to be running.  SqlBatch inverts this: the helper collects its operations
 * without executing them, returns the batch, and the caller replays it in
 * whichever transaction it controls.
 *
 * ## Usage
 *
 * ```ts
 * // --- building the batch (no DB writes yet) ---
 * const batch = new SqlBatch();
 * const values = { content: 'hello', ... };
 * batch.add(db => db.insert(schema.messages).values(values));
 * batch.add(db => db.update(schema.discussions).set({ ... }).where(...));
 *
 * // --- replaying in the caller's transaction ---
 * await this.queries.conn.withTransaction(async tx => {
 *   await doSomethingElse(tx);
 *   await batch.execute(tx);   // all ops run inside the same tx
 * });
 * ```
 *
 * ## QueryBuilder
 *
 * The `qb` property exposes a connection-less `QueryBuilder` that can be used
 * to build and inspect queries (e.g. via `.toSQL()`) before capturing them in
 * a batch op.  It is purely a convenience — most callers will simply use the
 * `db` argument provided by the op factory.
 */
export class SqlBatch {
  /**
   * A connection-less QueryBuilder for constructing parameterised queries
   * without a live database connection.  Inspect with `.toSQL()` or capture
   * the built values in a closure passed to `add()`.
   */
  readonly qb = new QueryBuilder();

  private readonly ops: BatchOp[] = [];

  /**
   * Queue a write operation to be executed later.
   *
   * The factory receives the actual db context (transaction or root db) at
   * execute time.  Use drizzle's standard query builders — `db.insert()`,
   * `db.update()`, `db.delete()` — with the provided `db` argument.
   *
   * Values needed by the operation should be closed over from the surrounding
   * scope so that the batch remains a self-contained description of what to
   * write.
   */
  add(op: BatchOp): void {
    this.ops.push(op);
  }

  /**
   * Execute all queued operations in insertion order using the provided db
   * context.
   *
   * Pass an active transaction (`tx`) for atomic execution alongside other
   * operations in the same transaction.  When no transaction is available,
   * pass the root db instance — each op will then run as its own implicit
   * transaction.
   */
  async execute(db: DbContext): Promise<void> {
    for (const op of this.ops) {
      await op(db);
    }
  }

  /** Number of queued operations. */
  get size(): number {
    return this.ops.length;
  }
}
