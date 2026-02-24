/**
 * Node.js file-system VFS for wa-sqlite.
 *
 * Extends VFS.Base using Node.js `fs` sync APIs for file persistence.
 * Follows the MemoryVFS pattern but writes to real files on disk.
 *
 * Locking: inherited no-ops from VFS.Base (sufficient for single-process).
 * This VFS will later be replaceable by the encrypted VFS from the storage branch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as VFS from 'wa-sqlite/src/VFS.js';

interface OpenFile {
  name: string;
  fd: number;
  flags: number;
}

export class NodeFsVFS extends VFS.Base {
  name = 'node-fs';

  private directory: string;
  private mapIdToFile = new Map<number, OpenFile>();

  constructor(directory: string) {
    super();
    this.mxPathName = 255;
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
  }

  private resolvePath(name: string): string {
    return path.join(this.directory, name);
  }

  xOpen(
    name: string | null,
    fileId: number,
    flags: number,
    pOutFlags: DataView
  ): number {
    name =
      name || Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
    const filePath = this.resolvePath(name);

    let openFlags = fs.constants.O_RDWR;
    if (flags & VFS.SQLITE_OPEN_CREATE) {
      openFlags |= fs.constants.O_CREAT;
    }

    try {
      const fd = fs.openSync(filePath, openFlags, 0o644);
      this.mapIdToFile.set(fileId, { name, fd, flags });
      pOutFlags.setInt32(0, flags, true);
      return VFS.SQLITE_OK;
    } catch {
      return VFS.SQLITE_CANTOPEN;
    }
  }

  xClose(fileId: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return VFS.SQLITE_OK;
    this.mapIdToFile.delete(fileId);

    try {
      fs.closeSync(file.fd);
    } catch {
      // ignore close errors
    }

    if (file.flags & VFS.SQLITE_OPEN_DELETEONCLOSE) {
      try {
        fs.unlinkSync(this.resolvePath(file.name));
      } catch {
        // ignore delete errors
      }
    }

    return VFS.SQLITE_OK;
  }

  // wa-sqlite d.ts declares pData as { size; value } but runtime passes
  // a plain Uint8Array. Cast to match the base class signature.
  xRead(
    fileId: number,
    pData_: { size: number; value: Uint8Array },
    iOffset: number
  ): number {
    const pData = pData_ as unknown as Uint8Array;
    const file = this.mapIdToFile.get(fileId);
    if (!file) return VFS.SQLITE_IOERR;

    try {
      const nRead = fs.readSync(file.fd, pData, 0, pData.byteLength, iOffset);
      if (nRead < pData.byteLength) {
        pData.fill(0, nRead);
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
    const file = this.mapIdToFile.get(fileId);
    if (!file) return VFS.SQLITE_IOERR;

    try {
      fs.writeSync(file.fd, pData, 0, pData.byteLength, iOffset);
      return VFS.SQLITE_OK;
    } catch {
      return VFS.SQLITE_IOERR;
    }
  }

  xTruncate(fileId: number, iSize: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return VFS.SQLITE_IOERR;

    try {
      fs.ftruncateSync(file.fd, iSize);
      return VFS.SQLITE_OK;
    } catch {
      return VFS.SQLITE_IOERR;
    }
  }

  xSync(fileId: number, _flags: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return VFS.SQLITE_IOERR;

    try {
      fs.fsyncSync(file.fd);
      return VFS.SQLITE_OK;
    } catch {
      return VFS.SQLITE_IOERR;
    }
  }

  xFileSize(fileId: number, pSize64: DataView): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return VFS.SQLITE_IOERR;

    try {
      const size = fs.fstatSync(file.fd).size;
      pSize64.setBigInt64(0, BigInt(size), true);
      return VFS.SQLITE_OK;
    } catch {
      return VFS.SQLITE_IOERR;
    }
  }

  xDelete(name: string, _syncDir: number): number {
    try {
      fs.unlinkSync(this.resolvePath(name));
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        return VFS.SQLITE_IOERR;
      }
    }
    return VFS.SQLITE_OK;
  }

  xAccess(name: string, _flags: number, pResOut: DataView): number {
    const exists = fs.existsSync(this.resolvePath(name));
    pResOut.setInt32(0, exists ? 1 : 0, true);
    return VFS.SQLITE_OK;
  }
}
