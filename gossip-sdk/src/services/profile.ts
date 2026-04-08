/**
 * Profile Service
 *
 * Manages user profiles (get, save, delete, validate, etc.).
 * Only requires Queries and IMessageProtocol — no session needed,
 * so it can be created at init() time.
 */

import { Logger } from '../utils/logs.js';
import { type UserProfile } from '../db/index.js';
import {
  Queries,
  rowToUserProfile,
  userProfileToRow,
} from '../db/queries/index.js';
import {
  validateUsernameFormatAndAvailability,
  type ValidationResult,
} from '../utils/validation.js';
import { IMessageProtocol } from '../api/messageProtocol/index.js';

export class ProfileService {
  private queries: Queries;
  private messageProtocol: IMessageProtocol;

  private logger = new Logger('ProfileService');

  constructor(queries: Queries, messageProtocol: IMessageProtocol) {
    this.queries = queries;
    this.messageProtocol = messageProtocol;
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

  validateUsername(username: string): Promise<ValidationResult> {
    return validateUsernameFormatAndAvailability(username, this.queries);
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
    session: Uint8Array,
    skipHistoricalAnnouncements: boolean = false
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

    if (skipHistoricalAnnouncements) {
      await this.skipHistoricalAnnouncements(userId);
    }

    return newProfile;
  }

  /**
   * Persist the bulletin polling cursor for the provided user.
   * Stored in a dedicated announcementCursors table (not userProfile).
   */
  private async _upsertLastBulletinCounter(
    nextCounter: string,
    userId: string
  ): Promise<void> {
    await this.queries.announcementCursors.upsert(userId, nextCounter);
  }

  /**
   * Fetch the latest bulletin counter from the API and persist it so that
   * historical announcements (undecryptable by a new account) are skipped.
   * No-op if a counter already exists.
   */
  async skipHistoricalAnnouncements(userId: string): Promise<void> {
    const log = this.logger.forMethod('skipHistoricalAnnouncements');
    const existing = await this.queries.announcementCursors.get(userId);
    if (existing !== undefined) return;

    try {
      const counter = await this.messageProtocol.fetchBulletinCounter();
      await this._upsertLastBulletinCounter(counter, userId);
      log.info('set initial bulletin counter for new account', { counter });
    } catch (err) {
      // Non-critical — on failure the first fetch starts from the beginning.
      log.warn('failed to initialize bulletin counter', { err });
    }
  }
}
