/**
 * Dexie implementation of IContactRepository
 */

import { liveQuery } from 'dexie';
import type { GossipDatabase, Contact as DexieContact } from '../../../db';
import type { IContactRepository } from '../../interfaces/repositories';
import type { Contact } from '../../models';
import type { Observable } from '../../base/Observable';
import { fromDexieLiveQuery } from '../../base/Observable';

export class DexieContactRepository implements IContactRepository {
  constructor(private db: GossipDatabase) {}

  // ============ Basic CRUD ============

  async get(id: number): Promise<Contact | undefined> {
    return (await this.db.contacts.get(id)) as Contact | undefined;
  }

  async getAll(): Promise<Contact[]> {
    return (await this.db.contacts.toArray()) as Contact[];
  }

  async create(entity: Omit<Contact, 'id'>): Promise<Contact> {
    const id = await this.db.contacts.add(entity as DexieContact);
    return { ...entity, id } as Contact;
  }

  async update(
    id: number,
    changes: Partial<Contact>
  ): Promise<Contact | undefined> {
    await this.db.contacts.update(id, changes);
    return await this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await this.db.contacts.delete(id);
    return true;
  }

  // ============ Reactivity ============

  observe(id: number): Observable<Contact | undefined> {
    return fromDexieLiveQuery(
      () => this.db.contacts.get(id) as Promise<Contact | undefined>,
      liveQuery
    );
  }

  observeAll(): Observable<Contact[]> {
    return fromDexieLiveQuery(
      () => this.db.contacts.toArray() as Promise<Contact[]>,
      liveQuery
    );
  }

  // ============ Domain-specific ============

  async getByOwner(ownerUserId: string): Promise<Contact[]> {
    return (await this.db.getContactsByOwner(ownerUserId)) as Contact[];
  }

  async getByOwnerAndUserId(
    ownerUserId: string,
    userId: string
  ): Promise<Contact | undefined> {
    return (await this.db.getContactByOwnerAndUserId(ownerUserId, userId)) as
      | Contact
      | undefined;
  }

  observeByOwner(ownerUserId: string): Observable<Contact[]> {
    return fromDexieLiveQuery(
      () =>
        this.db.contacts
          .where('ownerUserId')
          .equals(ownerUserId)
          .toArray() as Promise<Contact[]>,
      liveQuery
    );
  }

  async updateOnlineStatus(
    ownerUserId: string,
    userId: string,
    isOnline: boolean
  ): Promise<void> {
    const contact = await this.getByOwnerAndUserId(ownerUserId, userId);
    if (contact && contact.id) {
      await this.db.contacts.update(contact.id, {
        isOnline,
        lastSeen: isOnline ? new Date() : contact.lastSeen,
      });
    }
  }

  async searchByName(ownerUserId: string, query: string): Promise<Contact[]> {
    const lowerQuery = query.toLowerCase();
    return (await this.db.contacts
      .where('ownerUserId')
      .equals(ownerUserId)
      .and(contact => contact.name.toLowerCase().includes(lowerQuery))
      .toArray()) as Contact[];
  }
}
