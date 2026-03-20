/**
 * Secure Storage VFS for wa-sqlite.
 *
 * Routes SQLite I/O through the secure storage WASM module, which
 * encrypts/decrypts data blocks and delegates raw storage to OPFS
 * or node:fs via JS callbacks.
 *
 * Journal/WAL/temp files are handled in-memory. The main database
 * file goes through secure storage (requires an unlocked session).
 *
 * ## Write coalescing
 *
 * Each `wasm.writeData()` call triggers a full decrypt-modify-reencrypt
 * cycle on every secure storage block touched (× 5 sessions for pq-rerand
 * rerandomization). Without coalescing, two SQLite page writes to the
 * same block trigger two independent encrypt cycles.
 *
 * The VFS buffers writes in memory and flushes them as merged byte
 * ranges — so multiple page writes to the same block produce a single
 * `writeData()` call covering the full extent. The Rust layer then
 * processes each block exactly once.
 *
 * Flush triggers: `xSync`, `xClose`, and the public `flushDirtyPages()`
 * method (called by the worker after each SQL execution).
 *
 * ## Crash safety
 *
 * Coalescing is *strictly safer* than direct pass-through:
 *
 * - **Before (no coalescing):** each xWrite immediately encrypts to the
 *   storage backend. A crash mid-transaction leaves a mix of old and new
 *   blocks with no rollback journal (journal_mode=MEMORY) → corrupted DB.
 *
 * - **After (coalescing):** writes stay in JS memory until flush. A crash
 *   mid-transaction preserves the old consistent state → transaction lost
 *   but DB not corrupted. The flush window (when writes hit storage) has
 *   the same risk as before, but is shorter (one burst vs scattered).
 */

import * as VFS from 'wa-sqlite/src/VFS.js';

/**
 * SQLite page size for secure storage databases.
 *
 * PLAINTEXT_SIZE is 15840 bytes — the largest power-of-2 page that fits
 * within a single block without straddling is 8192 (≈1.93 pages/block).
 * This halves the number of xWrite→encrypt cycles vs the default 4096.
 */
export const SECURE_STORAGE_PAGE_SIZE = 8192;

interface SecureStorageWasm {
  readData(offset: number, len: number): Uint8Array;
  writeData(offset: number, data: Uint8Array): void;
  getDataSize(): number;
  isUnlocked(): boolean;
}

const log = (...args: unknown[]) => console.log('[SecureStorageVFS]', ...args);

export class SecureStorageVFS extends VFS.Base {
  name = 'secureStorage';

  private wasm: SecureStorageWasm;
  private mainFileId: number | null = null;

  // In-memory journal/temp files (fileId → { data, size })
  private memFiles: Map<number, { data: Uint8Array; size: number }> = new Map();

  // Write coalescing: buffered page writes (byte offset → page data).
  // Flushed to WASM as merged contiguous ranges.
  private dirtyPages: Map<number, Uint8Array> = new Map();

  // Max file extent including buffered writes. Reset to 0 on flush
  // (WASM getDataSize() becomes authoritative again).
  private bufferedFileEnd = 0;

  constructor(wasm: SecureStorageWasm) {
    super();
    this.mxPathName = 255;
    this.wasm = wasm;
  }

  xOpen(
    name: string | null,
    fileId: number,
    flags: number,
    pOutFlags: DataView
  ): number {
    if (flags & VFS.SQLITE_OPEN_MAIN_DB) {
      this.mainFileId = fileId;
      pOutFlags.setInt32(0, flags, true);
      log(`xOpen main DB (fileId=${fileId}, name=${name})`);
      return VFS.SQLITE_OK;
    }
    // Journal, WAL, temp files — handle in memory
    this.memFiles.set(fileId, { data: new Uint8Array(4096), size: 0 });
    pOutFlags.setInt32(0, flags, true);
    log(`xOpen mem file (fileId=${fileId}, name=${name})`);
    return VFS.SQLITE_OK;
  }

  xClose(fileId: number): number {
    if (fileId === this.mainFileId) {
      this.flushDirtyPages();
      log('xClose main DB');
      this.mainFileId = null;
    }
    this.memFiles.delete(fileId);
    return VFS.SQLITE_OK;
  }

  xRead(
    fileId: number,
    pData_: { size: number; value: Uint8Array },
    iOffset: number
  ): number {
    const pData = pData_ as unknown as Uint8Array;

    // Handle in-memory journal/temp files
    const memFile = this.memFiles.get(fileId);
    if (memFile) {
      if (iOffset >= memFile.size) {
        pData.fill(0);
        return VFS.SQLITE_IOERR_SHORT_READ;
      }
      const available = Math.min(pData.byteLength, memFile.size - iOffset);
      pData.set(memFile.data.subarray(iOffset, iOffset + available));
      if (available < pData.byteLength) {
        pData.fill(0, available);
        return VFS.SQLITE_IOERR_SHORT_READ;
      }
      return VFS.SQLITE_OK;
    }

    if (fileId !== this.mainFileId) return VFS.SQLITE_IOERR;

    try {
      const readLen = pData.byteLength;
      const readEnd = iOffset + readLen;

      // Fast path: exact dirty page hit (most common case — full page reads)
      const dirty = this.dirtyPages.get(iOffset);
      if (dirty && dirty.byteLength === readLen) {
        pData.set(dirty);
        return VFS.SQLITE_OK;
      }

      // Effective file size includes buffered growth
      const wasmSize = this.wasm.getDataSize();
      const effectiveSize =
        this.bufferedFileEnd > 0
          ? Math.max(wasmSize, this.bufferedFileEnd)
          : wasmSize;

      if (iOffset >= effectiveSize) {
        pData.fill(0);
        log(
          `xRead SHORT offset=${iOffset} len=${readLen} dbSize=${effectiveSize}`
        );
        return VFS.SQLITE_IOERR_SHORT_READ;
      }

      // Read from WASM (what's available in persistent storage)
      if (iOffset < wasmSize) {
        const available = Math.min(readLen, wasmSize - iOffset);
        const data = this.wasm.readData(iOffset, available);
        pData.set(data);
        if (available < readLen) pData.fill(0, available);
      } else {
        // Beyond WASM extent but within buffered extent — zero-fill base
        pData.fill(0);
      }

      // Overlay any dirty pages that intersect the read range
      if (this.dirtyPages.size > 0) {
        for (const [pageOff, pageData] of this.dirtyPages) {
          const pageEnd = pageOff + pageData.byteLength;
          const overlapStart = Math.max(iOffset, pageOff);
          const overlapEnd = Math.min(readEnd, pageEnd);
          if (overlapStart < overlapEnd) {
            pData.set(
              pageData.subarray(overlapStart - pageOff, overlapEnd - pageOff),
              overlapStart - iOffset
            );
          }
        }
      }

      if (readEnd > effectiveSize) {
        log(
          `xRead PARTIAL offset=${iOffset} got=${effectiveSize - iOffset} wanted=${readLen}`
        );
        return VFS.SQLITE_IOERR_SHORT_READ;
      }
      return VFS.SQLITE_OK;
    } catch (e) {
      log(`xRead ERROR offset=${iOffset}:`, e);
      return VFS.SQLITE_IOERR;
    }
  }

  xWrite(
    fileId: number,
    pData_: { size: number; value: Uint8Array },
    iOffset: number
  ): number {
    const pData = pData_ as unknown as Uint8Array;

    // Handle in-memory journal/temp files
    const memFile = this.memFiles.get(fileId);
    if (memFile) {
      const needed = iOffset + pData.byteLength;
      if (needed > memFile.data.byteLength) {
        const newBuf = new Uint8Array(
          Math.max(needed, memFile.data.byteLength * 2)
        );
        newBuf.set(memFile.data);
        memFile.data = newBuf;
      }
      memFile.data.set(pData, iOffset);
      if (needed > memFile.size) memFile.size = needed;
      return VFS.SQLITE_OK;
    }

    if (fileId !== this.mainFileId) return VFS.SQLITE_IOERR;

    // Buffer the write — flushed later as merged contiguous ranges
    this.dirtyPages.set(iOffset, new Uint8Array(pData));
    const newEnd = iOffset + pData.byteLength;
    if (newEnd > this.bufferedFileEnd) this.bufferedFileEnd = newEnd;
    return VFS.SQLITE_OK;
  }

  xTruncate(fileId: number, iSize: number): number {
    const memFile = this.memFiles.get(fileId);
    if (memFile) {
      memFile.size = Math.min(memFile.size, iSize);
      return VFS.SQLITE_OK;
    }
    // Discard dirty pages beyond the new size
    for (const offset of this.dirtyPages.keys()) {
      if (offset >= iSize) this.dirtyPages.delete(offset);
    }
    if (this.bufferedFileEnd > iSize) this.bufferedFileEnd = iSize;
    log(`xTruncate size=${iSize}`);
    return VFS.SQLITE_OK;
  }

  xSync(_fileId: number, _flags: number): number {
    this.flushDirtyPages();
    return VFS.SQLITE_OK;
  }

  xFileSize(fileId: number, pSize64: DataView): number {
    const memFile = this.memFiles.get(fileId);
    if (memFile) {
      pSize64.setBigInt64(0, BigInt(memFile.size), true);
      return VFS.SQLITE_OK;
    }
    if (fileId !== this.mainFileId) return VFS.SQLITE_IOERR;

    try {
      const wasmSize = this.wasm.getDataSize();
      const size =
        this.bufferedFileEnd > 0
          ? Math.max(wasmSize, this.bufferedFileEnd)
          : wasmSize;
      pSize64.setBigInt64(0, BigInt(size), true);
      return VFS.SQLITE_OK;
    } catch (e) {
      log(`xFileSize ERROR:`, e);
      pSize64.setBigInt64(0, 0n, true);
      return VFS.SQLITE_OK;
    }
  }

  xDelete(_name: string, _syncDir: number): number {
    return VFS.SQLITE_OK;
  }

  /**
   * Sector size = page size.  Tells SQLite that the minimum atomic write
   * granularity is one full page, preventing sub-page writes that would
   * each trigger a separate decrypt-modify-reencrypt cycle.
   */
  xSectorSize(_fileId: number): number {
    return SECURE_STORAGE_PAGE_SIZE;
  }

  /**
   * Device capability hints for SQLite's write optimizer.
   *
   * - SAFE_APPEND:  appends never corrupt prior data (secure storage extends
   *                 the blockstream atomically via appendBlock).
   * - SEQUENTIAL:   writes are executed in order (single-threaded WASM).
   */
  xDeviceCharacteristics(_fileId: number): number {
    return VFS.SQLITE_IOCAP_SAFE_APPEND | VFS.SQLITE_IOCAP_SEQUENTIAL;
  }

  xAccess(name: string, _flags: number, pResOut: DataView): number {
    // Only the main DB "exists" — journal/WAL/temp files never exist on disk
    const exists =
      this.mainFileId !== null &&
      !name.includes('-journal') &&
      !name.includes('-wal') &&
      !name.includes('-shm');
    pResOut.setInt32(0, exists ? 1 : 0, true);
    return VFS.SQLITE_OK;
  }

  // ─── Write coalescing ──────────────────────────────────────────

  /**
   * Flush all buffered writes to WASM as merged contiguous byte ranges.
   *
   * Called by the worker after each SQL execution, and internally on
   * xSync / xClose. Contiguous dirty pages are merged into a single
   * `writeData()` call so the Rust layer processes each secure storage
   * block exactly once.
   */
  flushDirtyPages(): void {
    if (this.dirtyPages.size === 0) return;

    const entries = [...this.dirtyPages.entries()].sort((a, b) => a[0] - b[0]);

    let rangeStart = entries[0][0];
    let rangeChunks: { offset: number; data: Uint8Array }[] = [
      { offset: entries[0][0], data: entries[0][1] },
    ];
    let rangeEnd = rangeStart + entries[0][1].byteLength;

    for (let i = 1; i < entries.length; i++) {
      const [offset, data] = entries[i];
      if (offset <= rangeEnd) {
        // Contiguous or overlapping — extend range
        rangeChunks.push({ offset, data });
        const end = offset + data.byteLength;
        if (end > rangeEnd) rangeEnd = end;
      } else {
        // Gap — flush previous range
        this.writeRange(rangeStart, rangeChunks, rangeEnd - rangeStart);
        rangeStart = offset;
        rangeChunks = [{ offset, data }];
        rangeEnd = offset + data.byteLength;
      }
    }
    this.writeRange(rangeStart, rangeChunks, rangeEnd - rangeStart);

    this.dirtyPages.clear();
    this.bufferedFileEnd = 0;
  }

  private writeRange(
    rangeStart: number,
    chunks: { offset: number; data: Uint8Array }[],
    totalLen: number
  ): void {
    if (chunks.length === 1) {
      this.wasm.writeData(rangeStart, chunks[0].data);
    } else {
      // Use absolute offsets relative to rangeStart so overlapping or
      // non-page-aligned chunks land at the correct byte position.
      const merged = new Uint8Array(totalLen);
      for (const { offset, data } of chunks) {
        merged.set(data, offset - rangeStart);
      }
      this.wasm.writeData(rangeStart, merged);
    }
  }
}
