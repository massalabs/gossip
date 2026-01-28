/**
 * PlausibleDeniableVFS - Custom SQLite VFS
 *
 * Routes SQLite I/O operations through Rust WASM storage layer.
 * All data is encrypted and stored at session-specific offsets.
 */

import * as VFS from 'wa-sqlite/src/VFS.js';

/**
 * WASM storage API interface
 */
export interface StorageApi {
  isSessionUnlocked(): boolean;
  getRootAddress(): bigint;
  readData(offset: bigint, len: number): Uint8Array;
  writeData(offset: bigint, data: Uint8Array): boolean;
  flushData(): boolean;
}

interface VirtualFile {
  name: string;
  flags: number;
  size: number;
  /** If true, this is a journal/temp file - ignore I/O operations */
  isJournal: boolean;
}

/**
 * Custom VFS that routes SQLite operations through encrypted WASM storage
 */
export class PlausibleDeniableVFS extends VFS.Base {
  name = 'PlausibleDeniableVFS';
  private storage: StorageApi;
  private mapIdToFile = new Map<number, VirtualFile>();
  private mapNameToFile = new Map<string, VirtualFile>();
  private stats = { readCount: 0, writeCount: 0, flushCount: 0 };
  /** True if there are unflushed writes to main database */
  private dirty = false;

  constructor(storage: StorageApi) {
    super();
    this.storage = storage;
  }

  /**
   * Reset VFS state (useful for testing)
   */
  reset(): void {
    this.mapIdToFile.clear();
    this.mapNameToFile.clear();
    this.stats = { readCount: 0, writeCount: 0, flushCount: 0 };
    this.dirty = false;
  }

  /**
   * Get I/O statistics
   */
  getStats(): { readCount: number; writeCount: number; flushCount: number } {
    return { ...this.stats };
  }

  /**
   * Restore file size from SQLite header after session unlock.
   * SQLite stores page size at offset 16 and page count at offset 28.
   *
   * @returns true if header was valid and size restored, false otherwise
   */
  restoreFileSizeFromHeader(fileName: string): boolean {
    // Rust handles root_address offset, read at offset 0
    const header = this.storage.readData(BigInt(0), 100);

    // Need at least 32 bytes to read page count (offset 28-31)
    if (header.length < 32) {
      console.warn('[VFS] Header too short');
      return false;
    }

    // Check SQLite magic: "SQLite format 3\0"
    const magic = String.fromCharCode(...header.slice(0, 16));
    if (!magic.startsWith('SQLite format 3')) {
      console.warn(
        '[VFS] No valid SQLite header found - this may be a new session or corrupted data'
      );
      return false;
    }

    // Page size: bytes 16-17 (big-endian)
    const pageSize = (header[16]! << 8) | header[17]!;
    // Page count: bytes 28-31 (big-endian)
    const pageCount =
      (header[28]! << 24) |
      (header[29]! << 16) |
      (header[30]! << 8) |
      header[31]!;

    const fileSize = pageSize * pageCount;

    // Sanity check: page size must be power of 2, between 512 and 65536
    if (
      pageSize < 512 ||
      pageSize > 65536 ||
      (pageSize & (pageSize - 1)) !== 0
    ) {
      console.warn(`[VFS] Invalid page size: ${pageSize}`);
      return false;
    }

    console.log(
      `[VFS] Restored file size: ${fileSize} bytes (${pageSize} x ${pageCount} pages)`
    );

    let file = this.mapNameToFile.get(fileName);
    if (file) {
      file.size = fileSize;
    } else {
      file = { name: fileName, flags: 0, size: fileSize, isJournal: false };
      this.mapNameToFile.set(fileName, file);
    }

    return true;
  }

  xOpen(
    name: string | null,
    fileId: number,
    flags: number,
    pOutFlags: DataView
  ): number {
    const fileName = name || `temp-${fileId}`;
    let file = this.mapNameToFile.get(fileName);

    // Check if this is a journal or temp file (we ignore I/O for these)
    const isJournal =
      fileName.includes('-journal') ||
      fileName.includes('-wal') ||
      fileName.includes('-shm') ||
      fileName.startsWith('temp-');

    // Only log non-journal files (less noise in console)
    if (!isJournal) {
      console.log(
        `[VFS] xOpen: name="${fileName}", flags=${flags}, existing=${!!file}`
      );
    }

    if (!file) {
      if (flags & VFS.SQLITE_OPEN_CREATE) {
        file = { name: fileName, flags, size: 0, isJournal };
        this.mapNameToFile.set(fileName, file);
      } else {
        return VFS.SQLITE_CANTOPEN;
      }
    }

    this.mapIdToFile.set(fileId, file);
    pOutFlags.setInt32(0, flags, true);
    return VFS.SQLITE_OK;
  }

  xClose(fileId: number): number {
    const file = this.mapIdToFile.get(fileId);
    this.mapIdToFile.delete(fileId);

    if (file && file.flags & VFS.SQLITE_OPEN_DELETEONCLOSE) {
      this.mapNameToFile.delete(file.name);
    }

    return VFS.SQLITE_OK;
  }

  xRead(
    fileId: number,
    pData: { value?: Uint8Array; size?: number } | Uint8Array,
    iOffset: number
  ): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file || !this.storage.isSessionUnlocked()) {
      return VFS.SQLITE_IOERR;
    }

    this.stats.readCount++;

    const buffer: Uint8Array =
      pData instanceof Uint8Array ? pData : pData.value!;
    const size =
      pData instanceof Uint8Array
        ? pData.byteLength
        : (pData.size ?? buffer.byteLength);

    // For journal/temp files, return zeros (don't read from storage)
    if (file.isJournal) {
      buffer.fill(0);
      return VFS.SQLITE_IOERR_SHORT_READ;
    }

    // Rust handles root_address offset, VFS uses raw offset
    const data = this.storage.readData(BigInt(iOffset), size);
    buffer.set(data);

    return iOffset + size > file.size
      ? VFS.SQLITE_IOERR_SHORT_READ
      : VFS.SQLITE_OK;
  }

  xWrite(
    fileId: number,
    pData: { value?: Uint8Array; size?: number } | Uint8Array,
    iOffset: number
  ): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file || !this.storage.isSessionUnlocked()) {
      return VFS.SQLITE_IOERR;
    }

    this.stats.writeCount++;

    const buffer: Uint8Array =
      pData instanceof Uint8Array ? pData : pData.value!;
    const size =
      pData instanceof Uint8Array
        ? pData.byteLength
        : (pData.size ?? buffer.byteLength);

    // For journal/temp files, pretend write succeeded but don't actually write
    // SQLite journals are for crash recovery; we handle atomicity via encryption
    if (file.isJournal) {
      if (iOffset + size > file.size) {
        file.size = iOffset + size;
      }
      return VFS.SQLITE_OK;
    }

    // Rust handles root_address offset, VFS uses raw offset
    const success = this.storage.writeData(
      BigInt(iOffset),
      buffer.subarray(0, size)
    );

    if (!success) {
      return VFS.SQLITE_IOERR;
    }

    if (iOffset + size > file.size) {
      file.size = iOffset + size;
    }

    // Mark as dirty so xSync will flush
    this.dirty = true;

    return VFS.SQLITE_OK;
  }

  xTruncate(_fileId: number, _iSize: number): number {
    return VFS.SQLITE_OK;
  }

  xSync(_fileId: number, _flags: number): number {
    // Flush to storage when SQLite requests sync.
    // This ensures data durability - if the app is killed, data is persisted.
    // journal_mode=MEMORY means we can't rely on SQLite's crash recovery.
    if (this.dirty) {
      this.storage.flushData();
      this.stats.flushCount++;
      this.dirty = false;
    }
    return VFS.SQLITE_OK;
  }

  xFileSize(fileId: number, pSize64: DataView): number {
    const file = this.mapIdToFile.get(fileId);
    pSize64.setBigInt64(0, BigInt(file?.size ?? 0), true);
    return VFS.SQLITE_OK;
  }

  xLock(_fileId: number, _flags: number): number {
    return VFS.SQLITE_OK;
  }

  xUnlock(_fileId: number, _flags: number): number {
    return VFS.SQLITE_OK;
  }

  xCheckReservedLock(_fileId: number, pResOut: DataView): number {
    pResOut.setInt32(0, 0, true);
    return VFS.SQLITE_OK;
  }

  xDelete(name: string, _syncDir: number): number {
    this.mapNameToFile.delete(name);
    return VFS.SQLITE_OK;
  }

  xAccess(name: string, _flags: number, pResOut: DataView): number {
    pResOut.setInt32(0, this.mapNameToFile.has(name) ? 1 : 0, true);
    return VFS.SQLITE_OK;
  }
}
