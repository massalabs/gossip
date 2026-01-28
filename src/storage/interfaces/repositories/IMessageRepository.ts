/**
 * Message repository interface
 */

import type { Observable } from '../../base/Observable';
import type { Message, MessageStatus, MessageType } from '../../models';
import type { IRepository } from './IRepository';

export interface IMessageRepository extends IRepository<Message> {
  /**
   * Get messages for a specific contact conversation
   */
  getByContact(
    ownerUserId: string,
    contactUserId: string,
    options?: {
      limit?: number;
      offset?: number;
      excludeTypes?: MessageType[];
    }
  ): Promise<Message[]>;

  /**
   * Get all messages for an owner
   */
  getByOwner(
    ownerUserId: string,
    options?: {
      excludeTypes?: MessageType[];
    }
  ): Promise<Message[]>;

  /**
   * Get messages by status
   */
  getByStatus(ownerUserId: string, status: MessageStatus): Promise<Message[]>;

  /**
   * Get messages by seeker
   */
  getBySeeker(
    ownerUserId: string,
    seeker: Uint8Array
  ): Promise<Message | undefined>;

  /**
   * Observe messages for a specific contact
   */
  observeByContact(
    ownerUserId: string,
    contactUserId: string
  ): Observable<Message[]>;

  /**
   * Observe all messages for an owner (excluding certain types)
   */
  observeByOwner(
    ownerUserId: string,
    options?: { excludeTypes?: MessageType[] }
  ): Observable<Message[]>;

  /**
   * Update message status
   */
  updateStatus(id: number, status: MessageStatus): Promise<void>;

  /**
   * Update message seeker
   */
  updateSeeker(id: number, seeker: Uint8Array): Promise<void>;

  /**
   * Mark all incoming messages from a contact as read
   */
  markAsRead(ownerUserId: string, contactUserId: string): Promise<number>;

  /**
   * Get messages waiting for session
   */
  getWaitingForSession(ownerUserId: string): Promise<Message[]>;

  /**
   * Get failed messages for retry
   */
  getFailed(ownerUserId: string): Promise<Message[]>;

  /**
   * Add a message and update the associated discussion
   */
  addWithDiscussionUpdate(message: Omit<Message, 'id'>): Promise<Message>;
}
