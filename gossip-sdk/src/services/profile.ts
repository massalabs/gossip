/**
 * Profile Service
 *
 * Manages user profiles (get, save, delete, validate, etc.).
 * Only requires Queries — no session needed, so it can be created at init() time.
 */

import { type UserProfile } from '../db/index.js';
import {
  Queries,
  rowToUserProfile,
  userProfileToRow,
} from '../db/queries/index.js';

export class ProfileService {
  private queries: Queries;

  constructor(queries: Queries) {
    this.queries = queries;
  }

  async get(userId: string): Promise<UserProfile | null> {
    const row = await this.queries.userProfiles.getById(userId);
    return row ? rowToUserProfile(row) : null;
  }

  async getMostRecent(): Promise<UserProfile | null> {
    const row = await this.queries.userProfiles.getMostRecent();
    return row ? rowToUserProfile(row) : null;
  }

  async getAll(): Promise<UserProfile[]> {
    const rows = await this.queries.userProfiles.getAll();
    return rows.map(rowToUserProfile);
  }

  getCount(): Promise<number> {
    return this.queries.userProfiles.getCount();
  }

  async save(profile: UserProfile): Promise<void> {
    await this.queries.userProfiles.upsert(userProfileToRow(profile));
  }

  delete(userId: string): Promise<void> {
    return this.queries.userProfiles.delete(userId);
  }

  async isUsernameTaken(
    username: string,
    excludeUserId?: string
  ): Promise<boolean> {
    const match = excludeUserId
      ? await this.queries.userProfiles.getByUsernameLowerExcluding(
          username,
          excludeUserId
        )
      : await this.queries.userProfiles.getByUsernameLower(username);
    return !!match;
  }

  async createOrUpdate(
    username: string,
    userId: string,
    security: UserProfile['security'],
    session: Uint8Array
  ): Promise<UserProfile> {
    const existing = await this.queries.userProfiles.getById(userId);
    if (existing) {
      const existingProfile = rowToUserProfile(existing);
      const mergedSecurity: UserProfile['security'] = {
        ...existingProfile.security,
        ...security,
        webauthn: security.webauthn ?? existingProfile.security.webauthn,
        encKeySalt: security.encKeySalt ?? existingProfile.security.encKeySalt,
        mnemonicBackup: security.mnemonicBackup,
      };
      const updatedProfile: UserProfile = {
        ...existingProfile,
        username: existingProfile.username || username,
        security: mergedSecurity,
        session,
        status: existingProfile.status ?? 'online',
        lastSeen: new Date(),
        updatedAt: new Date(),
      };
      await this.queries.userProfiles.upsert(userProfileToRow(updatedProfile));
      return updatedProfile;
    }

    const newProfile: UserProfile = {
      userId,
      username,
      security,
      session,
      status: 'online',
      lastSeen: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await this.queries.userProfiles.upsert(userProfileToRow(newProfile));
    return newProfile;
  }
}
