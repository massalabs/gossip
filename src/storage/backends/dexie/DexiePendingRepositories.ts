/**
 * Dexie implementations of pending/queue repositories
 */

import { liveQuery } from 'dexie';
import type {
  GossipDatabase,
  PendingEncryptedMessage,
  PendingAnnouncement,
  ActiveSeeker,
} from '../../../db';
import type {
  IPendingMessageRepository,
  IPendingAnnouncementRepository,
  IActiveSeekerRepository,
} from '../../interfaces/repositories';
import type { Observable } from '../../base/Observable';
import { fromDexieLiveQuery, map } from '../../base/Observable';
import { setActiveSeekersInPreferences } from '../../../utils/preferences';

// ============ Helper for Uint8Array comparison ============

function uint8ArrayEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ============ PendingMessageRepository ============

export class DexiePendingMessageRepository implements IPendingMessageRepository {
  constructor(private db: GossipDatabase) {}

  async get(id: number): Promise<PendingEncryptedMessage | undefined> {
    return await this.db.pendingEncryptedMessages.get(id);
  }

  async getAll(): Promise<PendingEncryptedMessage[]> {
    return await this.db.pendingEncryptedMessages.toArray();
  }

  async getAllOrdered(): Promise<PendingEncryptedMessage[]> {
    return await this.db.pendingEncryptedMessages
      .orderBy('fetchedAt')
      .toArray();
  }

  async create(
    entity: Omit<PendingEncryptedMessage, 'id'>
  ): Promise<PendingEncryptedMessage> {
    const id = await this.db.pendingEncryptedMessages.add(
      entity as PendingEncryptedMessage
    );
    return { ...entity, id };
  }

  async update(
    id: number,
    changes: Partial<PendingEncryptedMessage>
  ): Promise<PendingEncryptedMessage | undefined> {
    await this.db.pendingEncryptedMessages.update(id, changes);
    return await this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await this.db.pendingEncryptedMessages.delete(id);
    return true;
  }

  observe(id: number): Observable<PendingEncryptedMessage | undefined> {
    return fromDexieLiveQuery(
      () => this.db.pendingEncryptedMessages.get(id),
      liveQuery
    );
  }

  observeAll(): Observable<PendingEncryptedMessage[]> {
    return fromDexieLiveQuery(
      () => this.db.pendingEncryptedMessages.toArray(),
      liveQuery
    );
  }

  async createMany(
    entities: Omit<PendingEncryptedMessage, 'id'>[]
  ): Promise<PendingEncryptedMessage[]> {
    const ids = await this.db.pendingEncryptedMessages.bulkAdd(
      entities as PendingEncryptedMessage[],
      { allKeys: true }
    );
    return entities.map((e, i) => ({ ...e, id: ids[i] }));
  }

  async deleteMany(ids: number[]): Promise<number> {
    await this.db.pendingEncryptedMessages.bulkDelete(ids);
    return ids.length;
  }

  async clear(): Promise<void> {
    await this.db.pendingEncryptedMessages.clear();
  }

  async getBySeeker(
    seeker: Uint8Array
  ): Promise<PendingEncryptedMessage | undefined> {
    return await this.db.pendingEncryptedMessages
      .where('seeker')
      .equals(seeker)
      .first();
  }

  async hasSeeker(seeker: Uint8Array): Promise<boolean> {
    const msg = await this.getBySeeker(seeker);
    return msg !== undefined;
  }

  async deleteBySeeker(seeker: Uint8Array): Promise<boolean> {
    const msg = await this.getBySeeker(seeker);
    if (!msg || !msg.id) return false;
    await this.db.pendingEncryptedMessages.delete(msg.id);
    return true;
  }

  observeCount(): Observable<number> {
    return map(this.observeAll(), msgs => msgs.length);
  }
}

// ============ PendingAnnouncementRepository ============

export class DexiePendingAnnouncementRepository implements IPendingAnnouncementRepository {
  constructor(private db: GossipDatabase) {}

  async get(id: number): Promise<PendingAnnouncement | undefined> {
    return await this.db.pendingAnnouncements.get(id);
  }

  async getAll(): Promise<PendingAnnouncement[]> {
    return await this.db.pendingAnnouncements.toArray();
  }

  async getAllOrdered(): Promise<PendingAnnouncement[]> {
    return await this.db.pendingAnnouncements.orderBy('fetchedAt').toArray();
  }

  async create(
    entity: Omit<PendingAnnouncement, 'id'>
  ): Promise<PendingAnnouncement> {
    const id = await this.db.pendingAnnouncements.add(
      entity as PendingAnnouncement
    );
    return { ...entity, id };
  }

  async update(
    id: number,
    changes: Partial<PendingAnnouncement>
  ): Promise<PendingAnnouncement | undefined> {
    await this.db.pendingAnnouncements.update(id, changes);
    return await this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await this.db.pendingAnnouncements.delete(id);
    return true;
  }

  observe(id: number): Observable<PendingAnnouncement | undefined> {
    return fromDexieLiveQuery(
      () => this.db.pendingAnnouncements.get(id),
      liveQuery
    );
  }

  observeAll(): Observable<PendingAnnouncement[]> {
    return fromDexieLiveQuery(
      () => this.db.pendingAnnouncements.toArray(),
      liveQuery
    );
  }

  async createMany(
    entities: Omit<PendingAnnouncement, 'id'>[]
  ): Promise<PendingAnnouncement[]> {
    const ids = await this.db.pendingAnnouncements.bulkAdd(
      entities as PendingAnnouncement[],
      { allKeys: true }
    );
    return entities.map((e, i) => ({ ...e, id: ids[i] }));
  }

  async deleteMany(ids: number[]): Promise<number> {
    await this.db.pendingAnnouncements.bulkDelete(ids);
    return ids.length;
  }

  async clear(): Promise<void> {
    await this.db.pendingAnnouncements.clear();
  }

  async hasAnnouncement(announcement: Uint8Array): Promise<boolean> {
    const existing = await this.db.pendingAnnouncements
      .where('announcement')
      .equals(announcement)
      .first();
    return existing !== undefined;
  }

  async deleteByAnnouncement(announcement: Uint8Array): Promise<boolean> {
    const existing = await this.db.pendingAnnouncements
      .where('announcement')
      .equals(announcement)
      .first();
    if (!existing || !existing.id) return false;
    await this.db.pendingAnnouncements.delete(existing.id);
    return true;
  }

  async getLatestCounter(): Promise<string | undefined> {
    const all = await this.db.pendingAnnouncements
      .orderBy('fetchedAt')
      .reverse()
      .first();
    return all?.counter;
  }

  observeCount(): Observable<number> {
    return map(this.observeAll(), announcements => announcements.length);
  }
}

// ============ ActiveSeekerRepository ============

export class DexieActiveSeekerRepository implements IActiveSeekerRepository {
  constructor(private db: GossipDatabase) {}

  async get(id: number): Promise<ActiveSeeker | undefined> {
    return await this.db.activeSeekers.get(id);
  }

  async getAll(): Promise<ActiveSeeker[]> {
    return await this.db.activeSeekers.toArray();
  }

  async create(entity: Omit<ActiveSeeker, 'id'>): Promise<ActiveSeeker> {
    const id = await this.db.activeSeekers.add(entity as ActiveSeeker);
    return { ...entity, id };
  }

  async update(
    id: number,
    changes: Partial<ActiveSeeker>
  ): Promise<ActiveSeeker | undefined> {
    await this.db.activeSeekers.update(id, changes);
    return await this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await this.db.activeSeekers.delete(id);
    return true;
  }

  observe(id: number): Observable<ActiveSeeker | undefined> {
    return fromDexieLiveQuery(() => this.db.activeSeekers.get(id), liveQuery);
  }

  observeAll(): Observable<ActiveSeeker[]> {
    return fromDexieLiveQuery(() => this.db.activeSeekers.toArray(), liveQuery);
  }

  async createMany(
    entities: Omit<ActiveSeeker, 'id'>[]
  ): Promise<ActiveSeeker[]> {
    const ids = await this.db.activeSeekers.bulkAdd(
      entities as ActiveSeeker[],
      { allKeys: true }
    );
    return entities.map((e, i) => ({ ...e, id: ids[i] }));
  }

  async deleteMany(ids: number[]): Promise<number> {
    await this.db.activeSeekers.bulkDelete(ids);
    return ids.length;
  }

  async clear(): Promise<void> {
    await this.db.activeSeekers.clear();
  }

  async setAll(seekers: Uint8Array[]): Promise<void> {
    await this.db.setActiveSeekers(seekers);
  }

  async getAllSeekers(): Promise<Uint8Array[]> {
    return await this.db.getActiveSeekers();
  }

  async addSeeker(seeker: Uint8Array): Promise<void> {
    // Check if already exists
    const existing = await this.db.activeSeekers.toArray();
    const alreadyExists = existing.some(s =>
      uint8ArrayEquals(s.seeker, seeker)
    );
    if (alreadyExists) return;

    await this.db.activeSeekers.add({ seeker });

    // Sync to preferences
    const allSeekers = await this.getAllSeekers();
    await setActiveSeekersInPreferences(allSeekers);
  }

  async removeSeeker(seeker: Uint8Array): Promise<boolean> {
    const existing = await this.db.activeSeekers.toArray();
    const found = existing.find(s => uint8ArrayEquals(s.seeker, seeker));
    if (!found || !found.id) return false;

    await this.db.activeSeekers.delete(found.id);

    // Sync to preferences
    const allSeekers = await this.getAllSeekers();
    await setActiveSeekersInPreferences(allSeekers);

    return true;
  }

  async hasSeeker(seeker: Uint8Array): Promise<boolean> {
    const existing = await this.db.activeSeekers.toArray();
    return existing.some(s => uint8ArrayEquals(s.seeker, seeker));
  }

  observeCount(): Observable<number> {
    return map(this.observeAll(), seekers => seekers.length);
  }
}
