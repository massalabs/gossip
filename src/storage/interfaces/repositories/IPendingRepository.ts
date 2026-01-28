/**
 * Pending items repository interfaces for protocol queue management
 */

import type { Observable } from '../../base/Observable';
import type {
  ActiveSeeker,
  PendingAnnouncement,
  PendingEncryptedMessage,
} from '../../models';
import type { IBulkRepository } from './IRepository';

/**
 * Pending encrypted messages - messages fetched from network awaiting processing
 */
export interface IPendingMessageRepository extends IBulkRepository<PendingEncryptedMessage> {
  /**
   * Get all pending messages ordered by fetch time
   */
  getAllOrdered(): Promise<PendingEncryptedMessage[]>;

  /**
   * Get pending message by seeker
   */
  getBySeeker(seeker: Uint8Array): Promise<PendingEncryptedMessage | undefined>;

  /**
   * Check if a seeker already exists
   */
  hasSeeker(seeker: Uint8Array): Promise<boolean>;

  /**
   * Delete by seeker
   */
  deleteBySeeker(seeker: Uint8Array): Promise<boolean>;

  /**
   * Observe pending message count
   */
  observeCount(): Observable<number>;
}

/**
 * Pending announcements - announcements fetched from network awaiting processing
 */
export interface IPendingAnnouncementRepository extends IBulkRepository<PendingAnnouncement> {
  /**
   * Get all pending announcements ordered by fetch time
   */
  getAllOrdered(): Promise<PendingAnnouncement[]>;

  /**
   * Check if an announcement already exists
   */
  hasAnnouncement(announcement: Uint8Array): Promise<boolean>;

  /**
   * Delete by announcement bytes
   */
  deleteByAnnouncement(announcement: Uint8Array): Promise<boolean>;

  /**
   * Get the latest counter value
   */
  getLatestCounter(): Promise<string | undefined>;

  /**
   * Observe pending announcement count
   */
  observeCount(): Observable<number>;
}

/**
 * Active seekers - seekers currently being monitored for messages
 */
export interface IActiveSeekerRepository extends IBulkRepository<ActiveSeeker> {
  /**
   * Set all active seekers (replaces existing)
   */
  setAll(seekers: Uint8Array[]): Promise<void>;

  /**
   * Get all seeker bytes
   */
  getAllSeekers(): Promise<Uint8Array[]>;

  /**
   * Add a single seeker
   */
  addSeeker(seeker: Uint8Array): Promise<void>;

  /**
   * Remove a single seeker
   */
  removeSeeker(seeker: Uint8Array): Promise<boolean>;

  /**
   * Check if a seeker is active
   */
  hasSeeker(seeker: Uint8Array): Promise<boolean>;

  /**
   * Observe active seeker count
   */
  observeCount(): Observable<number>;
}
