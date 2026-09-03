import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllTables, getTestConnection, getTestQueries } from '../testDb';

const EPOCH_A = '00112233445566778899aabbccddeeff';
const EPOCH_B = 'ffeeddccbbaa99887766554433221100';

describe('PrivateMigrationQueries', () => {
  beforeEach(clearAllTables);

  it('creates and resumes one installation-scoped journal', async () => {
    const queries = getTestQueries().privateMigration;
    await expect(queries.begin(EPOCH_A)).resolves.toEqual({
      formatVersion: 1,
      installationEpoch: EPOCH_A,
      completedPhase: 0,
    });
    await queries.completePhase(EPOCH_A, 1);
    await expect(queries.begin(EPOCH_A)).resolves.toMatchObject({
      installationEpoch: EPOCH_A,
      completedPhase: 1,
    });
  });

  it('does not let a delayed begin reset concurrently completed progress', async () => {
    const queries = getTestQueries().privateMigration;
    const connection = getTestConnection();
    const original = connection.withTransaction.bind(connection);
    let releaseDelayed!: () => void;
    const delayed = new Promise<void>(resolve => {
      releaseDelayed = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>(resolve => {
      firstEntered = resolve;
    });
    let calls = 0;
    const transactionSpy = vi
      .spyOn(connection, 'withTransaction')
      .mockImplementation(async (operation, behavior) => {
        calls += 1;
        if (calls === 1) {
          firstEntered();
          await delayed;
        }
        return original(operation, behavior);
      });

    try {
      const delayedBegin = queries.begin(EPOCH_A);
      await entered;
      await queries.begin(EPOCH_A);
      await queries.completePhase(EPOCH_A, 1);
      releaseDelayed();
      await delayedBegin;
      await expect(queries.get()).resolves.toMatchObject({ completedPhase: 1 });
    } finally {
      releaseDelayed();
      transactionSpy.mockRestore();
    }
  });

  it('advances monotonically and idempotently', async () => {
    const queries = getTestQueries().privateMigration;
    await queries.begin(EPOCH_A);
    await Promise.all([
      queries.completePhase(EPOCH_A, 1),
      queries.completePhase(EPOCH_A, 1),
    ]);
    await expect(queries.completePhase(EPOCH_A, 1)).resolves.toMatchObject({
      completedPhase: 1,
    });
    await expect(queries.completePhase(EPOCH_A, 3)).rejects.toThrow(
      'must complete in order'
    );
    for (let phase = 2; phase <= 5; phase++) {
      await queries.completePhase(EPOCH_A, phase);
    }
    await expect(queries.get()).resolves.toMatchObject({ completedPhase: 5 });
  });

  it('resets copied completion state for a different destination epoch', async () => {
    const queries = getTestQueries().privateMigration;
    await queries.begin(EPOCH_A);
    for (let phase = 1; phase <= 5; phase++) {
      await queries.completePhase(EPOCH_A, phase);
    }
    await expect(queries.begin(EPOCH_B)).resolves.toEqual({
      formatVersion: 1,
      installationEpoch: EPOCH_B,
      completedPhase: 0,
    });
  });

  it('rejects malformed epochs and stale writers', async () => {
    const queries = getTestQueries().privateMigration;
    await expect(queries.begin('not-an-epoch')).rejects.toThrow(
      'Invalid private migration installation epoch'
    );
    await queries.begin(EPOCH_A);
    await expect(queries.completePhase(EPOCH_B, 1)).rejects.toThrow(
      'journal changed'
    );
  });
});
