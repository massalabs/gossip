/**
 * Dexie implementation of IUserProfileRepository
 */

import { liveQuery } from 'dexie';
import type {
  GossipDatabase,
  UserProfile as DexieUserProfile,
} from '../../../db';
import type { IUserProfileRepository } from '../../interfaces/repositories';
import type { UserProfile } from '../../models';
import type { Observable } from '../../base/Observable';
import { fromDexieLiveQuery } from '../../base/Observable';

export class DexieUserProfileRepository implements IUserProfileRepository {
  constructor(private db: GossipDatabase) {}

  // ============ Basic CRUD ============

  async get(userId: string): Promise<UserProfile | undefined> {
    return (await this.db.userProfile.get(userId)) as UserProfile | undefined;
  }

  async getAll(): Promise<UserProfile[]> {
    return (await this.db.userProfile.toArray()) as UserProfile[];
  }

  async getFirst(): Promise<UserProfile | undefined> {
    return (await this.db.userProfile.toCollection().first()) as
      | UserProfile
      | undefined;
  }

  async create(profile: UserProfile): Promise<UserProfile> {
    const now = new Date();
    const toCreate = {
      ...profile,
      createdAt: profile.createdAt || now,
      updatedAt: profile.updatedAt || now,
    };
    await this.db.userProfile.add(toCreate as DexieUserProfile);
    return toCreate;
  }

  async update(
    userId: string,
    changes: Partial<Omit<UserProfile, 'userId'>>
  ): Promise<UserProfile | undefined> {
    await this.db.userProfile.update(userId, {
      ...changes,
      updatedAt: new Date(),
    });
    return await this.get(userId);
  }

  async delete(userId: string): Promise<boolean> {
    const existing = await this.get(userId);
    if (!existing) return false;
    await this.db.userProfile.delete(userId);
    return true;
  }

  // ============ Reactivity ============

  observe(userId: string): Observable<UserProfile | undefined> {
    return fromDexieLiveQuery(
      () => this.db.userProfile.get(userId) as Promise<UserProfile | undefined>,
      liveQuery
    );
  }

  observeAll(): Observable<UserProfile[]> {
    return fromDexieLiveQuery(
      () => this.db.userProfile.toArray() as Promise<UserProfile[]>,
      liveQuery
    );
  }

  // ============ Domain-specific ============

  async updateSession(userId: string, session: Uint8Array): Promise<void> {
    await this.db.userProfile.update(userId, {
      session,
      updatedAt: new Date(),
    });
  }

  async updateSecurity(
    userId: string,
    security: Partial<UserProfile['security']>
  ): Promise<void> {
    const profile = await this.get(userId);
    if (profile) {
      await this.db.userProfile.update(userId, {
        security: { ...profile.security, ...security },
        updatedAt: new Date(),
      });
    }
  }

  async isUsernameTaken(
    username: string,
    excludeUserId?: string
  ): Promise<boolean> {
    const profile = await this.db.userProfile
      .where('username')
      .equals(username)
      .first();

    if (!profile) return false;
    if (excludeUserId && profile.userId === excludeUserId) return false;
    return true;
  }

  async getByUsername(username: string): Promise<UserProfile | undefined> {
    return (await this.db.userProfile
      .where('username')
      .equals(username)
      .first()) as UserProfile | undefined;
  }
}
