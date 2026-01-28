/**
 * Encrypted SQLite implementation of IMessageRepository
 */

import type { IRuntimeAdapter } from '../../interfaces';
import type { IMessageRepository } from '../../interfaces/repositories';
import type {
  Message,
  MessageType,
  MessageStatus,
  MessageDirection,
} from '../../models';
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

interface MessageRow {
  id: number;
  ownerUserId: string;
  contactUserId: string;
  content: string;
  serializedContent: Uint8Array | null;
  type: string;
  direction: string;
  status: string;
  timestamp: string;
  metadata: string | null;
  seeker: Uint8Array | null;
  replyTo: string | null;
  forwardOf: string | null;
  encryptedMessage: Uint8Array | null;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    contactUserId: row.contactUserId,
    content: row.content,
    serializedContent: sqlToBlob(row.serializedContent),
    type: row.type as MessageType,
    direction: row.direction as MessageDirection,
    status: row.status as MessageStatus,
    timestamp: sqlToDate(row.timestamp),
    metadata: sqlToJson(row.metadata),
    seeker: sqlToBlob(row.seeker),
    replyTo: sqlToJson(row.replyTo),
    forwardOf: sqlToJson(row.forwardOf),
    encryptedMessage: sqlToBlob(row.encryptedMessage),
  };
}

export class EncryptedMessageRepository implements IMessageRepository {
  private changeSubject = new BehaviorSubject<number>(0);

  constructor(private runtime: IRuntimeAdapter) {}

  // ============ Basic CRUD ============

  async get(id: number): Promise<Message | undefined> {
    const rows = await this.runtime.executeSql<MessageRow>(
      `SELECT * FROM messages WHERE id = ?`,
      [id]
    );
    return rows.length > 0 ? rowToMessage(rows[0]) : undefined;
  }

  async getAll(): Promise<Message[]> {
    const rows = await this.runtime.executeSql<MessageRow>(
      `SELECT * FROM messages ORDER BY timestamp`
    );
    return rows.map(rowToMessage);
  }

  async create(entity: Omit<Message, 'id'>): Promise<Message> {
    const result = await this.runtime.runSql(
      `INSERT INTO messages (ownerUserId, contactUserId, content, serializedContent, type, direction, status, timestamp, metadata, seeker, replyTo, forwardOf, encryptedMessage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entity.ownerUserId,
        entity.contactUserId,
        entity.content,
        blobToSql(entity.serializedContent),
        entity.type,
        entity.direction,
        entity.status,
        dateToSql(entity.timestamp),
        entity.metadata ? jsonToSql(entity.metadata) : null,
        blobToSql(entity.seeker),
        entity.replyTo ? jsonToSql(entity.replyTo) : null,
        entity.forwardOf ? jsonToSql(entity.forwardOf) : null,
        blobToSql(entity.encryptedMessage),
      ]
    );

    this.notifyChange();

    return {
      ...entity,
      id: result.lastInsertRowid,
    };
  }

  async update(
    id: number,
    changes: Partial<Message>
  ): Promise<Message | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;

    const updates: string[] = [];
    const values: unknown[] = [];

    if (changes.content !== undefined) {
      updates.push('content = ?');
      values.push(changes.content);
    }
    if (changes.status !== undefined) {
      updates.push('status = ?');
      values.push(changes.status);
    }
    if (changes.seeker !== undefined) {
      updates.push('seeker = ?');
      values.push(blobToSql(changes.seeker));
    }
    if (changes.encryptedMessage !== undefined) {
      updates.push('encryptedMessage = ?');
      values.push(blobToSql(changes.encryptedMessage));
    }
    if (changes.metadata !== undefined) {
      updates.push('metadata = ?');
      values.push(jsonToSql(changes.metadata));
    }

    if (updates.length === 0) return existing;

    values.push(id);
    await this.runtime.runSql(
      `UPDATE messages SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    this.notifyChange();

    return await this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.runtime.runSql(
      `DELETE FROM messages WHERE id = ?`,
      [id]
    );
    if (result.changes > 0) {
      this.notifyChange();
      return true;
    }
    return false;
  }

  // ============ Reactivity ============

  observe(id: number): Observable<Message | undefined> {
    const subject = new BehaviorSubject<Message | undefined>(undefined);
    this.get(id).then(msg => subject.next(msg));
    this.changeSubject.subscribe(() => {
      this.get(id).then(msg => subject.next(msg));
    });
    return subject;
  }

  observeAll(): Observable<Message[]> {
    const subject = new BehaviorSubject<Message[]>([]);
    this.getAll().then(msgs => subject.next(msgs));
    this.changeSubject.subscribe(() => {
      this.getAll().then(msgs => subject.next(msgs));
    });
    return subject;
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
    let sql = `SELECT * FROM messages WHERE ownerUserId = ? AND contactUserId = ?`;
    const params: unknown[] = [ownerUserId, contactUserId];

    if (options?.excludeTypes?.length) {
      const placeholders = options.excludeTypes.map(() => '?').join(', ');
      sql += ` AND type NOT IN (${placeholders})`;
      params.push(...options.excludeTypes);
    }

    sql += ` ORDER BY timestamp DESC`;

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }
    if (options?.offset) {
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }

    const rows = await this.runtime.executeSql<MessageRow>(sql, params);
    return rows.map(rowToMessage);
  }

  async getByOwner(
    ownerUserId: string,
    options?: { excludeTypes?: MessageType[] }
  ): Promise<Message[]> {
    let sql = `SELECT * FROM messages WHERE ownerUserId = ?`;
    const params: unknown[] = [ownerUserId];

    if (options?.excludeTypes?.length) {
      const placeholders = options.excludeTypes.map(() => '?').join(', ');
      sql += ` AND type NOT IN (${placeholders})`;
      params.push(...options.excludeTypes);
    }

    sql += ` ORDER BY timestamp`;

    const rows = await this.runtime.executeSql<MessageRow>(sql, params);
    return rows.map(rowToMessage);
  }

  async getByStatus(
    ownerUserId: string,
    status: MessageStatus
  ): Promise<Message[]> {
    const rows = await this.runtime.executeSql<MessageRow>(
      `SELECT * FROM messages WHERE ownerUserId = ? AND status = ? ORDER BY timestamp`,
      [ownerUserId, status]
    );
    return rows.map(rowToMessage);
  }

  async getBySeeker(
    ownerUserId: string,
    seeker: Uint8Array
  ): Promise<Message | undefined> {
    const rows = await this.runtime.executeSql<MessageRow>(
      `SELECT * FROM messages WHERE ownerUserId = ? AND seeker = ?`,
      [ownerUserId, blobToSql(seeker)]
    );
    return rows.length > 0 ? rowToMessage(rows[0]) : undefined;
  }

  observeByContact(
    ownerUserId: string,
    contactUserId: string
  ): Observable<Message[]> {
    const subject = new BehaviorSubject<Message[]>([]);
    this.getByContact(ownerUserId, contactUserId).then(msgs =>
      subject.next(msgs)
    );
    this.changeSubject.subscribe(() => {
      this.getByContact(ownerUserId, contactUserId).then(msgs =>
        subject.next(msgs)
      );
    });
    return subject;
  }

  observeByOwner(
    ownerUserId: string,
    options?: { excludeTypes?: MessageType[] }
  ): Observable<Message[]> {
    const subject = new BehaviorSubject<Message[]>([]);
    this.getByOwner(ownerUserId, options).then(msgs => subject.next(msgs));
    this.changeSubject.subscribe(() => {
      this.getByOwner(ownerUserId, options).then(msgs => subject.next(msgs));
    });
    return subject;
  }

  async updateStatus(id: number, status: MessageStatus): Promise<void> {
    await this.runtime.runSql(`UPDATE messages SET status = ? WHERE id = ?`, [
      status,
      id,
    ]);
    this.notifyChange();
  }

  async updateSeeker(id: number, seeker: Uint8Array): Promise<void> {
    await this.runtime.runSql(`UPDATE messages SET seeker = ? WHERE id = ?`, [
      blobToSql(seeker),
      id,
    ]);
    this.notifyChange();
  }

  async markAsRead(
    ownerUserId: string,
    contactUserId: string
  ): Promise<number> {
    const result = await this.runtime.runSql(
      `UPDATE messages SET status = 'read'
       WHERE ownerUserId = ? AND contactUserId = ? AND status = 'delivered' AND direction = 'incoming'`,
      [ownerUserId, contactUserId]
    );
    if (result.changes > 0) {
      this.notifyChange();
    }
    return result.changes;
  }

  async getWaitingForSession(ownerUserId: string): Promise<Message[]> {
    const rows = await this.runtime.executeSql<MessageRow>(
      `SELECT * FROM messages WHERE ownerUserId = ? AND status = 'waiting_session' ORDER BY timestamp`,
      [ownerUserId]
    );
    return rows.map(rowToMessage);
  }

  async getFailed(ownerUserId: string): Promise<Message[]> {
    const rows = await this.runtime.executeSql<MessageRow>(
      `SELECT * FROM messages WHERE ownerUserId = ? AND status = 'failed' ORDER BY timestamp`,
      [ownerUserId]
    );
    return rows.map(rowToMessage);
  }

  async addWithDiscussionUpdate(
    message: Omit<Message, 'id'>
  ): Promise<Message> {
    // Create the message
    const created = await this.create(message);

    // Update the discussion (if it exists)
    await this.runtime.runSql(
      `UPDATE discussions SET
         lastMessageId = ?,
         lastMessageContent = ?,
         lastMessageTimestamp = ?,
         unreadCount = CASE WHEN ? = 'incoming' THEN unreadCount + 1 ELSE unreadCount END,
         updatedAt = ?
       WHERE ownerUserId = ? AND contactUserId = ?`,
      [
        created.id,
        message.content,
        dateToSql(message.timestamp),
        message.direction,
        dateToSql(new Date()),
        message.ownerUserId,
        message.contactUserId,
      ]
    );

    return created;
  }

  // ============ Internal ============

  private notifyChange(): void {
    this.changeSubject.next(this.changeSubject.getValue() + 1);
  }
}
