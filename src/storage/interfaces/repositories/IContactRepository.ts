/**
 * Contact repository interface
 */

import type { Observable } from '../../base/Observable';
import type { Contact } from '../../models';
import type { IRepository } from './IRepository';

export interface IContactRepository extends IRepository<Contact> {
  /**
   * Get all contacts for a specific owner
   */
  getByOwner(ownerUserId: string): Promise<Contact[]>;

  /**
   * Get a contact by owner and contact user ID
   */
  getByOwnerAndUserId(
    ownerUserId: string,
    userId: string
  ): Promise<Contact | undefined>;

  /**
   * Observe all contacts for a specific owner
   */
  observeByOwner(ownerUserId: string): Observable<Contact[]>;

  /**
   * Update contact online status
   */
  updateOnlineStatus(
    ownerUserId: string,
    userId: string,
    isOnline: boolean
  ): Promise<void>;

  /**
   * Search contacts by name
   */
  searchByName(ownerUserId: string, query: string): Promise<Contact[]>;
}
