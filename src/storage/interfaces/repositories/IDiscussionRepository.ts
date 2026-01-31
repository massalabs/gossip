/**
 * Discussion repository interface
 */

import type { Observable } from '../../base/Observable';
import type { Discussion, DiscussionStatus } from '../../models';
import type { IRepository } from './IRepository';

export interface IDiscussionRepository extends IRepository<Discussion> {
  /**
   * Get all discussions for an owner
   */
  getByOwner(ownerUserId: string): Promise<Discussion[]>;

  /**
   * Get discussion by owner and contact
   */
  getByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string
  ): Promise<Discussion | undefined>;

  /**
   * Get discussions by status
   */
  getByStatus(
    ownerUserId: string,
    status: DiscussionStatus
  ): Promise<Discussion[]>;

  /**
   * Get active discussions (with protocol state)
   */
  getActive(ownerUserId: string): Promise<Discussion[]>;

  /**
   * Observe all discussions for an owner
   */
  observeByOwner(ownerUserId: string): Observable<Discussion[]>;

  /**
   * Observe a specific discussion
   */
  observeByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string
  ): Observable<Discussion | undefined>;

  /**
   * Get total unread count for an owner
   */
  getUnreadCount(ownerUserId: string): Promise<number>;

  /**
   * Observe total unread count
   */
  observeUnreadCount(ownerUserId: string): Observable<number>;

  /**
   * Update discussion status
   */
  updateStatus(id: number, status: DiscussionStatus): Promise<void>;

  /**
   * Update next seeker for sending
   */
  updateNextSeeker(id: number, nextSeeker: Uint8Array): Promise<void>;

  /**
   * Update last sync timestamp
   */
  updateLastSyncTimestamp(id: number, timestamp: Date): Promise<void>;

  /**
   * Reset unread count
   */
  resetUnreadCount(id: number): Promise<void>;

  /**
   * Increment unread count
   */
  incrementUnreadCount(id: number): Promise<void>;

  /**
   * Update last message info
   */
  updateLastMessage(
    id: number,
    messageId: number,
    content: string,
    timestamp: Date
  ): Promise<void>;

  /**
   * Create or update discussion (upsert)
   */
  upsert(
    ownerUserId: string,
    contactUserId: string,
    data: Partial<Omit<Discussion, 'id' | 'ownerUserId' | 'contactUserId'>>
  ): Promise<Discussion>;
}
