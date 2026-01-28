/**
 * Base repository interface for CRUD operations.
 * All domain-specific repositories extend this.
 */

import type { Observable } from '../../base/Observable';

/**
 * Base repository with standard CRUD operations
 * @template T - Entity type
 * @template K - Primary key type (default: number)
 */
export interface IRepository<T, K = number> {
  /**
   * Get a single entity by ID
   */
  get(id: K): Promise<T | undefined>;

  /**
   * Get all entities
   */
  getAll(): Promise<T[]>;

  /**
   * Create a new entity
   * @returns The created entity with generated ID
   */
  create(entity: Omit<T, 'id'>): Promise<T>;

  /**
   * Update an existing entity
   * @returns The updated entity, or undefined if not found
   */
  update(id: K, changes: Partial<T>): Promise<T | undefined>;

  /**
   * Delete an entity
   * @returns true if deleted, false if not found
   */
  delete(id: K): Promise<boolean>;

  /**
   * Observe a single entity for changes
   */
  observe(id: K): Observable<T | undefined>;

  /**
   * Observe all entities for changes
   */
  observeAll(): Observable<T[]>;
}

/**
 * Repository that supports bulk operations
 */
export interface IBulkRepository<T, K = number> extends IRepository<T, K> {
  /**
   * Create multiple entities in a single transaction
   */
  createMany(entities: Omit<T, 'id'>[]): Promise<T[]>;

  /**
   * Delete multiple entities by IDs
   * @returns Number of entities deleted
   */
  deleteMany(ids: K[]): Promise<number>;

  /**
   * Delete all entities
   */
  clear(): Promise<void>;
}
