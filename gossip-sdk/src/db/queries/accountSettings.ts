import { and, eq } from 'drizzle-orm';
import type { DatabaseConnection } from '../sqlite.js';
import {
  ACCOUNT_SETTINGS_FORMAT_VERSION,
  DEFAULT_RETENTION_DURATION_SECONDS,
  accountSettings,
} from '../schema/index.js';

export interface AccountSettingsV1 {
  userId: string;
  formatVersion: typeof ACCOUNT_SETTINGS_FORMAT_VERSION;
  mnsEnabled: boolean;
  defaultRetentionDuration: number | null;
}

function validate(row: typeof accountSettings.$inferSelect): AccountSettingsV1 {
  if (row.formatVersion !== ACCOUNT_SETTINGS_FORMAT_VERSION) {
    throw new Error('Unsupported account settings format');
  }
  if (
    row.defaultRetentionDuration !== null &&
    (!Number.isSafeInteger(row.defaultRetentionDuration) ||
      row.defaultRetentionDuration < 0)
  ) {
    throw new Error('Invalid default retention duration');
  }
  return { ...row, formatVersion: ACCOUNT_SETTINGS_FORMAT_VERSION };
}

export class AccountSettingsQueries {
  constructor(private readonly conn: DatabaseConnection) {}

  async create(userId: string): Promise<AccountSettingsV1> {
    const row = await this.conn.db
      .insert(accountSettings)
      .values({
        userId,
        formatVersion: ACCOUNT_SETTINGS_FORMAT_VERSION,
        mnsEnabled: false,
        defaultRetentionDuration: DEFAULT_RETENTION_DURATION_SECONDS,
      })
      .returning()
      .get();
    return validate(row);
  }

  async getOrCreate(userId: string): Promise<AccountSettingsV1> {
    await this.conn.db
      .insert(accountSettings)
      .values({
        userId,
        formatVersion: ACCOUNT_SETTINGS_FORMAT_VERSION,
        mnsEnabled: false,
        defaultRetentionDuration: DEFAULT_RETENTION_DURATION_SECONDS,
      })
      .onConflictDoNothing({ target: accountSettings.userId });
    const row = await this.get(userId);
    if (!row) throw new Error('Failed to provision account settings');
    return row;
  }

  async get(userId: string): Promise<AccountSettingsV1 | undefined> {
    const row = await this.conn.db
      .select()
      .from(accountSettings)
      .where(eq(accountSettings.userId, userId))
      .get();
    return row === undefined ? undefined : validate(row);
  }

  async update(
    userId: string,
    patch: Partial<
      Pick<AccountSettingsV1, 'mnsEnabled' | 'defaultRetentionDuration'>
    >
  ): Promise<AccountSettingsV1> {
    if (
      patch.defaultRetentionDuration !== undefined &&
      patch.defaultRetentionDuration !== null &&
      (!Number.isSafeInteger(patch.defaultRetentionDuration) ||
        patch.defaultRetentionDuration < 0)
    ) {
      throw new Error('Invalid default retention duration');
    }
    const current = await this.get(userId);
    if (!current) throw new Error('Account settings row is missing');
    const row = await this.conn.db
      .update(accountSettings)
      .set(patch)
      .where(
        and(
          eq(accountSettings.userId, userId),
          eq(accountSettings.formatVersion, ACCOUNT_SETTINGS_FORMAT_VERSION)
        )
      )
      .returning()
      .get();
    if (!row) throw new Error('Account settings update lost its version');
    return validate(row);
  }
}
