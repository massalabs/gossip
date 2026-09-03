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

      const row = await tx
        .insert(privateMigration)
        .values({
          id: PRIVATE_MIGRATION_SINGLETON_ID,
          formatVersion: PRIVATE_MIGRATION_FORMAT_VERSION,
          installationEpoch,
          completedPhase: 0,
        })
        .onConflictDoUpdate({
          target: privateMigration.id,
          set: {
            formatVersion: PRIVATE_MIGRATION_FORMAT_VERSION,
            installationEpoch,
            completedPhase: 0,
          },
        })
        .returning()
        .get();
      return validate(row);
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
}
