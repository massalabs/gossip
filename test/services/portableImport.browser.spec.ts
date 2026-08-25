import { describe, expect, it, vi } from 'vitest';
import {
  streamBrowserBackupImport,
  type PortableImportProgress,
} from '../../src/services/portableImport';

function sourceHandle(
  bytes: Uint8Array,
  options: { declaredSize?: number; stream?: ReadableStream<Uint8Array> } = {}
): FileSystemFileHandle {
  return {
    async getFile() {
      const file = new File([bytes], 'source.gossipbackup');
      if (!options.stream && options.declaredSize === undefined) return file;
      return {
        size: options.declaredSize ?? bytes.byteLength,
        stream: () => options.stream ?? file.stream(),
      } as File;
    },
  } as unknown as FileSystemFileHandle;
}

describe('browser portable import transport', () => {
  it('streams bounded sequential chunks and wipes them after admission', async () => {
    const expected = new Uint8Array(700_000);
    crypto.getRandomValues(expected.subarray(0, 65_536));
    expected.fill(7, 65_536);
    const admitted: Uint8Array[] = [];
    const received: Uint8Array[] = [];
    const progress: PortableImportProgress[] = [];
    const finish = vi.fn();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(expected.slice());
        controller.close();
      },
    });
    await streamBrowserBackupImport(
      sourceHandle(expected, { stream }),
      async chunk => {
        admitted.push(chunk);
        received.push(chunk.slice());
      },
      finish,
      value => progress.push(value)
    );

    const reconstructed = new Uint8Array(expected.byteLength);
    let offset = 0;
    for (const chunk of received) {
      reconstructed.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(reconstructed).toEqual(expected);
    expect(admitted.length).toBeGreaterThan(1);
    expect(admitted.every(chunk => chunk.byteLength <= 256 * 1024)).toBe(true);
    expect(admitted.every(chunk => chunk.every(byte => byte === 0))).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
    expect(progress[0]).toEqual({
      readBytes: 0,
      totalBytes: expected.byteLength,
    });
    expect(progress.at(-1)).toEqual({
      readBytes: expected.byteLength,
      totalBytes: expected.byteLength,
    });
  });

  it('rejects invalid declared sizes before admitting any bytes', async () => {
    const receive = vi.fn();
    const finish = vi.fn();

    await expect(
      streamBrowserBackupImport(
        sourceHandle(new Uint8Array(71)),
        receive,
        finish
      )
    ).rejects.toThrow('Portable backup file size is invalid');
    expect(receive).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('rejects a source that ends before its immutable file size', async () => {
    const finish = vi.fn();
    await expect(
      streamBrowserBackupImport(
        sourceHandle(new Uint8Array(72), { declaredSize: 100 }),
        () => undefined,
        finish
      )
    ).rejects.toThrow('Backup source changed while importing');
    expect(finish).not.toHaveBeenCalled();
  });

  it('wipes an admitted chunk when the validator rejects it', async () => {
    let borrowed: Uint8Array | null = null;
    const finish = vi.fn();
    await expect(
      streamBrowserBackupImport(
        sourceHandle(new Uint8Array(72).fill(5)),
        chunk => {
          borrowed = chunk;
          throw new Error('invalid archive');
        },
        finish
      )
    ).rejects.toThrow('invalid archive');
    expect(Array.from(borrowed!)).toEqual(
      Array.from({ length: borrowed!.byteLength }, () => 0)
    );
    expect(finish).not.toHaveBeenCalled();
  });

  it('stops chunk admission when cancellation occurs during backpressure', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const receive = vi.fn(async () => gate);
    const progress: PortableImportProgress[] = [];
    const controller = new AbortController();
    const source = new Uint8Array(600_000).fill(4);
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(source);
        streamController.close();
      },
    });
    const importing = streamBrowserBackupImport(
      sourceHandle(source, { stream }),
      receive,
      () => undefined,
      value => progress.push(value),
      controller.signal
    );
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    controller.abort();
    release();

    await expect(importing).rejects.toMatchObject({ name: 'AbortError' });
    expect(receive).toHaveBeenCalledOnce();
    expect(progress).toEqual([{ readBytes: 0, totalBytes: source.byteLength }]);
  });

  it('rejects cancellation that occurs during final validation', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const finish = vi.fn(async () => gate);
    const controller = new AbortController();
    const importing = streamBrowserBackupImport(
      sourceHandle(new Uint8Array(72)),
      () => undefined,
      finish,
      undefined,
      controller.signal
    );
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
    controller.abort();
    release();

    await expect(importing).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('actively cancels a pending source read', async () => {
    let sourceCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        sourceCancelled = true;
      },
    });
    const controller = new AbortController();
    const importing = streamBrowserBackupImport(
      sourceHandle(new Uint8Array(72), { stream }),
      () => undefined,
      () => undefined,
      undefined,
      controller.signal
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();

    await expect(importing).rejects.toMatchObject({ name: 'AbortError' });
    expect(sourceCancelled).toBe(true);
  });
});
