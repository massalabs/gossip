import { and, desc, eq, ne, sql } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';
import type { UserProfile } from '../db';

export type UserProfileRow = typeof schema.userProfile.$inferSelect;
export type UserProfileInsert = typeof schema.userProfile.$inferInsert;

/**
 * Restore a Uint8Array from JSON-parsed data.
 * Handles: number[] (correct format), {0:x, 1:y, ...} (corrupted from
 * bare JSON.stringify of Uint8Array), or already a Uint8Array.
 */
function toUint8Array(val: unknown): Uint8Array {
  if (val instanceof Uint8Array) return val;
  if (Array.isArray(val)) return new Uint8Array(val);
  if (typeof val === 'object' && val !== null) {
    const obj = val as Record<string, number>;
    const len = Object.keys(obj).length;
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = obj[String(i)];
    return arr;
  }
  return new Uint8Array();
}

/** Convert a DB row (security as JSON string) to a domain UserProfile. */
export function rowToUserProfile(row: UserProfileRow): UserProfile {
  const raw =
    typeof row.security === 'string' ? JSON.parse(row.security) : row.security;
  const security = {
    ...raw,
    encKeySalt: toUint8Array(raw.encKeySalt),
    mnemonicBackup: {
      ...raw.mnemonicBackup,
      encryptedMnemonic: toUint8Array(raw.mnemonicBackup.encryptedMnemonic),
      createdAt: new Date(raw.mnemonicBackup.createdAt),
    },
  };
  return { ...row, security } as UserProfile;
}

/** Convert a domain UserProfile to a DB-ready insert row (security as JSON string). */
export function userProfileToRow(profile: UserProfile): UserProfileInsert {
  const security = {
    ...profile.security,
    encKeySalt: Array.from(profile.security.encKeySalt),
    mnemonicBackup: {
      ...profile.security.mnemonicBackup,
      encryptedMnemonic: Array.from(
        profile.security.mnemonicBackup.encryptedMnemonic
      ),
    },
  };
  return {
    ...profile,
    security: JSON.stringify(security),
    lastPublicKeyPush: profile.lastPublicKeyPush ?? null,
  };
}

export class UserProfileQueries {
  constructor(private conn: DatabaseConnection) {}

  async getById(userId: string): Promise<UserProfileRow | undefined> {
    return this.conn.db
      .select()
      .from(schema.userProfile)
      .where(eq(schema.userProfile.userId, userId))
      .get();
  }

  async updateById(
    userId: string,
    data: Partial<UserProfileInsert>
  ): Promise<void> {
    await this.conn.db
      .update(schema.userProfile)
      .set(data)
      .where(eq(schema.userProfile.userId, userId));
  }

  async getByUsernameLower(
    username: string
  ): Promise<{ userId: string } | undefined> {
    return this.conn.db
      .select({ userId: schema.userProfile.userId })
      .from(schema.userProfile)
      .where(
        sql`LOWER(${schema.userProfile.username}) = ${username.trim().toLowerCase()}`
      )
      .get();
  }

  async getMostRecent(): Promise<UserProfileRow | undefined> {
    return this.conn.db
      .select()
      .from(schema.userProfile)
      .orderBy(desc(schema.userProfile.lastSeen))
      .limit(1)
      .get();
  }

  async getAll(): Promise<UserProfileRow[]> {
    return this.conn.db.select().from(schema.userProfile).all();
  }

  async getCount(): Promise<number> {
    const result = await this.conn.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.userProfile)
      .get();
    return result?.count ?? 0;
  }

  async insert(values: UserProfileInsert): Promise<void> {
    await this.conn.db.insert(schema.userProfile).values(values);
  }

  async delete(userId: string): Promise<void> {
    await this.conn.db
      .delete(schema.userProfile)
      .where(eq(schema.userProfile.userId, userId));
  }

  async getByUsernameLowerExcluding(
    username: string,
    excludeUserId: string
  ): Promise<{ userId: string } | undefined> {
    return this.conn.db
      .select({ userId: schema.userProfile.userId })
      .from(schema.userProfile)
      .where(
        and(
          sql`LOWER(${schema.userProfile.username}) = ${username.trim().toLowerCase()}`,
          ne(schema.userProfile.userId, excludeUserId)
        )
      )
      .get();
  }

  async upsert(values: UserProfileInsert): Promise<void> {
    const { userId: _, ...rest } = values;
    await this.conn.db
      .insert(schema.userProfile)
      .values(values)
      .onConflictDoUpdate({
        target: schema.userProfile.userId,
        set: rest,
      });
  }
}
