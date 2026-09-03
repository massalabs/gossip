const BACKUP_EXTENSION = '.gossipbackup';
const MIN_BACKUP_BYTES = 40 + 32;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024;
const IMPORT_CHUNK_BYTES = 256 * 1024;

interface BackupPickerWindow extends Window {
  showOpenFilePicker?: (options: {
    multiple: false;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
    excludeAcceptAllOption: boolean;
  }) => Promise<FileSystemFileHandle[]>;
}

export interface PortableImportProgress {
  readBytes: number;
  totalBytes: number;
}

export type PortableImportChunkReceiver = (
  chunk: Uint8Array
) => void | Promise<void>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
}

export function canStreamBrowserImport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as BackupPickerWindow).showOpenFilePicker === 'function' &&
    typeof File !== 'undefined' &&
    typeof File.prototype.stream === 'function'
  );
}

export async function selectBrowserBackupSource(): Promise<FileSystemFileHandle> {
  if (!canStreamBrowserImport()) {
    throw new Error('Streaming browser import is unavailable');
  }
  const handles = await (window as BackupPickerWindow).showOpenFilePicker!({
    multiple: false,
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
  if (handles.length !== 1) throw new Error('Select one Gossip backup');
  return handles[0];
}

/**
 * Stream one user-owned backup into an isolated validator.
 *
 * The source handle is read-only and is never deleted, truncated, or written.
 * Each receiver call receives a fresh mutable buffer of at most 256 KiB. That
 * individual buffer is wiped immediately after the call settles.
 * `finishValidation` runs only after
 * the exact file length has been admitted.
 */
export async function streamBrowserBackupImport(
  handle: FileSystemFileHandle,
  receive: PortableImportChunkReceiver,
  finishValidation: () => void | Promise<void>,
  onProgress?: (progress: PortableImportProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const file = await handle.getFile();
  throwIfAborted(signal);
  const totalBytes = file.size;
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < MIN_BACKUP_BYTES ||
    totalBytes > MAX_BACKUP_BYTES
  ) {
    throw new Error('Portable backup file size is invalid');
  }

  const reader = file.stream().getReader();
  const abort = () => {
    void reader
      .cancel(new DOMException('Import cancelled', 'AbortError'))
      .catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  let readBytes = 0;
  try {
    onProgress?.({ readBytes, totalBytes });
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) {
        throwIfAborted(signal);
        break;
      }
      if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        throw new Error('Backup source returned invalid bytes');
      }
      try {
        throwIfAborted(signal);
        for (
          let offset = 0;
          offset < value.byteLength;
          offset += IMPORT_CHUNK_BYTES
        ) {
          throwIfAborted(signal);
          const length = Math.min(
            IMPORT_CHUNK_BYTES,
            value.byteLength - offset
          );
          if (readBytes + length > totalBytes) {
            throw new Error('Backup source grew while importing');
          }
          const chunk = new Uint8Array(new ArrayBuffer(length));
          chunk.set(value.subarray(offset, offset + length));
          try {
            await receive(chunk);
            throwIfAborted(signal);
            readBytes += length;
            onProgress?.({ readBytes, totalBytes });
          } finally {
            chunk.fill(0);
          }
        }
      } finally {
        value.fill(0);
      }
    }
    if (readBytes !== totalBytes) {
      throw new Error('Backup source changed while importing');
    }
    throwIfAborted(signal);
    await finishValidation();
    throwIfAborted(signal);
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
