/**
 * User profile repository interface
 */

import type { Observable } from '../../base/Observable';
import type { UserProfile } from '../../models';

/**
 * User profile repository - uses userId as primary key (string)
 */
export interface IUserProfileRepository {
  /**
   * Get a user profile by ID
   */
  get(userId: string): Promise<UserProfile | undefined>;

  /**
   * Get all user profiles
   */
  getAll(): Promise<UserProfile[]>;

  /**
   * Get the first/default user profile
   */
  getFirst(): Promise<UserProfile | undefined>;

  /**
   * Create a new user profile
   */
  create(profile: UserProfile): Promise<UserProfile>;

  /**
   * Update an existing profile
   */
  update(
    userId: string,
    changes: Partial<Omit<UserProfile, 'userId'>>
  ): Promise<UserProfile | undefined>;

  /**
   * Delete a user profile
   */
  delete(userId: string): Promise<boolean>;

  /**
   * Observe a specific user profile
   */
  observe(userId: string): Observable<UserProfile | undefined>;

  /**
   * Observe all user profiles
   */
  observeAll(): Observable<UserProfile[]>;

  /**
   * Update session data
   */
  updateSession(userId: string, session: Uint8Array): Promise<void>;

  /**
   * Update security settings
   */
  updateSecurity(
    userId: string,
    security: Partial<UserProfile['security']>
  ): Promise<void>;

  /**
   * Check if a username is taken
   */
  isUsernameTaken(username: string, excludeUserId?: string): Promise<boolean>;

  /**
   * Get profile by username
   */
  getByUsername(username: string): Promise<UserProfile | undefined>;
}
