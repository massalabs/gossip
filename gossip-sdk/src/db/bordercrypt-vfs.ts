/**
 * Bordercrypt VFS for wa-sqlite.
 *
 * Routes SQLite I/O through the bordercrypt WASM module, which
 * encrypts/decrypts data blocks and delegates raw storage to OPFS
 * or node:fs via JS callbacks.
 *
 * Only the main database file is stored in bordercrypt. Journal and
 * temp files are rejected (use PRAGMA journal_mode=MEMORY).
 */

import * as VFS from 'wa-sqlite/src/VFS.js';

interface BordecryptWasm {
  readData(offset: number, len: number): Uint8Array;
  writeData(offset: number, data: Uint8Array): void;
  getDataSize(): number;
}

export class BordecryptVFS extends VFS.Base {
  name = 'bordercrypt';

  private wasm: BordecryptWasm;
  private mainFileId: number | null = null;

  constructor(wasm: BordecryptWasm) {
    super();
    this.mxPathName = 255;
    this.wasm = wasm;
  }

  xOpen(
    _name: string | null,
    fileId: number,
    flags: number,
    pOutFlags: DataView
  ): number {
    // Only handle the main database file.
    if (flags & VFS.SQLITE_OPEN_MAIN_DB) {
      this.mainFileId = fileId;
      pOutFlags.setInt32(0, flags, true);
      return VFS.SQLITE_OK;
    }
    // Reject journals, temp files, etc. SQLite falls back to in-memory.
    return VFS.SQLITE_CANTOPEN;
  }

  xClose(fileId: number): number {
    if (fileId === this.mainFileId) {
      this.mainFileId = null;
    }
    return VFS.SQLITE_OK;
  }

  xRead(
    fileId: number,
    pData_: { size: number; value: Uint8Array },
    iOffset: number
  ): number {
    const pData = pData_ as unknown as Uint8Array;
    if (fileId !== this.mainFileId) return VFS.SQLITE_IOERR;

    try {
      const size = this.wasm.getDataSize();
      if (iOffset >= size) {
        pData.fill(0);
        return VFS.SQLITE_IOERR_SHORT_READ;
      }

      const available = Math.min(pData.byteLength, size - iOffset);
      const data = this.wasm.readData(iOffset, available);
      pData.set(data);
      if (available < pData.byteLength) {
        pData.fill(0, available);
        return VFS.SQLITE_IOERR_SHORT_READ;
      }
      return VFS.SQLITE_OK;
    } catch {
      return VFS.SQLITE_IOERR;
    }
  }

  xWrite(
    fileId: number,
    pData_: { size: number; value: Uint8Array },
    iOffset: number
  ): number {
    const pData = pData_ as unknown as Uint8Array;
    if (fileId !== this.mainFileId) return VFS.SQLITE_IOERR;

    try {
      this.wasm.writeData(iOffset, pData);
      return VFS.SQLITE_OK;
    } catch {
      return VFS.SQLITE_IOERR;
    }
  }

  xTruncate(_fileId: number, _iSize: number): number {
    // No-op: bordercrypt doesn't shrink blockstreams (deniability).
    return VFS.SQLITE_OK;
  }

  xSync(_fileId: number, _flags: number): number {
    // Bordercrypt fsyncs per-block during writes. No additional sync needed.
    return VFS.SQLITE_OK;
  }

  xFileSize(fileId: number, pSize64: DataView): number {
    if (fileId !== this.mainFileId) return VFS.SQLITE_IOERR;

    try {
      const size = this.wasm.getDataSize();
      pSize64.setBigInt64(0, BigInt(size), true);
      return VFS.SQLITE_OK;
    } catch {
      return VFS.SQLITE_IOERR;
    }
  }

  xDelete(_name: string, _syncDir: number): number {
    return VFS.SQLITE_OK;
  }

  xAccess(_name: string, _flags: number, pResOut: DataView): number {
    // The encrypted DB always "exists" once initialized.
    pResOut.setInt32(0, this.mainFileId !== null ? 1 : 0, true);
    return VFS.SQLITE_OK;
  }
}
