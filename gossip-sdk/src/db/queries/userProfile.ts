import { and, desc, eq, ne, sql } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';
import {
  IDENTITY_DERIVATION_VERSION,
  PROFILE_MNEMONIC_ENCRYPTION_VERSION,
  PROFILE_PASSWORD_KDF_VERSION,
  PROFILE_SECURITY_FORMAT_VERSION,
  type UserProfile,
} from '../db.js';

export type UserProfileRow = typeof schema.userProfile.$inferSelect;
export type UserProfileInsert = typeof schema.userProfile.$inferInsert;

const MAX_SECURITY_JSON_CHARS = 128 * 1024;

function toBoundedUint8Array(
  value: unknown,
  field: string,
  minLength: number,
  maxLength = minLength
): Uint8Array {
  const bytes = value instanceof Uint8Array ? value : value;
  if (
    (bytes instanceof Uint8Array || Array.isArray(bytes)) &&
    (bytes.length < minLength || bytes.length > maxLength)
  ) {
    throw new Error(`Invalid ${field} length`);
  }
  if (
    !(bytes instanceof Uint8Array) &&
    (!Array.isArray(bytes) ||
      bytes.some(
        byte =>
          !Number.isInteger(byte) ||
          typeof byte !== 'number' ||
          byte < 0 ||
          byte > 255
      ))
  ) {
    throw new Error(`Invalid ${field}`);
  }
  const result =
    bytes instanceof Uint8Array
      ? new Uint8Array(bytes)
      : Uint8Array.from(bytes);
  if (result.length < minLength || result.length > maxLength) {
    result.fill(0);
    throw new Error(`Invalid ${field} length`);
  }
  return result;
}

type RawSecurityEnvelope = Record<string, unknown> & {
  encKeySalt: unknown;
  mnemonicBackup: Record<string, unknown>;
};

function parseSecurityEnvelope(value: unknown): RawSecurityEnvelope {
  if (typeof value === 'string' && value.length > MAX_SECURITY_JSON_CHARS) {
    throw new Error('Account security envelope is too large');
  }
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid account security envelope');
  }
  const envelope = raw as Record<string, unknown>;
  if (
    envelope.formatVersion !== PROFILE_SECURITY_FORMAT_VERSION ||
    envelope.passwordKdfVersion !== PROFILE_PASSWORD_KDF_VERSION ||
    envelope.mnemonicEncryptionVersion !==
      PROFILE_MNEMONIC_ENCRYPTION_VERSION ||
    envelope.identityDerivationVersion !== IDENTITY_DERIVATION_VERSION
  ) {
    throw new Error('Unsupported account security format');
  }
  if (envelope.authMethod !== 'password') {
    throw new Error('Unsupported account authentication method');
  }
  if (
    envelope.iCloudSync !== undefined &&
    typeof envelope.iCloudSync !== 'boolean'
  ) {
    throw new Error('Invalid iCloud sync preference');
  }
  if (
    envelope.webauthn !== undefined &&
    (typeof envelope.webauthn !== 'object' ||
      envelope.webauthn === null ||
      Array.isArray(envelope.webauthn) ||
      ('credentialId' in envelope.webauthn &&
        typeof (envelope.webauthn as Record<string, unknown>).credentialId !==
          'string'))
  ) {
    throw new Error('Invalid WebAuthn metadata');
  }
  if (
    typeof envelope.mnemonicBackup !== 'object' ||
    envelope.mnemonicBackup === null ||
    Array.isArray(envelope.mnemonicBackup)
  ) {
    throw new Error('Invalid mnemonic security envelope');
  }
  const mnemonicBackup = envelope.mnemonicBackup as Record<string, unknown>;
  if (typeof mnemonicBackup.backedUp !== 'boolean') {
    throw new Error('Invalid mnemonic backup state');
  }
  return envelope as RawSecurityEnvelope;
}

function toDate(value: unknown): Date {
  if (
    !(value instanceof Date) &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  ) {
    throw new Error('Invalid security timestamp');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Invalid security timestamp');
  }
  return date;
}

/** Convert a DB row (security as JSON string) to a domain UserProfile. */
export function rowToUserProfile(row: UserProfileRow): UserProfile {
  const raw = parseSecurityEnvelope(row.security);
  const security = {
    formatVersion: PROFILE_SECURITY_FORMAT_VERSION,
    passwordKdfVersion: PROFILE_PASSWORD_KDF_VERSION,
    mnemonicEncryptionVersion: PROFILE_MNEMONIC_ENCRYPTION_VERSION,
    identityDerivationVersion: IDENTITY_DERIVATION_VERSION,
    authMethod: 'password' as const,
    ...(raw.webauthn === undefined ? {} : { webauthn: raw.webauthn }),
    ...(raw.iCloudSync === undefined
      ? {}
      : { iCloudSync: raw.iCloudSync as boolean }),
    encKeySalt: toBoundedUint8Array(
      raw.encKeySalt,
      'profile encryption salt',
      16
    ),
    mnemonicBackup: {
      encryptedMnemonic: toBoundedUint8Array(
        raw.mnemonicBackup.encryptedMnemonic,
        'encrypted mnemonic',
        17,
        64 * 1024
      ),
      createdAt: toDate(raw.mnemonicBackup.createdAt),
      backedUp: raw.mnemonicBackup.backedUp as boolean,
    },
  };
  return { ...row, security } as UserProfile;
}

/** Convert a domain UserProfile to a DB-ready insert row (security as JSON string). */
export function userProfileToRow(profile: UserProfile): UserProfileInsert {
  parseSecurityEnvelope(profile.security);
  const checkedSalt = toBoundedUint8Array(
    profile.security.encKeySalt,
    'profile encryption salt',
    16
  );
  const checkedMnemonic = toBoundedUint8Array(
    profile.security.mnemonicBackup.encryptedMnemonic,
    'encrypted mnemonic',
    17,
    64 * 1024
  );
  const checkedCreatedAt = toDate(
    profile.security.mnemonicBackup.createdAt
  ).toISOString();

  let serializedSecurity: string;
  try {
    const security = {
      formatVersion: PROFILE_SECURITY_FORMAT_VERSION,
      passwordKdfVersion: PROFILE_PASSWORD_KDF_VERSION,
      mnemonicEncryptionVersion: PROFILE_MNEMONIC_ENCRYPTION_VERSION,
      identityDerivationVersion: IDENTITY_DERIVATION_VERSION,
      encKeySalt: Array.from(checkedSalt),
      authMethod: 'password' as const,
      ...(profile.security.webauthn === undefined
        ? {}
        : {
            webauthn: {
              credentialId: profile.security.webauthn.credentialId,
            },
          }),
      ...(profile.security.iCloudSync === undefined
        ? {}
        : { iCloudSync: profile.security.iCloudSync }),
      mnemonicBackup: {
        encryptedMnemonic: Array.from(checkedMnemonic),
        createdAt: checkedCreatedAt,
        backedUp: profile.security.mnemonicBackup.backedUp,
      },
    };
    serializedSecurity = JSON.stringify(security);
  } finally {
    checkedSalt.fill(0);
    checkedMnemonic.fill(0);
  }
  if (serializedSecurity.length > MAX_SECURITY_JSON_CHARS) {
    throw new Error('Account security envelope is too large');
  }
  return {
    ...profile,
    security: serializedSecurity,
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
  ): Promise<boolean> {
    const updated = await this.conn.db
      .update(schema.userProfile)
      .set(data)
      .where(eq(schema.userProfile.userId, userId))
      .returning({ userId: schema.userProfile.userId })
      .get();
    return updated !== undefined;
  }

  async updateLastPublicKeyPushMax(
    userId: string,
    candidate: Date
  ): Promise<boolean> {
    const candidateMs = candidate.getTime();
    const current = schema.userProfile.lastPublicKeyPush;
    const updated = await this.conn.db
      .update(schema.userProfile)
      .set({
        lastPublicKeyPush: sql`CASE
          WHEN ${current} IS NULL OR ${current} < ${candidateMs}
            THEN ${candidateMs}
          ELSE ${current}
        END`,
      })
      .where(eq(schema.userProfile.userId, userId))
      .returning({ userId: schema.userProfile.userId })
      .get();
    return updated !== undefined;
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
    const currentPush = schema.userProfile.lastPublicKeyPush;
    const incomingPush = sql.raw('excluded."lastPublicKeyPush"');
    await this.conn.db
      .insert(schema.userProfile)
      .values(values)
      .onConflictDoUpdate({
        target: schema.userProfile.userId,
        set: {
          ...rest,
          // Publication and UI profile saves are independent. Preserve the
          // newest operational timestamp in the conflict statement itself so
          // no read/upsert interleaving can clear or move it backward.
          lastPublicKeyPush: sql`CASE
            WHEN ${currentPush} IS NULL THEN ${incomingPush}
            WHEN ${incomingPush} IS NULL THEN ${currentPush}
            WHEN ${currentPush} >= ${incomingPush} THEN ${currentPush}
            ELSE ${incomingPush}
          END`,
        },
      });
  }
}
