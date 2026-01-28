/**
 * Encrypted SQLite implementation of IUserProfileRepository
 */

import type { IRuntimeAdapter } from '../../interfaces';
import type { IUserProfileRepository } from '../../interfaces/repositories';
import type { UserProfile } from '../../models';
import type { Observable } from '../../base/Observable';
import { BehaviorSubject } from '../../base/Observable';
import {
  dateToSql,
  sqlToDate,
  blobToSql,
  sqlToBlob,
  jsonToSql,
  sqlToJson,
} from '../../schema/sqlite';

interface UserProfileRow {
  userId: string;
  username: string;
  avatar: string | null;
  security: string;
  session: Uint8Array;
  bio: string | null;
  status: string;
  lastSeen: string;
  createdAt: string;
  updatedAt: string;
  lastPublicKeyPush: string | null;
  lastBulletinCounter: string | null;
}

function rowToUserProfile(row: UserProfileRow): UserProfile {
  return {
    userId: row.userId,
    username: row.username,
    avatar: row.avatar || undefined,
    security: sqlToJson(row.security) as UserProfile['security'],
    session: sqlToBlob(row.session) || new Uint8Array(),
    bio: row.bio || undefined,
    status: row.status as UserProfile['status'],
    lastSeen: sqlToDate(row.lastSeen),
    createdAt: sqlToDate(row.createdAt),
    updatedAt: sqlToDate(row.updatedAt),
    lastPublicKeyPush: row.lastPublicKeyPush
      ? sqlToDate(row.lastPublicKeyPush)
      : undefined,
    lastBulletinCounter: row.lastBulletinCounter || undefined,
  };
}

export class EncryptedUserProfileRepository implements IUserProfileRepository {
  private changeSubject = new BehaviorSubject<number>(0);

  constructor(private runtime: IRuntimeAdapter) {}

  // ============ Basic CRUD ============

  async get(userId: string): Promise<UserProfile | undefined> {
    const rows = await this.runtime.executeSql<UserProfileRow>(
      `SELECT * FROM userProfile WHERE userId = ?`,
      [userId]
    );
    return rows.length > 0 ? rowToUserProfile(rows[0]) : undefined;
  }

  async getAll(): Promise<UserProfile[]> {
    const rows = await this.runtime.executeSql<UserProfileRow>(
      `SELECT * FROM userProfile ORDER BY username`
    );
    return rows.map(rowToUserProfile);
  }

  async getFirst(): Promise<UserProfile | undefined> {
    const rows = await this.runtime.executeSql<UserProfileRow>(
      `SELECT * FROM userProfile LIMIT 1`
    );
    return rows.length > 0 ? rowToUserProfile(rows[0]) : undefined;
  }

  async create(profile: UserProfile): Promise<UserProfile> {
    const now = new Date();
    const createdAt = profile.createdAt || now;
    const updatedAt = profile.updatedAt || now;

    await this.runtime.runSql(
      `INSERT INTO userProfile (userId, username, avatar, security, session, bio, status, lastSeen, createdAt, updatedAt, lastPublicKeyPush, lastBulletinCounter)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profile.userId,
        profile.username,
        profile.avatar || null,
        jsonToSql(profile.security),
        blobToSql(profile.session),
        profile.bio || null,
        profile.status,
        dateToSql(profile.lastSeen),
        dateToSql(createdAt),
        dateToSql(updatedAt),
        profile.lastPublicKeyPush ? dateToSql(profile.lastPublicKeyPush) : null,
        profile.lastBulletinCounter || null,
      ]
    );

    this.notifyChange();

    return {
      ...profile,
      createdAt,
      updatedAt,
    };
  }

  async update(
    userId: string,
    changes: Partial<Omit<UserProfile, 'userId'>>
  ): Promise<UserProfile | undefined> {
    const existing = await this.get(userId);
    if (!existing) return undefined;

    const updates: string[] = ['updatedAt = ?'];
    const values: unknown[] = [dateToSql(new Date())];

    if (changes.username !== undefined) {
      updates.push('username = ?');
      values.push(changes.username);
    }
    if (changes.avatar !== undefined) {
      updates.push('avatar = ?');
      values.push(changes.avatar || null);
    }
    if (changes.security !== undefined) {
      updates.push('security = ?');
      values.push(jsonToSql(changes.security));
    }
    if (changes.session !== undefined) {
      updates.push('session = ?');
      values.push(blobToSql(changes.session));
    }
    if (changes.bio !== undefined) {
      updates.push('bio = ?');
      values.push(changes.bio || null);
    }
    if (changes.status !== undefined) {
      updates.push('status = ?');
      values.push(changes.status);
    }
    if (changes.lastSeen !== undefined) {
      updates.push('lastSeen = ?');
      values.push(dateToSql(changes.lastSeen));
    }
    if (changes.lastPublicKeyPush !== undefined) {
      updates.push('lastPublicKeyPush = ?');
      values.push(
        changes.lastPublicKeyPush ? dateToSql(changes.lastPublicKeyPush) : null
      );
    }
    if (changes.lastBulletinCounter !== undefined) {
      updates.push('lastBulletinCounter = ?');
      values.push(changes.lastBulletinCounter || null);
    }

    values.push(userId);
    await this.runtime.runSql(
      `UPDATE userProfile SET ${updates.join(', ')} WHERE userId = ?`,
      values
    );

    this.notifyChange();

    return await this.get(userId);
  }

  async delete(userId: string): Promise<boolean> {
    const result = await this.runtime.runSql(
      `DELETE FROM userProfile WHERE userId = ?`,
      [userId]
    );
    if (result.changes > 0) {
      this.notifyChange();
      return true;
    }
    return false;
  }

  // ============ Reactivity ============

  observe(userId: string): Observable<UserProfile | undefined> {
    const subject = new BehaviorSubject<UserProfile | undefined>(undefined);
    this.get(userId).then(p => subject.next(p));
    this.changeSubject.subscribe(() => {
      this.get(userId).then(p => subject.next(p));
    });
    return subject;
  }

  observeAll(): Observable<UserProfile[]> {
    const subject = new BehaviorSubject<UserProfile[]>([]);
    this.getAll().then(ps => subject.next(ps));
    this.changeSubject.subscribe(() => {
      this.getAll().then(ps => subject.next(ps));
    });
    return subject;
  }

  // ============ Domain-specific ============

  async updateSession(userId: string, session: Uint8Array): Promise<void> {
    await this.runtime.runSql(
      `UPDATE userProfile SET session = ?, updatedAt = ? WHERE userId = ?`,
      [blobToSql(session), dateToSql(new Date()), userId]
    );
    this.notifyChange();
  }

  async updateSecurity(
    userId: string,
    security: Partial<UserProfile['security']>
  ): Promise<void> {
    const profile = await this.get(userId);
    if (!profile) return;

    const updatedSecurity = { ...profile.security, ...security };
    await this.runtime.runSql(
      `UPDATE userProfile SET security = ?, updatedAt = ? WHERE userId = ?`,
      [jsonToSql(updatedSecurity), dateToSql(new Date()), userId]
    );
    this.notifyChange();
  }

  async isUsernameTaken(
    username: string,
    excludeUserId?: string
  ): Promise<boolean> {
    let sql = `SELECT COUNT(*) as count FROM userProfile WHERE username = ?`;
    const params: unknown[] = [username];

    if (excludeUserId) {
      sql += ` AND userId != ?`;
      params.push(excludeUserId);
    }

    const rows = await this.runtime.executeSql<{ count: number }>(sql, params);
    return (rows[0]?.count || 0) > 0;
  }

  async getByUsername(username: string): Promise<UserProfile | undefined> {
    const rows = await this.runtime.executeSql<UserProfileRow>(
      `SELECT * FROM userProfile WHERE username = ?`,
      [username]
    );
    return rows.length > 0 ? rowToUserProfile(rows[0]) : undefined;
  }

  // ============ Internal ============

  private notifyChange(): void {
    this.changeSubject.next(this.changeSubject.getValue() + 1);
  }
}
