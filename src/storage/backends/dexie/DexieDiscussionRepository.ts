/**
 * Dexie implementation of IDiscussionRepository
 */

import { liveQuery } from 'dexie';
import type {
  GossipDatabase,
  Discussion as DexieDiscussion,
} from '../../../db';
import { DiscussionStatus, DiscussionDirection } from '../../../db';
import type { IDiscussionRepository } from '../../interfaces/repositories';
import type { Discussion } from '../../models';
import type { Observable } from '../../base/Observable';
import { fromDexieLiveQuery, map } from '../../base/Observable';

export class DexieDiscussionRepository implements IDiscussionRepository {
  constructor(private db: GossipDatabase) {}

  // ============ Basic CRUD ============

  async get(id: number): Promise<Discussion | undefined> {
    return (await this.db.discussions.get(id)) as Discussion | undefined;
  }

  async getAll(): Promise<Discussion[]> {
    return (await this.db.discussions.toArray()) as Discussion[];
  }

  async create(entity: Omit<Discussion, 'id'>): Promise<Discussion> {
    const now = new Date();
    const toCreate = {
      ...entity,
      createdAt: entity.createdAt || now,
      updatedAt: entity.updatedAt || now,
    };
    const id = await this.db.discussions.add(toCreate as DexieDiscussion);
    return { ...toCreate, id } as Discussion;
  }

  async update(
    id: number,
    changes: Partial<Discussion>
  ): Promise<Discussion | undefined> {
    await this.db.discussions.update(id, {
      ...changes,
      updatedAt: new Date(),
    });
    return await this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await this.db.discussions.delete(id);
    return true;
  }

  // ============ Reactivity ============

  observe(id: number): Observable<Discussion | undefined> {
    return fromDexieLiveQuery(
      () => this.db.discussions.get(id) as Promise<Discussion | undefined>,
      liveQuery
    );
  }

  observeAll(): Observable<Discussion[]> {
    return fromDexieLiveQuery(
      () => this.db.discussions.toArray() as Promise<Discussion[]>,
      liveQuery
    );
  }

  // ============ Domain-specific ============

  async getByOwner(ownerUserId: string): Promise<Discussion[]> {
    return (await this.db.getDiscussionsByOwner(ownerUserId)) as Discussion[];
  }

  async getByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string
  ): Promise<Discussion | undefined> {
    return (await this.db.getDiscussionByOwnerAndContact(
      ownerUserId,
      contactUserId
    )) as Discussion | undefined;
  }

  async getByStatus(
    ownerUserId: string,
    status: DiscussionStatus
  ): Promise<Discussion[]> {
    return (await this.db.discussions
      .where('[ownerUserId+status]')
      .equals([ownerUserId, status])
      .toArray()) as Discussion[];
  }

  async getActive(ownerUserId: string): Promise<Discussion[]> {
    return (await this.db.getActiveDiscussionsByOwner(
      ownerUserId
    )) as Discussion[];
  }

  observeByOwner(ownerUserId: string): Observable<Discussion[]> {
    return fromDexieLiveQuery(async () => {
      const discussions = await this.db.discussions
        .where('ownerUserId')
        .equals(ownerUserId)
        .toArray();

      // Sort: pending first, then by last message timestamp
      return discussions.sort((a, b) => {
        // Pending discussions first
        if (
          a.status === DiscussionStatus.PENDING &&
          b.status !== DiscussionStatus.PENDING
        ) {
          return -1;
        }
        if (
          b.status === DiscussionStatus.PENDING &&
          a.status !== DiscussionStatus.PENDING
        ) {
          return 1;
        }

        // Then by last message timestamp (most recent first)
        if (a.lastMessageTimestamp && b.lastMessageTimestamp) {
          return (
            b.lastMessageTimestamp.getTime() - a.lastMessageTimestamp.getTime()
          );
        }
        if (a.lastMessageTimestamp) return -1;
        if (b.lastMessageTimestamp) return 1;

        // Finally by creation date
        return b.createdAt.getTime() - a.createdAt.getTime();
      }) as Discussion[];
    }, liveQuery);
  }

  observeByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string
  ): Observable<Discussion | undefined> {
    return fromDexieLiveQuery(
      () =>
        this.db.discussions
          .where('[ownerUserId+contactUserId]')
          .equals([ownerUserId, contactUserId])
          .first() as Promise<Discussion | undefined>,
      liveQuery
    );
  }

  async getUnreadCount(ownerUserId: string): Promise<number> {
    return await this.db.getUnreadCountByOwner(ownerUserId);
  }

  observeUnreadCount(ownerUserId: string): Observable<number> {
    return map(this.observeByOwner(ownerUserId), discussions =>
      discussions.reduce((total, d) => total + d.unreadCount, 0)
    );
  }

  async updateStatus(id: number, status: DiscussionStatus): Promise<void> {
    await this.db.discussions.update(id, { status, updatedAt: new Date() });
  }

  async updateNextSeeker(id: number, nextSeeker: Uint8Array): Promise<void> {
    await this.db.discussions.update(id, { nextSeeker, updatedAt: new Date() });
  }

  async updateLastSyncTimestamp(id: number, timestamp: Date): Promise<void> {
    await this.db.updateLastSyncTimestamp(id, timestamp);
  }

  async resetUnreadCount(id: number): Promise<void> {
    await this.db.discussions.update(id, {
      unreadCount: 0,
      updatedAt: new Date(),
    });
  }

  async incrementUnreadCount(id: number): Promise<void> {
    const discussion = await this.get(id);
    if (discussion) {
      await this.db.discussions.update(id, {
        unreadCount: discussion.unreadCount + 1,
        updatedAt: new Date(),
      });
    }
  }

  async updateLastMessage(
    id: number,
    messageId: number,
    content: string,
    timestamp: Date
  ): Promise<void> {
    await this.db.discussions.update(id, {
      lastMessageId: messageId,
      lastMessageContent: content,
      lastMessageTimestamp: timestamp,
      updatedAt: new Date(),
    });
  }

  async upsert(
    ownerUserId: string,
    contactUserId: string,
    data: Partial<Omit<Discussion, 'id' | 'ownerUserId' | 'contactUserId'>>
  ): Promise<Discussion> {
    const existing = await this.getByOwnerAndContact(
      ownerUserId,
      contactUserId
    );

    if (existing) {
      await this.update(existing.id!, data);
      return (await this.get(existing.id!))!;
    }

    // Create new discussion with defaults
    const now = new Date();
    const newDiscussion: Omit<Discussion, 'id'> = {
      ownerUserId,
      contactUserId,
      direction: data.direction || DiscussionDirection.INITIATED,
      status: data.status || DiscussionStatus.PENDING,
      unreadCount: data.unreadCount ?? 0,
      createdAt: now,
      updatedAt: now,
      ...data,
    };

    return await this.create(newDiscussion);
  }
}
