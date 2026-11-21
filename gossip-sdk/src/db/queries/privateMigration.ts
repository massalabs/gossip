import { and, eq } from 'drizzle-orm';
import type { DatabaseConnection } from '../sqlite.js';
import {
  PRIVATE_MIGRATION_FORMAT_VERSION,
  PRIVATE_MIGRATION_PHASE_COUNT,
  PRIVATE_MIGRATION_SINGLETON_ID,
  privateMigration,
} from '../schema/index.js';

export interface PrivateMigrationStateV1 {
  formatVersion: typeof PRIVATE_MIGRATION_FORMAT_VERSION;
  installationEpoch: string;
  completedPhase: number;
  /**
   * The journal came from another generation (a backup imported): the
   * messaging sessions are given up and rebuilt, and the user is told once.
   */
  sessionReset: boolean;
}

function validateEpoch(epoch: string): void {
  if (!/^[0-9a-f]{32}$/u.test(epoch)) {
    throw new Error('Invalid private migration installation epoch');
  }
}

function validate(
  row: typeof privateMigration.$inferSelect
): PrivateMigrationStateV1 {
  if (row.id !== PRIVATE_MIGRATION_SINGLETON_ID) {
    throw new Error('Invalid private migration journal identity');
  }
  if (row.formatVersion !== PRIVATE_MIGRATION_FORMAT_VERSION) {
    throw new Error('Unsupported private migration journal format');
  }
  validateEpoch(row.installationEpoch);
  if (
    !Number.isSafeInteger(row.completedPhase) ||
    row.completedPhase < 0 ||
    row.completedPhase > PRIVATE_MIGRATION_PHASE_COUNT
  ) {
    throw new Error('Invalid private migration phase');
  }
  return {
    formatVersion: PRIVATE_MIGRATION_FORMAT_VERSION,
    installationEpoch: row.installationEpoch,
    completedPhase: row.completedPhase,
    sessionReset: row.sessionReset,
  };
}

export class PrivateMigrationQueries {
  constructor(private readonly conn: DatabaseConnection) {}

  async get(): Promise<PrivateMigrationStateV1 | undefined> {
    const row = await this.conn.db
      .select()
      .from(privateMigration)
      .where(eq(privateMigration.id, PRIVATE_MIGRATION_SINGLETON_ID))
      .get();
    return row === undefined ? undefined : validate(row);
  }

  async begin(installationEpoch: string): Promise<PrivateMigrationStateV1> {
    validateEpoch(installationEpoch);
    return this.conn.withTransaction(async tx => {
      const currentRow = await tx
        .select()
        .from(privateMigration)
        .where(eq(privateMigration.id, PRIVATE_MIGRATION_SINGLETON_ID))
        .get();
      if (currentRow) {
        const current = validate(currentRow);
        if (current.installationEpoch === installationEpoch) return current;
      }

      // A journal of another generation was copied here with the account (a
      // backup imported, or a re-encryption whose carry-over was lost): its
      // sessions may have moved on elsewhere. No journal at all is an account
      // upgraded in place, whose sessions are its own.
      const sessionReset = currentRow !== undefined;
      const row = await tx
        .insert(privateMigration)
        .values({
          id: PRIVATE_MIGRATION_SINGLETON_ID,
          formatVersion: PRIVATE_MIGRATION_FORMAT_VERSION,
          installationEpoch,
          completedPhase: 0,
          sessionReset,
        })
        .onConflictDoUpdate({
          target: privateMigration.id,
          set: {
            formatVersion: PRIVATE_MIGRATION_FORMAT_VERSION,
            installationEpoch,
            completedPhase: 0,
            sessionReset,
          },
        })
        .returning()
        .get();
      return validate(row);
    });
  }

  /**
   * Record the journal as already complete for `installationEpoch`, in one
   * transaction. Only for an account that was created inside this very
   * generation: every phase exists to carry data over from an older
   * generation or format, and such an account has none.
   */
  async beginCompleted(
    installationEpoch: string
  ): Promise<PrivateMigrationStateV1> {
    validateEpoch(installationEpoch);
    return this.conn.withTransaction(async tx => {
      const values = {
        formatVersion: PRIVATE_MIGRATION_FORMAT_VERSION,
        installationEpoch,
        completedPhase: PRIVATE_MIGRATION_PHASE_COUNT,
        sessionReset: false,
      };
      const row = await tx
        .insert(privateMigration)
        .values({ id: PRIVATE_MIGRATION_SINGLETON_ID, ...values })
        .onConflictDoUpdate({ target: privateMigration.id, set: values })
        .returning()
        .get();
      return validate(row);
    });
  }

  /**
   * Carry a finished journal over to a generation that is an in-place
   * re-encryption of the one it was finished in. The account's contents are
   * the same, so there is nothing left to carry over. Resolves `false`, and
   * changes nothing, unless the journal is complete for `fromEpoch`; the next
   * login then walks the journal as usual.
   */
  async carryOver(fromEpoch: string, toEpoch: string): Promise<boolean> {
    validateEpoch(fromEpoch);
    validateEpoch(toEpoch);
    return this.conn.withTransaction(async tx => {
      const updated = await tx
        .update(privateMigration)
        .set({ installationEpoch: toEpoch })
        .where(
          and(
            eq(privateMigration.id, PRIVATE_MIGRATION_SINGLETON_ID),
            eq(
              privateMigration.formatVersion,
              PRIVATE_MIGRATION_FORMAT_VERSION
            ),
            eq(privateMigration.installationEpoch, fromEpoch),
            eq(privateMigration.completedPhase, PRIVATE_MIGRATION_PHASE_COUNT)
          )
        )
        .returning()
        .get();
      return updated !== undefined;
    });
  }

  async completePhase(
    installationEpoch: string,
    phase: number
  ): Promise<PrivateMigrationStateV1> {
    validateEpoch(installationEpoch);
    if (
      !Number.isSafeInteger(phase) ||
      phase < 1 ||
      phase > PRIVATE_MIGRATION_PHASE_COUNT
    ) {
      throw new Error('Invalid private migration phase');
    }

    return this.conn.withTransaction(async tx => {
      const currentRow = await tx
        .select()
        .from(privateMigration)
        .where(eq(privateMigration.id, PRIVATE_MIGRATION_SINGLETON_ID))
        .get();
      if (!currentRow) throw new Error('Private migration journal changed');
      const current = validate(currentRow);
      if (current.installationEpoch !== installationEpoch) {
        throw new Error('Private migration journal changed');
      }
      if (current.completedPhase >= phase) return current;
      if (current.completedPhase !== phase - 1) {
        throw new Error('Private migration phases must complete in order');
      }

      const row = await tx
        .update(privateMigration)
        .set({ completedPhase: phase })
        .where(
          and(
            eq(privateMigration.id, PRIVATE_MIGRATION_SINGLETON_ID),
            eq(
              privateMigration.formatVersion,
              PRIVATE_MIGRATION_FORMAT_VERSION
            ),
            eq(privateMigration.installationEpoch, installationEpoch),
            eq(privateMigration.completedPhase, phase - 1)
          )
        )
        .returning()
        .get();
      if (!row) throw new Error('Private migration phase lost its journal');
      return validate(row);
    });
  }

  /**
   * The user was told that the sessions were rebuilt: the mark is cleared,
   * if the journal is still the one of `installationEpoch`.
   */
  async acknowledgeSessionReset(installationEpoch: string): Promise<void> {
    validateEpoch(installationEpoch);
    await this.conn.db
      .update(privateMigration)
      .set({ sessionReset: false })
      .where(
        and(
          eq(privateMigration.id, PRIVATE_MIGRATION_SINGLETON_ID),
          eq(privateMigration.installationEpoch, installationEpoch)
        )
      );
  }
}
