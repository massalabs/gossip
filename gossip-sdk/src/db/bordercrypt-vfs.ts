/**
 * Bordercrypt VFS for wa-sqlite.
 *
 * Routes SQLite I/O through the bordercrypt WASM module, which
 * encrypts/decrypts data blocks and delegates raw storage to OPFS
 * or node:fs via JS callbacks.
 *
 * Journal/WAL/temp files are handled in-memory. The main database
 * file goes through bordercrypt (requires an unlocked session).
 */

import * as VFS from 'wa-sqlite/src/VFS.js';

interface BordecryptWasm {
  readData(offset: number, len: number): Uint8Array;
  writeData(offset: number, data: Uint8Array): void;
  getDataSize(): number;
  isUnlocked(): boolean;
}

const log = (...args: unknown[]) =>
  console.log('[BordecryptVFS]', ...args);

export class BordecryptVFS extends VFS.Base {
  name = 'bordercrypt';

  private wasm: BordecryptWasm;
  private mainFileId: number | null = null;

  // In-memory journal/temp files (fileId → { data, size })
  private memFiles: Map<number, { data: Uint8Array; size: number }> =
    new Map();

  constructor(wasm: BordecryptWasm) {
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
      const size = this.wasm.getDataSize();
      if (iOffset >= size) {
        pData.fill(0);
        log(`xRead SHORT offset=${iOffset} len=${pData.byteLength} dbSize=${size}`);
        return VFS.SQLITE_IOERR_SHORT_READ;
      }

      const available = Math.min(pData.byteLength, size - iOffset);
      const data = this.wasm.readData(iOffset, available);
      pData.set(data);
      if (available < pData.byteLength) {
        pData.fill(0, available);
        log(`xRead PARTIAL offset=${iOffset} got=${available} wanted=${pData.byteLength}`);
        return VFS.SQLITE_IOERR_SHORT_READ;
      }
      log(`xRead OK offset=${iOffset} len=${pData.byteLength}`);
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

    try {
      this.wasm.writeData(iOffset, pData);
      log(`xWrite OK offset=${iOffset} len=${pData.byteLength}`);
      return VFS.SQLITE_OK;
    } catch (e) {
      log(`xWrite ERROR offset=${iOffset}:`, e);
      return VFS.SQLITE_IOERR;
    }
  }

  xTruncate(fileId: number, iSize: number): number {
    const memFile = this.memFiles.get(fileId);
    if (memFile) {
      memFile.size = Math.min(memFile.size, iSize);
      return VFS.SQLITE_OK;
    }
    log(`xTruncate size=${iSize}`);
    return VFS.SQLITE_OK;
  }

  xSync(_fileId: number, _flags: number): number {
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
      const size = this.wasm.getDataSize();
      pSize64.setBigInt64(0, BigInt(size), true);
      log(`xFileSize OK size=${size}`);
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
}
