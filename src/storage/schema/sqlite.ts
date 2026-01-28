/**
 * SQLite schema definitions for the encrypted backend.
 *
 * These SQL statements create tables matching the Dexie schema,
 * allowing data to be stored in SQLite with the same structure.
 */

/**
 * SQL statements to create all tables
 */
export const CREATE_TABLES_SQL = `
-- Contacts table
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ownerUserId TEXT NOT NULL,
  userId TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT,
  publicKeys BLOB NOT NULL,
  isOnline INTEGER NOT NULL DEFAULT 0,
  lastSeen TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(ownerUserId);
CREATE INDEX IF NOT EXISTS idx_contacts_userId ON contacts(userId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_owner_user ON contacts(ownerUserId, userId);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ownerUserId TEXT NOT NULL,
  contactUserId TEXT NOT NULL,
  content TEXT NOT NULL,
  serializedContent BLOB,
  type TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT,
  seeker BLOB,
  replyTo TEXT,
  forwardOf TEXT,
  encryptedMessage BLOB
);

CREATE INDEX IF NOT EXISTS idx_messages_owner ON messages(ownerUserId);
CREATE INDEX IF NOT EXISTS idx_messages_owner_contact ON messages(ownerUserId, contactUserId);
CREATE INDEX IF NOT EXISTS idx_messages_owner_status ON messages(ownerUserId, status);
CREATE INDEX IF NOT EXISTS idx_messages_owner_seeker ON messages(ownerUserId, seeker);

-- User profiles table
CREATE TABLE IF NOT EXISTS userProfile (
  userId TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  avatar TEXT,
  security TEXT NOT NULL,
  session BLOB NOT NULL,
  bio TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  lastSeen TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  lastPublicKeyPush TEXT,
  lastBulletinCounter TEXT
);

CREATE INDEX IF NOT EXISTS idx_userProfile_username ON userProfile(username);

-- Discussions table
CREATE TABLE IF NOT EXISTS discussions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ownerUserId TEXT NOT NULL,
  contactUserId TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  nextSeeker BLOB,
  initiationAnnouncement BLOB,
  announcementMessage TEXT,
  lastSyncTimestamp TEXT,
  customName TEXT,
  lastMessageId INTEGER,
  lastMessageContent TEXT,
  lastMessageTimestamp TEXT,
  unreadCount INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discussions_owner ON discussions(ownerUserId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discussions_owner_contact ON discussions(ownerUserId, contactUserId);
CREATE INDEX IF NOT EXISTS idx_discussions_owner_status ON discussions(ownerUserId, status);

-- Pending encrypted messages table
CREATE TABLE IF NOT EXISTS pendingEncryptedMessages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seeker BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  fetchedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_messages_seeker ON pendingEncryptedMessages(seeker);

-- Pending announcements table
CREATE TABLE IF NOT EXISTS pendingAnnouncements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement BLOB NOT NULL UNIQUE,
  fetchedAt TEXT NOT NULL,
  counter TEXT
);

-- Active seekers table
CREATE TABLE IF NOT EXISTS activeSeekers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seeker BLOB NOT NULL
);
`;

/**
 * Convert a JavaScript Date to SQLite TEXT format (ISO 8601)
 */
export function dateToSql(date: Date): string {
  return date.toISOString();
}

/**
 * Convert SQLite TEXT date back to JavaScript Date
 */
export function sqlToDate(sql: string): Date {
  return new Date(sql);
}

/**
 * Convert a JavaScript object to JSON string for storage
 */
export function jsonToSql(obj: unknown): string {
  return JSON.stringify(obj);
}

/**
 * Convert SQL JSON string back to JavaScript object
 */
export function sqlToJson<T>(sql: string | null): T | undefined {
  if (!sql) return undefined;
  try {
    return JSON.parse(sql) as T;
  } catch {
    return undefined;
  }
}

/**
 * Convert boolean to SQLite INTEGER (0/1)
 */
export function boolToSql(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * Convert SQLite INTEGER to boolean
 */
export function sqlToBool(value: number): boolean {
  return value !== 0;
}

/**
 * Convert Uint8Array to format suitable for SQLite BLOB
 * In wa-sqlite, we can pass Uint8Array directly
 */
export function blobToSql(data: Uint8Array | undefined): Uint8Array | null {
  return data ?? null;
}

/**
 * Convert SQLite BLOB back to Uint8Array
 */
export function sqlToBlob(data: unknown): Uint8Array | undefined {
  if (!data) return undefined;
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return undefined;
}
