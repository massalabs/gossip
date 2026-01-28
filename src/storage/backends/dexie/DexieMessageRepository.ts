/**
 * Dexie implementation of IMessageRepository
 */

import { liveQuery } from 'dexie';
import type { GossipDatabase, Message as DexieMessage } from '../../../db';
import { MessageDirection, MessageStatus } from '../../../db';
import type { IMessageRepository } from '../../interfaces/repositories';
import type { Message, MessageType } from '../../models';
import type { Observable } from '../../base/Observable';
import { fromDexieLiveQuery } from '../../base/Observable';

export class DexieMessageRepository implements IMessageRepository {
  constructor(private db: GossipDatabase) {}

  // ============ Basic CRUD ============

  async get(id: number): Promise<Message | undefined> {
    return (await this.db.messages.get(id)) as Message | undefined;
  }

  async getAll(): Promise<Message[]> {
    return (await this.db.messages.toArray()) as Message[];
  }

  async create(entity: Omit<Message, 'id'>): Promise<Message> {
    const id = await this.db.messages.add(entity as DexieMessage);
    return { ...entity, id } as Message;
  }

  async update(
    id: number,
    changes: Partial<Message>
  ): Promise<Message | undefined> {
    await this.db.messages.update(id, changes);
    return await this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await this.db.messages.delete(id);
    return true;
  }

  // ============ Reactivity ============

  observe(id: number): Observable<Message | undefined> {
    return fromDexieLiveQuery(
      () => this.db.messages.get(id) as Promise<Message | undefined>,
      liveQuery
    );
  }

  observeAll(): Observable<Message[]> {
    return fromDexieLiveQuery(
      () => this.db.messages.toArray() as Promise<Message[]>,
      liveQuery
    );
  }

  // ============ Domain-specific ============

  async getByContact(
    ownerUserId: string,
    contactUserId: string,
    options?: {
      limit?: number;
      offset?: number;
      excludeTypes?: MessageType[];
    }
  ): Promise<Message[]> {
    let query = this.db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([ownerUserId, contactUserId]);

    if (options?.excludeTypes?.length) {
      query = query.and(
        msg => !options.excludeTypes!.includes(msg.type as MessageType)
      );
    }

    let collection = query.reverse();

    if (options?.limit) {
      collection = collection.limit(options.limit);
    }

    if (options?.offset) {
      collection = collection.offset(options.offset);
    }

    return (await collection.toArray()) as Message[];
  }

  async getByOwner(
    ownerUserId: string,
    options?: { excludeTypes?: MessageType[] }
  ): Promise<Message[]> {
    let query = this.db.messages.where('ownerUserId').equals(ownerUserId);

    if (options?.excludeTypes?.length) {
      query = query.and(
        msg => !options.excludeTypes!.includes(msg.type as MessageType)
      );
    }

    return (await query.toArray()) as Message[];
  }

  async getByStatus(
    ownerUserId: string,
    status: MessageStatus
  ): Promise<Message[]> {
    return (await this.db.messages
      .where('[ownerUserId+status]')
      .equals([ownerUserId, status])
      .toArray()) as Message[];
  }

  async getBySeeker(
    ownerUserId: string,
    seeker: Uint8Array
  ): Promise<Message | undefined> {
    return (await this.db.messages
      .where('[ownerUserId+seeker]')
      .equals([ownerUserId, seeker])
      .first()) as Message | undefined;
  }

  observeByContact(
    ownerUserId: string,
    contactUserId: string
  ): Observable<Message[]> {
    return fromDexieLiveQuery(
      () =>
        this.db.messages
          .where('[ownerUserId+contactUserId]')
          .equals([ownerUserId, contactUserId])
          .toArray() as Promise<Message[]>,
      liveQuery
    );
  }

  observeByOwner(
    ownerUserId: string,
    options?: { excludeTypes?: MessageType[] }
  ): Observable<Message[]> {
    return fromDexieLiveQuery(() => {
      let query = this.db.messages.where('ownerUserId').equals(ownerUserId);
      if (options?.excludeTypes?.length) {
        query = query.and(
          msg => !options.excludeTypes!.includes(msg.type as MessageType)
        );
      }
      return query.sortBy('id') as Promise<Message[]>;
    }, liveQuery);
  }

  async updateStatus(id: number, status: MessageStatus): Promise<void> {
    await this.db.messages.update(id, { status });
  }

  async updateSeeker(id: number, seeker: Uint8Array): Promise<void> {
    await this.db.messages.update(id, { seeker });
  }

  async markAsRead(
    ownerUserId: string,
    contactUserId: string
  ): Promise<number> {
    const messages = await this.db.messages
      .where('[ownerUserId+contactUserId+status]')
      .equals([ownerUserId, contactUserId, MessageStatus.DELIVERED])
      .and(msg => msg.direction === MessageDirection.INCOMING)
      .toArray();

    if (messages.length === 0) return 0;

    await this.db.messages
      .where('[ownerUserId+contactUserId+status]')
      .equals([ownerUserId, contactUserId, MessageStatus.DELIVERED])
      .and(msg => msg.direction === MessageDirection.INCOMING)
      .modify({ status: MessageStatus.READ });

    return messages.length;
  }

  async getWaitingForSession(ownerUserId: string): Promise<Message[]> {
    return (await this.db.messages
      .where('[ownerUserId+status]')
      .equals([ownerUserId, MessageStatus.WAITING_SESSION])
      .toArray()) as Message[];
  }

  async getFailed(ownerUserId: string): Promise<Message[]> {
    return (await this.db.messages
      .where('[ownerUserId+status]')
      .equals([ownerUserId, MessageStatus.FAILED])
      .toArray()) as Message[];
  }

  async addWithDiscussionUpdate(
    message: Omit<Message, 'id'>
  ): Promise<Message> {
    const id = await this.db.addMessage(message as DexieMessage);
    return { ...message, id } as Message;
  }
}
