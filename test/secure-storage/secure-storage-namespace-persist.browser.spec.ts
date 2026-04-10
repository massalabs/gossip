import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseConnection } from '@massalabs/gossip-sdk/db/sqlite';
import {
  userProfile,
  messages,
  discussions,
} from '@massalabs/gossip-sdk/db/schema';
import { SESSION_BLOB_NAMESPACE } from '@massalabs/gossip-sdk/db/secure-storage-worker';
import secureStorageWasmUrlRaw from '@massalabs/gossip-sdk/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';

const secureStorageWasmUrl = new URL(
  secureStorageWasmUrlRaw,
  window.location.href
).href;

function config(domain: string) {
  return {
    storage: {
      type: 'secureStorage' as const,
      domain,
      secureStorageWasmUrl,
    },
  };
}

async function clearSecureStorageIdb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('secureStorage');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error('IDB deletion blocked — lingering handle?'));
  });
}

function randomBlob(size: number): Uint8Array {
  const blob = new Uint8Array(size);
  // crypto.getRandomValues caps at 65536 bytes per call.
  for (let off = 0; off < size; off += 65536) {
    crypto.getRandomValues(blob.subarray(off, Math.min(off + 65536, size)));
  }
  return blob;
}

const BLOB_SIZE = 55 * 1024; // ~55 KB — matches the typical session snapshot size
const ITERATIONS = 5;

describe('session blob namespace persist', () => {
  beforeEach(async () => {
    await clearSecureStorageIdb();
  }, 60_000);

  // ── E2E correctness ──────────────────────────────────────────────

  it('roundtrip: write blob to namespace, close, reopen, read back', async () => {
    const password = 'roundtrip-pw';
    const domain = 'vitest-ns-roundtrip';
    const blob = randomBlob(BLOB_SIZE);

    {
      const conn = await DatabaseConnection.create(config(domain));
      await conn.secureStorageAllocate(0, password);
      await conn.secureStorageWriteNamespaceData(
        SESSION_BLOB_NAMESPACE,
        0,
        blob
      );
      await conn.secureStorageFlush();
      await conn.close();
    }

    {
      const conn = await DatabaseConnection.create(config(domain));
      const ok = await conn.secureStorageUnlock(password);
      expect(ok).toBe(true);

      const len = await conn.secureStorageNamespaceDataLength(
        SESSION_BLOB_NAMESPACE
      );
      expect(len).toBe(blob.length);

      const read = await conn.secureStorageReadNamespaceData(
        SESSION_BLOB_NAMESPACE,
        0,
        len
      );
      expect(read.length).toBe(blob.length);
      expect(Array.from(read)).toEqual(Array.from(blob));

      await conn.close();
    }
  }, 180_000);

  it('namespace and SQL VFS data are isolated', async () => {
    const password = 'isolation-pw';
    const domain = 'vitest-ns-isolation';
    const now = new Date();
    const blob = randomBlob(BLOB_SIZE);

    const conn = await DatabaseConnection.create(config(domain));
    await conn.secureStorageAllocate(0, password);

    // Write via SQL VFS (namespace 0).
    await conn.db.insert(userProfile).values({
      userId: 'gossip1bob',
      username: 'bob',
      status: 'online',
      lastSeen: now,
      createdAt: now,
      updatedAt: now,
      security: 'classic',
      session: new Uint8Array([0]),
    });

    // Write via namespace 1 (session blob fast path).
    await conn.secureStorageWriteNamespaceData(SESSION_BLOB_NAMESPACE, 0, blob);

    await conn.secureStorageFlush();

    // Both must be readable independently.
    const rows = await conn.db
      .select({ username: userProfile.username })
      .from(userProfile)
      .where(eq(userProfile.userId, 'gossip1bob'));
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('bob');

    const nsLen = await conn.secureStorageNamespaceDataLength(
      SESSION_BLOB_NAMESPACE
    );
    expect(nsLen).toBe(blob.length);
    const read = await conn.secureStorageReadNamespaceData(
      SESSION_BLOB_NAMESPACE,
      0,
      nsLen
    );
    expect(Array.from(read)).toEqual(Array.from(blob));

    await conn.close();
  }, 180_000);

  // ── Benchmark: SQL UPDATE vs namespace write ─────────────────────

  it(`benchmark: ${ITERATIONS}x persist of ${BLOB_SIZE}B blob — SQL vs namespace`, async () => {
    const password = 'bench-pw';
    const domain = 'vitest-ns-bench';
    const now = new Date();

    const conn = await DatabaseConnection.create(config(domain));
    await conn.secureStorageAllocate(0, password);

    // Pre-create a userProfile row so we can UPDATE it (legacy path).
    await conn.db.insert(userProfile).values({
      userId: 'gossip1bench',
      username: 'bench',
      status: 'online',
      lastSeen: now,
      createdAt: now,
      updatedAt: now,
      security: 'classic',
      session: new Uint8Array([0]),
    });
    await conn.secureStorageFlush();

    // Warm-up: one iteration of each path (JIT, IDB connection, page cache).
    {
      const warmBlob = randomBlob(BLOB_SIZE);
      await conn.db
        .update(userProfile)
        .set({ session: warmBlob, updatedAt: new Date() })
        .where(eq(userProfile.userId, 'gossip1bench'));
      await conn.secureStorageFlush();

      await conn.secureStorageWriteNamespaceData(
        SESSION_BLOB_NAMESPACE,
        0,
        warmBlob
      );
      await conn.secureStorageFlush();
    }

    // ── Path A: SQL UPDATE on the userProfile.session column ──
    const sqlSamples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const blob = randomBlob(BLOB_SIZE);
      const t0 = performance.now();
      await conn.db
        .update(userProfile)
        .set({ session: blob, updatedAt: new Date() })
        .where(eq(userProfile.userId, 'gossip1bench'));
      await conn.secureStorageFlush();
      sqlSamples.push(performance.now() - t0);
    }

    // ── Path B: writeNamespaceData on the session blob namespace ──
    const nsSamples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const blob = randomBlob(BLOB_SIZE);
      const t0 = performance.now();
      await conn.secureStorageWriteNamespaceData(
        SESSION_BLOB_NAMESPACE,
        0,
        blob
      );
      await conn.secureStorageFlush();
      nsSamples.push(performance.now() - t0);
    }

    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const sqlAvg = sum(sqlSamples) / sqlSamples.length;
    const nsAvg = sum(nsSamples) / nsSamples.length;
    const sqlMin = Math.min(...sqlSamples);
    const nsMin = Math.min(...nsSamples);
    const sqlMax = Math.max(...sqlSamples);
    const nsMax = Math.max(...nsSamples);

    const fmt = (xs: number[]) => xs.map(x => `${x.toFixed(0)}ms`).join(', ');

    console.log(
      [
        ``,
        `=== Session persist benchmark (${BLOB_SIZE}B blob × ${ITERATIONS}) ===`,
        `Path A (SQL UPDATE userProfile.session)`,
        `  samples: [${fmt(sqlSamples)}]`,
        `  avg=${sqlAvg.toFixed(0)}ms  min=${sqlMin.toFixed(0)}ms  max=${sqlMax.toFixed(0)}ms`,
        `Path B (writeNamespaceData ns=${SESSION_BLOB_NAMESPACE})`,
        `  samples: [${fmt(nsSamples)}]`,
        `  avg=${nsAvg.toFixed(0)}ms  min=${nsMin.toFixed(0)}ms  max=${nsMax.toFixed(0)}ms`,
        `Δ avg: ${(sqlAvg - nsAvg).toFixed(0)}ms saved per persist`,
        `speedup: ${(sqlAvg / nsAvg).toFixed(2)}x`,
        ``,
      ].join('\n')
    );

    // Sanity: both paths must succeed at producing a non-trivial timing.
    expect(sqlAvg).toBeGreaterThan(0);
    expect(nsAvg).toBeGreaterThan(0);

    await conn.close();
  }, 600_000);

  // ── Burst send: simulates the SDK sendMessage write pattern ──────
  //
  // Each iteration mirrors what one `sendMessage` does at the storage
  // layer: INSERT into messages, UPDATE the discussion row, then
  // persist the session blob. We compare the legacy SQL persist path
  // against the namespace fast path so the gain is visible per
  // message-send round-trip (worst case: no debouncing across sends).

  const BURST_N = 5;

  it(`burst send: ${BURST_N}× (insert msg + update discussion + persist) — SQL vs namespace`, async () => {
    const password = 'burst-pw';
    const ownerId = 'gossip1burst-owner';
    const contactId = 'gossip1burst-contact';

    async function setupBaseRows(conn: DatabaseConnection) {
      const now = new Date();
      await conn.db.insert(userProfile).values({
        userId: ownerId,
        username: 'burst',
        status: 'online',
        lastSeen: now,
        createdAt: now,
        updatedAt: now,
        security: 'classic',
        session: new Uint8Array([0]),
      });
      await conn.db.insert(discussions).values({
        ownerUserId: ownerId,
        contactUserId: contactId,
        weAccepted: true,
        direction: 'outgoing',
        unreadCount: 0,
        pinned: false,
        mutedNotifications: false,
        saturatedRetryDone: false,
        createdAt: now,
        updatedAt: now,
      });
      await conn.secureStorageFlush();
    }

    async function runOneSend(
      conn: DatabaseConnection,
      i: number,
      persist: () => Promise<void>
    ) {
      const now = new Date();
      await conn.db.insert(messages).values({
        ownerUserId: ownerId,
        contactUserId: contactId,
        content: `burst message ${i}`,
        type: 'text',
        direction: 'outgoing',
        status: 'WAITING_SESSION',
        timestamp: now,
      });
      await conn.db
        .update(discussions)
        .set({
          lastMessageContent: `burst message ${i}`,
          lastMessageTimestamp: now,
          updatedAt: now,
        })
        .where(eq(discussions.ownerUserId, ownerId));
      await persist();
    }

    async function runBurst(
      conn: DatabaseConnection,
      persist: () => Promise<void>
    ): Promise<number> {
      const t0 = performance.now();
      for (let i = 0; i < BURST_N; i++) {
        await runOneSend(conn, i, persist);
      }
      await conn.secureStorageFlush();
      return performance.now() - t0;
    }

    // ── Path A: persist via SQL UPDATE on userProfile.session ──
    let sqlBurstMs: number;
    {
      const conn = await DatabaseConnection.create(config('vitest-burst-sql'));
      await conn.secureStorageAllocate(0, password);
      await setupBaseRows(conn);

      const persistViaSql = async () => {
        const blob = randomBlob(BLOB_SIZE);
        await conn.db
          .update(userProfile)
          .set({ session: blob, updatedAt: new Date() })
          .where(eq(userProfile.userId, ownerId));
      };

      // Warm-up so we don't measure JIT/IDB cache effects.
      await runOneSend(conn, -1, persistViaSql);
      await conn.secureStorageFlush();

      sqlBurstMs = await runBurst(conn, persistViaSql);
      await conn.close();
    }

    // ── Path B: persist via writeNamespaceData (ns=1) ──
    let nsBurstMs: number;
    {
      // Fresh DB to avoid SQLite page cache bias from path A.
      await clearSecureStorageIdb();
      const conn = await DatabaseConnection.create(config('vitest-burst-ns'));
      await conn.secureStorageAllocate(0, password);
      await setupBaseRows(conn);

      const persistViaNs = async () => {
        const blob = randomBlob(BLOB_SIZE);
        await conn.secureStorageWriteNamespaceData(
          SESSION_BLOB_NAMESPACE,
          0,
          blob
        );
      };

      // Warm-up.
      await runOneSend(conn, -1, persistViaNs);
      await conn.secureStorageFlush();

      nsBurstMs = await runBurst(conn, persistViaNs);
      await conn.close();
    }

    console.log(
      [
        ``,
        `=== Burst send benchmark (${BURST_N} messages, ${BLOB_SIZE}B persist each) ===`,
        `Path A (persist via SQL UPDATE): ${sqlBurstMs.toFixed(0)}ms total — ${(sqlBurstMs / BURST_N).toFixed(0)}ms / send`,
        `Path B (persist via namespace) : ${nsBurstMs.toFixed(0)}ms total — ${(nsBurstMs / BURST_N).toFixed(0)}ms / send`,
        `Δ total: ${(sqlBurstMs - nsBurstMs).toFixed(0)}ms saved over ${BURST_N} sends`,
        `speedup: ${(sqlBurstMs / nsBurstMs).toFixed(2)}x`,
        ``,
      ].join('\n')
    );

    expect(sqlBurstMs).toBeGreaterThan(0);
    expect(nsBurstMs).toBeGreaterThan(0);
  }, 600_000);

  // ── Send flow breakdown: time each SQL step on the critical path ──
  //
  // Reproduces the exact sequence of SQL operations that one
  // `sendMessage` triggers (without network/PQ session encryption,
  // which we measure separately). The goal is to see where the ~3s
  // user-perceived latency actually goes — which writes dominate, and
  // which ones are redundant.

  it('send flow breakdown: time each SQL op from press-send to MESSAGE_SENT', async () => {
    const password = 'flow-pw';
    const ownerId = 'gossip1flow-owner';
    const contactId = 'gossip1flow-contact';

    const conn = await DatabaseConnection.create(
      config('vitest-flow-breakdown')
    );
    await conn.secureStorageAllocate(0, password);

    // Setup: userProfile + 1 discussion, plus a few existing rows so the
    // SELECTs hit a non-trivial table (closer to real-world conditions).
    const setupNow = new Date();
    await conn.db.insert(userProfile).values({
      userId: ownerId,
      username: 'flow',
      status: 'online',
      lastSeen: setupNow,
      createdAt: setupNow,
      updatedAt: setupNow,
      security: 'classic',
      session: new Uint8Array([0]),
    });
    await conn.db.insert(discussions).values({
      ownerUserId: ownerId,
      contactUserId: contactId,
      weAccepted: true,
      direction: 'outgoing',
      unreadCount: 0,
      pinned: false,
      mutedNotifications: false,
      saturatedRetryDone: false,
      createdAt: setupNow,
      updatedAt: setupNow,
    });
    // Add a couple of older messages so getSendQueue has something to scan.
    for (let i = 0; i < 3; i++) {
      await conn.db.insert(messages).values({
        ownerUserId: ownerId,
        contactUserId: contactId,
        content: `old message ${i}`,
        type: 'text',
        direction: 'outgoing',
        status: 'SENT',
        timestamp: new Date(setupNow.getTime() - (i + 1) * 60_000),
      });
    }
    await conn.secureStorageFlush();

    // Warm-up: full sequence once so JIT/page-cache effects don't skew
    // the first measured iteration.
    await conn.db.insert(messages).values({
      ownerUserId: ownerId,
      contactUserId: contactId,
      content: 'warm',
      type: 'text',
      direction: 'outgoing',
      status: 'WAITING_SESSION',
      timestamp: new Date(),
    });
    await conn.db
      .update(discussions)
      .set({ updatedAt: new Date() })
      .where(eq(discussions.ownerUserId, ownerId));
    await conn.secureStorageFlush();

    // ── Measured run ──────────────────────────────────────────────
    const steps: Array<{ label: string; ms: number; isWrite: boolean }> = [];
    const measure = async <T>(
      label: string,
      isWrite: boolean,
      fn: () => Promise<T>
    ): Promise<T> => {
      const t0 = performance.now();
      const result = await fn();
      steps.push({ label, ms: performance.now() - t0, isWrite });
      return result;
    };

    const messageContent = 'real send flow';
    const sendNow = new Date();

    // ── 1. addMessageAndUpdateDiscussion ───────────────────────
    let insertedId: number = 0;
    await measure('1. INSERT messages (WAITING_SESSION)', true, async () => {
      const result = await conn.db
        .insert(messages)
        .values({
          ownerUserId: ownerId,
          contactUserId: contactId,
          content: messageContent,
          type: 'text',
          direction: 'outgoing',
          status: 'WAITING_SESSION',
          timestamp: sendNow,
        })
        .returning({ id: messages.id });
      insertedId = result[0]!.id;
    });

    const discussionRow = await measure(
      '2. SELECT discussion by owner+contact',
      false,
      () =>
        conn.db
          .select()
          .from(discussions)
          .where(eq(discussions.ownerUserId, ownerId))
          .limit(1)
    );

    await measure('3. UPDATE discussion (lastMessage*)', true, () =>
      conn.db
        .update(discussions)
        .set({
          lastMessageId: insertedId,
          lastMessageContent: messageContent,
          lastMessageTimestamp: sendNow,
          updatedAt: sendNow,
        })
        .where(eq(discussions.id, discussionRow[0]!.id))
    );

    // ── 2. stateUpdate() begins ────────────────────────────────
    await measure(
      '4. SELECT discussions.getByOwner #1 (stateUpdate Step 0)',
      false,
      () =>
        conn.db
          .select()
          .from(discussions)
          .where(eq(discussions.ownerUserId, ownerId))
    );

    // (Step 1: session.refresh() — out of scope, no SQL)

    await measure(
      '5. SELECT discussions.getByOwner #2 (stateUpdate Step 2 — DUPLICATE)',
      false,
      () =>
        conn.db
          .select()
          .from(discussions)
          .where(eq(discussions.ownerUserId, ownerId))
    );

    // (announcements: out of scope)

    await measure('6. SELECT messages.getSendQueue', false, () =>
      conn.db.select().from(messages).where(eq(messages.ownerUserId, ownerId))
    );

    // (session.sendMessage encrypt: out of scope, ~150ms with rayon)

    // Simulate the encryptedMessage / seeker we'd get from session.sendMessage
    const fakeEncrypted = randomBlob(512);
    const fakeSeeker = randomBlob(32);

    await measure(
      '7. UPDATE messages → READY (write encryptedMessage + seeker)',
      true,
      () =>
        conn.db
          .update(messages)
          .set({
            status: 'READY',
            encryptedMessage: fakeEncrypted,
            seeker: fakeSeeker,
            whenToSend: new Date(),
          })
          .where(eq(messages.id, insertedId))
    );

    // (network POST: out of scope, ~600ms)

    await measure(
      '8. SELECT messages.getById (latestRow race-check)',
      false,
      () =>
        conn.db
          .select()
          .from(messages)
          .where(eq(messages.id, insertedId))
          .limit(1)
    );

    await measure(
      '9. UPDATE messages → SENT (clear encryptedMessage)',
      true,
      () =>
        conn.db
          .update(messages)
          .set({
            status: 'SENT',
            encryptedMessage: null,
            serializedContent: null,
            whenToSend: null,
          })
          .where(eq(messages.id, insertedId))
    );

    // Final flush so the IDB write of the last UPDATE is included if
    // the worker hasn't auto-flushed yet (it normally flushes on a 2s
    // timer; here we force it so the measurements include durable I/O).
    await measure('10. flush (force IDB persist)', true, () =>
      conn.secureStorageFlush()
    );

    // ── Report ─────────────────────────────────────────────────
    const totalMs = steps.reduce((acc, s) => acc + s.ms, 0);
    const writeMs = steps
      .filter(s => s.isWrite)
      .reduce((acc, s) => acc + s.ms, 0);
    const readMs = steps
      .filter(s => !s.isWrite)
      .reduce((acc, s) => acc + s.ms, 0);

    const lines: string[] = [
      ``,
      `=== Send flow SQL breakdown (one message) ===`,
    ];
    for (const s of steps) {
      const tag = s.isWrite ? '✏️ ' : '🔍 ';
      lines.push(
        `  ${tag}${s.label.padEnd(60)} ${s.ms.toFixed(0).padStart(5)}ms`
      );
    }
    lines.push(`  ${'─'.repeat(72)}`);
    lines.push(`  Writes total : ${writeMs.toFixed(0)}ms`);
    lines.push(`  Reads total  : ${readMs.toFixed(0)}ms`);
    lines.push(`  TOTAL SQL    : ${totalMs.toFixed(0)}ms`);
    lines.push(``);
    lines.push(`Add to user-perceived latency:`);
    lines.push(
      `  + ~150ms session.sendMessage (PQ encrypt, with rayon parallel)`
    );
    lines.push(
      `  + ~600ms messageProtocol.sendMessage (network POST, server median)`
    );
    lines.push(``);
    lines.push(`Estimated grand total: ${(totalMs + 150 + 600).toFixed(0)}ms`);
    lines.push(``);
    lines.push(`Optimisations potentielles:`);
    lines.push(
      `  - withTransaction step 1+3        → -${(steps[0]!.ms + steps[2]!.ms - 600).toFixed(0)}ms (2 writes → 1)`
    );
    lines.push(
      `  - skip duplicate getByOwner (#5)  → -${steps[4]!.ms.toFixed(0)}ms`
    );
    lines.push(
      `  - skip READY (steps 7+8 fusionnés)→ -${(steps[6]!.ms + steps[7]!.ms).toFixed(0)}ms`
    );
    lines.push(
      `  - fire-and-forget UPDATE SENT     → -${steps[8]!.ms.toFixed(0)}ms (perceived)`
    );
    lines.push(``);
    console.log(lines.join('\n'));

    expect(totalMs).toBeGreaterThan(0);
    await conn.close();
  }, 600_000);

  // ── A/B compare: legacy SQL flow vs optimized flow ──────────────
  //
  // Mirrors what `processSendQueueForContact` does at the SQL layer
  // for one outgoing message, comparing the legacy 2-write path
  // (UPDATE → READY then UPDATE → SENT) against the optimized 1-write
  // path (skip READY, fire-and-forget UPDATE → SENT). Same simulated
  // network call (no real network), same fake encrypted bytes.

  it('A/B: legacy READY+SENT vs skip-READY happy path', async () => {
    const password = 'ab-pw';
    const ownerId = 'gossip1ab-owner';
    const contactId = 'gossip1ab-contact';

    const conn = await DatabaseConnection.create(config('vitest-flow-ab'));
    await conn.secureStorageAllocate(0, password);

    const setupNow = new Date();
    await conn.db.insert(userProfile).values({
      userId: ownerId,
      username: 'ab',
      status: 'online',
      lastSeen: setupNow,
      createdAt: setupNow,
      updatedAt: setupNow,
      security: 'classic',
      session: new Uint8Array([0]),
    });
    await conn.db.insert(discussions).values({
      ownerUserId: ownerId,
      contactUserId: contactId,
      weAccepted: true,
      direction: 'outgoing',
      unreadCount: 0,
      pinned: false,
      mutedNotifications: false,
      saturatedRetryDone: false,
      createdAt: setupNow,
      updatedAt: setupNow,
    });
    await conn.secureStorageFlush();

    // Insert one fresh message in WAITING_SESSION for each path.
    async function insertWaitingMessage(content: string): Promise<number> {
      const result = await conn.db
        .insert(messages)
        .values({
          ownerUserId: ownerId,
          contactUserId: contactId,
          content,
          type: 'text',
          direction: 'outgoing',
          status: 'WAITING_SESSION',
          timestamp: new Date(),
        })
        .returning({ id: messages.id });
      return result[0]!.id;
    }

    const fakeEncrypted = randomBlob(512);
    const fakeSeeker = randomBlob(32);

    // Warm-up.
    {
      const id = await insertWaitingMessage('warm');
      await conn.db
        .update(messages)
        .set({
          status: 'READY',
          encryptedMessage: fakeEncrypted,
          seeker: fakeSeeker,
          whenToSend: new Date(),
        })
        .where(eq(messages.id, id));
      await conn.db
        .update(messages)
        .set({
          status: 'SENT',
          encryptedMessage: null,
          serializedContent: null,
          whenToSend: null,
        })
        .where(eq(messages.id, id));
      await conn.secureStorageFlush();
    }

    // ── Path A: legacy (UPDATE READY + UPDATE SENT, both awaited) ──
    const aTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await insertWaitingMessage(`legacy ${i}`);

      const t0 = performance.now();
      // 1. UPDATE → READY (writes encryptedMessage + seeker)
      await conn.db
        .update(messages)
        .set({
          status: 'READY',
          encryptedMessage: fakeEncrypted,
          seeker: fakeSeeker,
          whenToSend: new Date(),
        })
        .where(eq(messages.id, id));
      // 2. (network call would happen here — out of scope)
      // 3. SELECT latestRow race-check
      await conn.db.select().from(messages).where(eq(messages.id, id)).limit(1);
      // 4. UPDATE → SENT (clears encryptedMessage)
      await conn.db
        .update(messages)
        .set({
          status: 'SENT',
          encryptedMessage: null,
          serializedContent: null,
          whenToSend: null,
        })
        .where(eq(messages.id, id));
      await conn.secureStorageFlush();
      aTimes.push(performance.now() - t0);
    }

    // ── Path B: optimized (skip READY, fire-and-forget SENT) ──
    const bTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await insertWaitingMessage(`opti ${i}`);

      const t0 = performance.now();
      // 1. (network call would happen here — out of scope)
      // 2. SELECT latestRow race-check (still done in optimized flow)
      await conn.db.select().from(messages).where(eq(messages.id, id)).limit(1);
      // 3. Fire-and-forget UPDATE → SENT — UI gets the checkmark NOW
      const fireAndForget = conn.db
        .update(messages)
        .set({
          status: 'SENT',
          encryptedMessage: null,
          serializedContent: null,
          whenToSend: null,
        })
        .where(eq(messages.id, id));
      // Stop the clock here — the user-perceived latency ends with the
      // emit MESSAGE_SENT, which happens immediately after the network
      // ack (modeled by the SELECT above).
      bTimes.push(performance.now() - t0);
      // Drain the background write so the next iteration sees a clean
      // state. In production this overlaps with the next user action
      // and isn't on the critical path.
      await fireAndForget;
      await conn.secureStorageFlush();
    }

    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const avgA = sum(aTimes) / aTimes.length;
    const avgB = sum(bTimes) / bTimes.length;
    const fmt = (xs: number[]) => xs.map(x => `${x.toFixed(0)}ms`).join(', ');

    console.log(
      [
        ``,
        `=== A/B compare: legacy vs skip-READY happy path ===`,
        `Path A (legacy: UPDATE READY + UPDATE SENT awaited)`,
        `  samples: [${fmt(aTimes)}]`,
        `  avg=${avgA.toFixed(0)}ms`,
        `Path B (optimized: skip READY, fire-and-forget SENT)`,
        `  samples: [${fmt(bTimes)}]`,
        `  avg=${avgB.toFixed(0)}ms`,
        `Δ avg: ${(avgA - avgB).toFixed(0)}ms saved per send (perceived)`,
        `speedup: ${(avgA / avgB).toFixed(2)}x`,
        ``,
      ].join('\n')
    );

    expect(avgA).toBeGreaterThan(0);
    expect(avgB).toBeGreaterThan(0);

    await conn.close();
  }, 600_000);
});
