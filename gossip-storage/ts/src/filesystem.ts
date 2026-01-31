/**
 * FileSystem interface for gossip-storage
 *
 * Defines a pluggable storage backend interface that can be implemented
 * for different environments (OPFS, Node.js, memory, etc.)
 */

/** File identifiers */
export const FILE_ADDRESSING = 0;
export const FILE_DATA = 1;

export type FileId = typeof FILE_ADDRESSING | typeof FILE_DATA;

/**
 * Abstract filesystem interface for storage backends.
 *
 * Implementations provide the underlying file I/O for the storage layer.
 * The Storage class wires these methods to WASM callbacks.
 */
export interface FileSystem {
  /** Read bytes from a file at the given offset */
  read(fileId: FileId, offset: number, len: number): Uint8Array;

  /** Write bytes to a file at the given offset */
  write(fileId: FileId, offset: number, data: Uint8Array): void;

  /** Get the current size of a file */
  getSize(fileId: FileId): number;

  /** Flush pending writes to disk */
  flush(fileId: FileId): void;

  /** Optional: cleanup resources */
  close?(): void | Promise<void>;
}
