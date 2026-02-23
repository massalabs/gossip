import { and, desc, eq, ne, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { getSqliteDb } from '../sqlite';
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

export async function getUserProfileField(
  userId: string
): Promise<UserProfileRow | undefined> {
  return getSqliteDb()
    .select()
    .from(schema.userProfile)
    .where(eq(schema.userProfile.userId, userId))
    .get();
}

export async function updateUserProfileById(
  userId: string,
  data: Partial<UserProfileInsert>
): Promise<void> {
  await getSqliteDb()
    .update(schema.userProfile)
    .set(data)
    .where(eq(schema.userProfile.userId, userId));
}

export async function getUserProfileByUsernameLower(
  username: string
): Promise<{ userId: string } | undefined> {
  return getSqliteDb()
    .select({ userId: schema.userProfile.userId })
    .from(schema.userProfile)
    .where(
      sql`LOWER(${schema.userProfile.username}) = ${username.trim().toLowerCase()}`
    )
    .get();
}

export async function getMostRecentUserProfile(): Promise<
  UserProfileRow | undefined
> {
  return getSqliteDb()
    .select()
    .from(schema.userProfile)
    .orderBy(desc(schema.userProfile.lastSeen))
    .limit(1)
    .get();
}

export async function getAllUserProfiles(): Promise<UserProfileRow[]> {
  return getSqliteDb().select().from(schema.userProfile).all();
}

export async function getUserProfileCount(): Promise<number> {
  const result = await getSqliteDb()
    .select({ count: sql<number>`count(*)` })
    .from(schema.userProfile)
    .get();
  return result?.count ?? 0;
}

export async function insertUserProfile(
  values: UserProfileInsert
): Promise<void> {
  await getSqliteDb().insert(schema.userProfile).values(values);
}

export async function deleteUserProfile(userId: string): Promise<void> {
  await getSqliteDb()
    .delete(schema.userProfile)
    .where(eq(schema.userProfile.userId, userId));
}

export async function getUserProfileByUsernameLowerExcluding(
  username: string,
  excludeUserId: string
): Promise<{ userId: string } | undefined> {
  return getSqliteDb()
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

export async function upsertUserProfile(
  values: UserProfileInsert
): Promise<void> {
  const { userId: _, ...rest } = values;
  await getSqliteDb()
    .insert(schema.userProfile)
    .values(values)
    .onConflictDoUpdate({
      target: schema.userProfile.userId,
      set: rest,
    });
}
