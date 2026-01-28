/**
 * DatabaseAdapter - Compatibility layer between StorageManager and GossipDatabase interface.
 *
 * This adapter allows the SDK to use the new StorageManager while maintaining
 * backward compatibility with existing code that expects the GossipDatabase interface.
 *
 * Usage:
 * ```typescript
 * const storage = await StorageManager.create({ type: 'encrypted-sqlite', password: '...' });
 * const dbAdapter = new DatabaseAdapter(storage);
 *
 * // Use dbAdapter anywhere GossipDatabase is expected
 * await gossipSdk.init({ db: dbAdapter });
 * ```
 */

import type { StorageManager } from '../StorageManager';
import type {
  Contact,
  Message,
  UserProfile,
  Discussion,
  PendingEncryptedMessage,
  PendingAnnouncement,
  ActiveSeeker,
  MessageDirection,
  MessageStatus,
  DiscussionStatus,
  DiscussionDirection,
} from '../models';

// Re-export types for convenience
export {
  Contact,
  Message,
  UserProfile,
  Discussion,
  PendingEncryptedMessage,
  PendingAnnouncement,
  ActiveSeeker,
  MessageDirection,
  MessageStatus,
  DiscussionStatus,
  DiscussionDirection,
};

/**
 * Minimal Table interface for compatibility with Dexie-style access patterns
 */
interface TableLike<T, K = number> {
  get(id: K): Promise<T | undefined>;
  add(item: Omit<T, 'id'>): Promise<K>;
  put(item: T): Promise<K>;
  update(id: K, changes: Partial<T>): Promise<number>;
  delete(id: K): Promise<void>;
  toArray(): Promise<T[]>;
  where(indexOrKey: string): WhereClauseLike<T>;
  bulkAdd(items: Omit<T, 'id'>[]): Promise<K[]>;
  bulkDelete(ids: K[]): Promise<void>;
  clear(): Promise<void>;
}

interface WhereClauseLike<T> {
  equals(value: unknown): CollectionLike<T>;
}

interface CollectionLike<T> {
  first(): Promise<T | undefined>;
  toArray(): Promise<T[]>;
  count(): Promise<number>;
  modify(changes: Partial<T> | ((item: T) => void)): Promise<number>;
  delete(): Promise<number>;
  and(filter: (item: T) => boolean): CollectionLike<T>;
  sortBy(key: keyof T): Promise<T[]>;
  reverse(): CollectionLike<T>;
  limit(n: number): CollectionLike<T>;
}

/**
 * DatabaseAdapter provides a GossipDatabase-compatible interface
 * backed by StorageManager repositories.
 */
export class DatabaseAdapter {
  constructor(private storage: StorageManager) {}

  // ============ Table-like accessors ============

  /**
   * Contacts table adapter
   */
  get contacts(): TableLike<Contact> {
    return this.createTableAdapter(
      () => this.storage.contacts.getAll(),
      id => this.storage.contacts.get(id),
      item => this.storage.contacts.create(item),
      (id, changes) => this.storage.contacts.update(id, changes),
      id => this.storage.contacts.delete(id)
    );
  }

  /**
   * Messages table adapter
   */
  get messages(): TableLike<Message> {
    return this.createTableAdapter(
      () => this.storage.messages.getAll(),
      id => this.storage.messages.get(id),
      item => this.storage.messages.create(item),
      (id, changes) => this.storage.messages.update(id, changes),
      id => this.storage.messages.delete(id)
    );
  }

  /**
   * User profile table adapter (uses string key)
   */
  get userProfile(): TableLike<UserProfile, string> {
    return {
      get: id => this.storage.userProfile.get(id),
      add: async item => {
        await this.storage.userProfile.create(item as UserProfile);
        return (item as UserProfile).userId;
      },
      put: async item => {
        const existing = await this.storage.userProfile.get(item.userId);
        if (existing) {
          await this.storage.userProfile.update(item.userId, item);
        } else {
          await this.storage.userProfile.create(item);
        }
        return item.userId;
      },
      update: async (id, changes) => {
        const result = await this.storage.userProfile.update(id, changes);
        return result ? 1 : 0;
      },
      delete: async id => {
        await this.storage.userProfile.delete(id);
      },
      toArray: () => this.storage.userProfile.getAll(),
      where: () => this.createWhereClauseUserProfile(),
      bulkAdd: async items => {
        const ids: string[] = [];
        for (const item of items) {
          await this.storage.userProfile.create(item as UserProfile);
          ids.push((item as UserProfile).userId);
        }
        return ids;
      },
      bulkDelete: async ids => {
        for (const id of ids) {
          await this.storage.userProfile.delete(id);
        }
      },
      clear: async () => {
        const all = await this.storage.userProfile.getAll();
        for (const item of all) {
          await this.storage.userProfile.delete(item.userId);
        }
      },
    };
  }

  /**
   * Discussions table adapter
   */
  get discussions(): TableLike<Discussion> {
    return this.createTableAdapter(
      () => this.storage.discussions.getAll(),
      id => this.storage.discussions.get(id),
      item => this.storage.discussions.create(item),
      (id, changes) => this.storage.discussions.update(id, changes),
      id => this.storage.discussions.delete(id)
    );
  }

  /**
   * Pending encrypted messages table adapter
   */
  get pendingEncryptedMessages(): TableLike<PendingEncryptedMessage> {
    return this.createTableAdapter(
      () => this.storage.pendingMessages.getAll(),
      id => this.storage.pendingMessages.get(id),
      item => this.storage.pendingMessages.create(item),
      (id, changes) => this.storage.pendingMessages.update(id, changes),
      id => this.storage.pendingMessages.delete(id)
    );
  }

  /**
   * Pending announcements table adapter
   */
  get pendingAnnouncements(): TableLike<PendingAnnouncement> {
    return this.createTableAdapter(
      () => this.storage.pendingAnnouncements.getAll(),
      id => this.storage.pendingAnnouncements.get(id),
      item => this.storage.pendingAnnouncements.create(item),
      (id, changes) => this.storage.pendingAnnouncements.update(id, changes),
      id => this.storage.pendingAnnouncements.delete(id)
    );
  }

  /**
   * Active seekers table adapter
   */
  get activeSeekers(): TableLike<ActiveSeeker> {
    return this.createTableAdapter(
      () => this.storage.activeSeekers.getAll(),
      id => this.storage.activeSeekers.get(id),
      item => this.storage.activeSeekers.create(item),
      (id, changes) => this.storage.activeSeekers.update(id, changes),
      id => this.storage.activeSeekers.delete(id)
    );
  }

  // ============ Helper methods (from GossipDatabase) ============

  async getContactsByOwner(ownerUserId: string): Promise<Contact[]> {
    return this.storage.contacts.getByOwner(ownerUserId);
  }

  async getContactByOwnerAndUserId(
    ownerUserId: string,
    userId: string
  ): Promise<Contact | undefined> {
    return this.storage.contacts.getByOwnerAndUserId(ownerUserId, userId);
  }

  async getDiscussionsByOwner(ownerUserId: string): Promise<Discussion[]> {
    return this.storage.discussions.getByOwner(ownerUserId);
  }

  async getUnreadCountByOwner(ownerUserId: string): Promise<number> {
    return this.storage.discussions.getUnreadCount(ownerUserId);
  }

  async getDiscussionByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string
  ): Promise<Discussion | undefined> {
    return this.storage.discussions.getByOwnerAndContact(
      ownerUserId,
      contactUserId
    );
  }

  async getActiveDiscussionsByOwner(
    ownerUserId: string
  ): Promise<Discussion[]> {
    return this.storage.discussions.getActive(ownerUserId);
  }

  async markMessagesAsRead(
    ownerUserId: string,
    contactUserId: string
  ): Promise<void> {
    await this.storage.messages.markAsRead(ownerUserId, contactUserId);
    const discussion = await this.storage.discussions.getByOwnerAndContact(
      ownerUserId,
      contactUserId
    );
    if (discussion?.id) {
      await this.storage.discussions.resetUnreadCount(discussion.id);
    }
  }

  async getMessagesForContactByOwner(
    ownerUserId: string,
    contactUserId: string,
    limit = 50
  ): Promise<Message[]> {
    return this.storage.messages.getByContact(ownerUserId, contactUserId, {
      limit,
    });
  }

  async addMessage(message: Omit<Message, 'id'>): Promise<number> {
    const created =
      await this.storage.messages.addWithDiscussionUpdate(message);
    return created.id!;
  }

  async updateLastSyncTimestamp(
    discussionId: number,
    timestamp: Date
  ): Promise<void> {
    await this.storage.discussions.updateLastSyncTimestamp(
      discussionId,
      timestamp
    );
  }

  async deleteDb(): Promise<void> {
    await this.storage.deleteAll();
  }

  async setActiveSeekers(seekers: Uint8Array[]): Promise<void> {
    await this.storage.activeSeekers.setAll(seekers);
  }

  async getActiveSeekers(): Promise<Uint8Array[]> {
    return this.storage.activeSeekers.getAllSeekers();
  }

  // ============ Dexie-like methods ============

  async open(): Promise<void> {
    // No-op - StorageManager handles initialization
  }

  close(): void {
    // No-op - StorageManager handles cleanup
  }

  async transaction<T>(
    _mode: string,
    _tables: unknown,
    fn: () => Promise<T>
  ): Promise<T> {
    // Simple implementation - no true transaction support yet
    return fn();
  }

  // ============ Internal helpers ============

  private createTableAdapter<T extends { id?: number }>(
    getAll: () => Promise<T[]>,
    get: (id: number) => Promise<T | undefined>,
    create: (item: Omit<T, 'id'>) => Promise<T>,
    update: (id: number, changes: Partial<T>) => Promise<T | undefined>,
    del: (id: number) => Promise<boolean>
  ): TableLike<T> {
    return {
      get,
      add: async item => {
        const created = await create(item);
        return (created as { id: number }).id;
      },
      put: async item => {
        if (item.id) {
          await update(item.id, item);
          return item.id;
        }
        const created = await create(item);
        return (created as { id: number }).id;
      },
      update: async (id, changes) => {
        const result = await update(id, changes);
        return result ? 1 : 0;
      },
      delete: async id => {
        await del(id);
      },
      toArray: getAll,
      where: indexKey => this.createWhereClause(getAll, indexKey),
      bulkAdd: async items => {
        const ids: number[] = [];
        for (const item of items) {
          const created = await create(item);
          ids.push((created as { id: number }).id);
        }
        return ids;
      },
      bulkDelete: async ids => {
        for (const id of ids) {
          await del(id);
        }
      },
      clear: async () => {
        const all = await getAll();
        for (const item of all) {
          if (item.id) await del(item.id);
        }
      },
    };
  }

  private createWhereClause<T>(
    getAll: () => Promise<T[]>,
    indexKey: string
  ): WhereClauseLike<T> {
    return {
      equals: (value: unknown) =>
        this.createCollection(getAll, indexKey, value),
    };
  }

  private createCollection<T>(
    getAll: () => Promise<T[]>,
    indexKey: string,
    value: unknown
  ): CollectionLike<T> {
    let filterFn: (item: T) => boolean = () => true;
    let items: T[] | null = null;

    const applyFilter = async (): Promise<T[]> => {
      if (!items) {
        const all = await getAll();
        // Handle composite keys like [ownerUserId+contactUserId]
        if (indexKey.startsWith('[') && indexKey.endsWith(']')) {
          const keys = indexKey.slice(1, -1).split('+');
          const values = value as unknown[];
          items = all.filter(item => {
            return keys.every(
              (key, i) => (item as Record<string, unknown>)[key] === values[i]
            );
          });
        } else {
          items = all.filter(
            item => (item as Record<string, unknown>)[indexKey] === value
          );
        }
      }
      return items.filter(filterFn);
    };

    const collection: CollectionLike<T> = {
      first: async () => {
        const filtered = await applyFilter();
        return filtered[0];
      },
      toArray: applyFilter,
      count: async () => {
        const filtered = await applyFilter();
        return filtered.length;
      },
      modify: async _changes => {
        const filtered = await applyFilter();
        // This would need actual repository update calls
        // For now, return count
        return filtered.length;
      },
      delete: async () => {
        const filtered = await applyFilter();
        return filtered.length;
      },
      and: filter => {
        const prevFilter = filterFn;
        filterFn = item => prevFilter(item) && filter(item);
        return collection;
      },
      sortBy: async key => {
        const filtered = await applyFilter();
        return filtered.sort((a, b) => {
          const aVal = (a as Record<string, unknown>)[key as string] as
            | string
            | number
            | Date;
          const bVal = (b as Record<string, unknown>)[key as string] as
            | string
            | number
            | Date;
          if (aVal < bVal) return -1;
          if (aVal > bVal) return 1;
          return 0;
        });
      },
      reverse: () => {
        const prevFilter = filterFn;
        filterFn = item => prevFilter(item);
        // Would need to reverse results
        return collection;
      },
      limit: _n => {
        // Would need to limit results
        return collection;
      },
    };

    return collection;
  }

  private createWhereClauseUserProfile(): WhereClauseLike<UserProfile> {
    return {
      equals: (value: unknown) => ({
        first: async () => {
          const all = await this.storage.userProfile.getAll();
          return all.find(p => p.userId === value);
        },
        toArray: async () => {
          const all = await this.storage.userProfile.getAll();
          return all.filter(p => p.userId === value);
        },
        count: async () => {
          const all = await this.storage.userProfile.getAll();
          return all.filter(p => p.userId === value).length;
        },
        modify: async () => 0,
        delete: async () => 0,
        and: () => this.createWhereClauseUserProfile().equals(value),
        sortBy: async () => [],
        reverse: () => this.createWhereClauseUserProfile().equals(value),
        limit: () => this.createWhereClauseUserProfile().equals(value),
      }),
    };
  }

  /**
   * Get the underlying StorageManager
   */
  getStorageManager(): StorageManager {
    return this.storage;
  }
}
