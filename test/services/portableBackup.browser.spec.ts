import { describe, expect, it, vi } from 'vitest';
import type { GossipSdk } from '@massalabs/gossip-sdk';
import {
  exportBrowserBackup,
  PortableBackupCleanupRequiredError,
} from '../../src/services/portableBackup';

interface FakeHandleOptions {
  corruptReadback?: boolean;
  removable?: boolean;
  initialBytes?: Uint8Array;
}

function fakeHandle(options: FakeHandleOptions = {}) {
  let bytes = options.initialBytes?.slice() ?? new Uint8Array(0);
  let removed = false;
  const handle = {
    async createWritable() {
      let draft = new Uint8Array(0);
      return {
        async write(chunk: Uint8Array) {
          const next = new Uint8Array(draft.byteLength + chunk.byteLength);
          next.set(draft);
          next.set(chunk, draft.byteLength);
          draft = next;
        },
        async truncate(size: number) {
          draft = draft.slice(0, size);
        },
        async close() {
          bytes = draft;
        },
        async abort() {},
      };
    },
    async getFile() {
      const output = bytes.slice();
      if (options.corruptReadback && output.byteLength > 0) output[0] ^= 1;
      return new File([output], 'backup.gossipbackup');
    },
    ...(options.removable === false
      ? {}
      : {
          async remove() {
            removed = true;
            bytes = new Uint8Array(0);
          },
        }),
  } as unknown as FileSystemFileHandle;
  return {
    handle,
    bytes: () => bytes,
    removed: () => removed,
  };
}

function fakeSdk(output: Uint8Array): GossipSdk {
  return {
    async exportPortableV1(
      write: (chunk: Uint8Array) => void | Promise<void>,
      progress: (value: { writtenBytes: number; totalBytes: number }) => void
    ) {
      progress({ writtenBytes: 0, totalBytes: output.byteLength });
      let writtenBytes = 0;
      for (const source of [output.slice(0, 2), output.slice(2)]) {
        await write(source);
        writtenBytes += source.byteLength;
        progress({ writtenBytes, totalBytes: output.byteLength });
      }
    },
  } as unknown as GossipSdk;
}

describe('browser portable backup transport', () => {
  it('streams, closes, and verifies the exact destination bytes', async () => {
    const destination = fakeHandle();
    const expected = new Uint8Array([1, 2, 3, 4, 5]);
    const progress: Array<[string, number, number]> = [];

    await exportBrowserBackup(fakeSdk(expected), destination.handle, value =>
      progress.push([value.phase, value.processedBytes, value.totalBytes])
    );

    expect(destination.bytes()).toEqual(expected);
    expect(destination.removed()).toBe(false);
    expect(progress).toEqual([
      ['writing', 0, 5],
      ['writing', 2, 5],
      ['writing', 5, 5],
      ['verifying', 0, 5],
      ['verifying', 5, 5],
    ]);
  });

  it('preserves an existing destination when preparation fails before commit', async () => {
    const original = new Uint8Array([8, 8, 8]);
    const destination = fakeHandle({ initialBytes: original });
    const sdk = {
      async exportPortableV1() {
        throw new Error('snapshot failed');
      },
    } as unknown as GossipSdk;

    await expect(exportBrowserBackup(sdk, destination.handle)).rejects.toThrow(
      'snapshot failed'
    );
    expect(destination.bytes()).toEqual(original);
    expect(destination.removed()).toBe(false);
  });

  it('propagates cancellation into SDK snapshot preparation', async () => {
    const destination = fakeHandle({ initialBytes: new Uint8Array([9]) });
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const sdk = {
      async exportPortableV1(
        _write: unknown,
        _progress: unknown,
        signal?: AbortSignal
      ) {
        observedSignal = signal;
        await new Promise<void>(resolve =>
          signal?.addEventListener('abort', () => resolve(), { once: true })
        );
        throw new DOMException('Backup cancelled', 'AbortError');
      },
    } as unknown as GossipSdk;

    const exporting = exportBrowserBackup(
      sdk,
      destination.handle,
      undefined,
      controller.signal
    );
    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort();
    await expect(exporting).rejects.toMatchObject({ name: 'AbortError' });
    expect(destination.bytes()).toEqual(new Uint8Array([9]));
  });

  it('deletes output that fails read-back verification', async () => {
    const destination = fakeHandle({ corruptReadback: true });

    await expect(
      exportBrowserBackup(
        fakeSdk(new Uint8Array([1, 2, 3])),
        destination.handle
      )
    ).rejects.toThrow('Backup read-back verification failed');
    expect(destination.removed()).toBe(true);
    expect(destination.bytes()).toHaveLength(0);
  });

  it('truncates and reports manual cleanup when browser deletion is unavailable', async () => {
    const destination = fakeHandle({
      corruptReadback: true,
      removable: false,
    });

    await expect(
      exportBrowserBackup(
        fakeSdk(new Uint8Array([1, 2, 3])),
        destination.handle
      )
    ).rejects.toBeInstanceOf(PortableBackupCleanupRequiredError);
    expect(destination.bytes()).toHaveLength(0);
  });

  it('does not open a destination after cancellation before preparation', async () => {
    const destination = fakeHandle();
    const createWritable = vi.spyOn(destination.handle, 'createWritable');
    const controller = new AbortController();
    controller.abort();

    await expect(
      exportBrowserBackup(
        fakeSdk(new Uint8Array([1])),
        destination.handle,
        undefined,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(createWritable).not.toHaveBeenCalled();
  });
});
