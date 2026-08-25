import { sha256 } from '@noble/hashes/sha2';
import type {
  GossipSdk,
  PortableTransferProgress,
} from '@massalabs/gossip-sdk';

const BACKUP_EXTENSION = '.gossipbackup';
const MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024;

interface BackupPickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
    excludeAcceptAllOption: boolean;
  }) => Promise<FileSystemFileHandle>;
}

interface RemovableFileSystemFileHandle extends FileSystemFileHandle {
  remove?: () => Promise<void>;
}

export interface PortableBackupProgress {
  phase: 'writing' | 'verifying';
  processedBytes: number;
  totalBytes: number;
}

export type PortableBackupProgressCallback = (
  progress: PortableBackupProgress
) => void;

export class PortableBackupCleanupRequiredError extends Error {
  constructor(
    message: string,
    readonly cause: unknown
  ) {
    super(message);
    this.name = 'PortableBackupCleanupRequiredError';
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Backup cancelled', 'AbortError');
}

export function restartAfterPortableBackup(path: string): void {
  window.history.replaceState(null, '', path);
  window.location.reload();
}

export function canStreamBrowserBackup(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as BackupPickerWindow).showSaveFilePicker === 'function' &&
    typeof File !== 'undefined' &&
    typeof File.prototype.stream === 'function'
  );
}

export async function selectBrowserBackupDestination(): Promise<FileSystemFileHandle> {
  if (!canStreamBrowserBackup()) {
    throw new Error('Streaming browser backup is unavailable');
  }
  return (window as BackupPickerWindow).showSaveFilePicker!({
    suggestedName: `gossip-backup${BACKUP_EXTENSION}`,
    types: [
      {
        description: 'Gossip backup',
        accept: {
          'application/octet-stream': [BACKUP_EXTENSION],
        },
      },
    ],
    excludeAcceptAllOption: true,
  });
}

async function removeUnverifiedOutput(
  handle: RemovableFileSystemFileHandle
): Promise<boolean> {
  if (handle.remove) {
    try {
      await handle.remove();
      return true;
    } catch {
      // Fall through to secure truncation. The UI must still tell the user to
      // remove the empty filename because browser file APIs cannot always
      // delete user-owned directory entries.
    }
  }
  try {
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.truncate(0);
    await writable.close();
  } catch {
    return false;
  }
  return false;
}

async function verifyWrittenBackup(
  handle: FileSystemFileHandle,
  expectedLength: number,
  expectedDigest: Uint8Array,
  onProgress?: PortableBackupProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  const file = await handle.getFile();
  if (file.size !== expectedLength) {
    throw new Error('Backup read-back length does not match written output');
  }
  const hash = sha256.create();
  const reader = file.stream().getReader();
  const abort = () => {
    void reader
      .cancel(new DOMException('Backup cancelled', 'AbortError'))
      .catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  let verifiedBytes = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) {
        throwIfAborted(signal);
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new Error('Backup verification returned invalid bytes');
      }
      try {
        throwIfAborted(signal);
        verifiedBytes += value.byteLength;
        if (verifiedBytes > MAX_BACKUP_BYTES) {
          throw new Error('Backup verification exceeds size limit');
        }
        hash.update(value);
        onProgress?.({
          phase: 'verifying',
          processedBytes: verifiedBytes,
          totalBytes: expectedLength,
        });
      } finally {
        value.fill(0);
      }
    }
    if (
      verifiedBytes !== expectedLength ||
      !equalBytes(hash.digest(), expectedDigest)
    ) {
      throw new Error('Backup read-back verification failed');
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    hash.destroy();
    reader.releaseLock();
  }
}

export async function exportBrowserBackup(
  sdk: GossipSdk,
  handle: FileSystemFileHandle,
  onProgress?: PortableBackupProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  let writable: FileSystemWritableFileStream | null = null;
  let writtenBytes = 0;
  let totalBytes = 0;
  const hash = sha256.create();
  let outputDigest: Uint8Array | null = null;
  let committedOutput = false;
  try {
    writable = await handle.createWritable({ keepExistingData: false });
    throwIfAborted(signal);
    await sdk.exportPortableV1(
      async chunk => {
        let output: Uint8Array<ArrayBuffer> | null = null;
        try {
          throwIfAborted(signal);
          if (
            totalBytes <= 0 ||
            !Number.isSafeInteger(totalBytes) ||
            totalBytes > MAX_BACKUP_BYTES ||
            writtenBytes + chunk.byteLength > totalBytes
          ) {
            throw new Error('Backup output exceeds declared size');
          }
          output = new Uint8Array(new ArrayBuffer(chunk.byteLength));
          output.set(chunk);
          await writable!.write(output);
          hash.update(output);
          writtenBytes += output.byteLength;
        } finally {
          output?.fill(0);
          chunk.fill(0);
        }
      },
      (progress: PortableTransferProgress) => {
        if (
          !Number.isSafeInteger(progress.totalBytes) ||
          progress.totalBytes <= 0 ||
          progress.totalBytes > MAX_BACKUP_BYTES ||
          !Number.isSafeInteger(progress.writtenBytes) ||
          progress.writtenBytes < 0 ||
          progress.writtenBytes > progress.totalBytes
        ) {
          throw new Error('Invalid portable backup progress');
        }
        totalBytes = progress.totalBytes;
        onProgress?.({
          phase: 'writing',
          processedBytes: progress.writtenBytes,
          totalBytes: progress.totalBytes,
        });
      },
      signal
    );
    throwIfAborted(signal);
    if (totalBytes <= 0 || writtenBytes !== totalBytes) {
      throw new Error('Backup output length does not match secure snapshot');
    }
    await writable.close();
    writable = null;
    committedOutput = true;
    outputDigest = hash.digest();
    onProgress?.({
      phase: 'verifying',
      processedBytes: 0,
      totalBytes,
    });
    await verifyWrittenBackup(
      handle,
      totalBytes,
      outputDigest,
      onProgress,
      signal
    );
  } catch (error) {
    if (writable) await writable.abort(error).catch(() => {});
    if (committedOutput) {
      const removed = await removeUnverifiedOutput(handle);
      if (!removed) {
        throw new PortableBackupCleanupRequiredError(
          'The unverified backup output must be deleted manually',
          error
        );
      }
    }
    throw error;
  } finally {
    hash.destroy();
    outputDigest?.fill(0);
  }
}
