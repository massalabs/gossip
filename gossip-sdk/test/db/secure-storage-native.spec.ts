import { beforeEach, describe, expect, it, vi } from 'vitest';

const { nativeCall } = vi.hoisted(() => ({ nativeCall: vi.fn() }));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ call: nativeCall }),
}));

import { SecureStorageNative } from '../../src/db/secure-storage-native.js';

function result(value: unknown): Promise<{ result: string }> {
  return Promise.resolve({ result: JSON.stringify(value) });
}

describe('secure-storage native portable transfer', () => {
  beforeEach(() => {
    nativeCall.mockReset();
  });

  it('streams export chunks and finishes the native spool', async () => {
    const chunks = [btoa('first'), btoa('second'), null];
    nativeCall.mockImplementation(
      ({ method }: { method: string; args: string }) => {
        if (method === 'readPortableExportChunk') return result(chunks.shift());
        return result(null);
      }
    );
    const written: number[][] = [];

    await SecureStorageNative.exportPortableV1(chunk => {
      written.push(Array.from(chunk));
    });

    expect(written).toEqual([
      Array.from(new TextEncoder().encode('first')),
      Array.from(new TextEncoder().encode('second')),
    ]);
    expect(nativeCall.mock.calls.map(([options]) => options.method)).toEqual([
      'beginPortableExport',
      'readPortableExportChunk',
      'readPortableExportChunk',
      'readPortableExportChunk',
      'finishPortableExport',
    ]);
    expect(JSON.parse(nativeCall.mock.calls[1][0].args)).toEqual({
      maxBytes: 256 * 1024,
    });
  });

  it('aborts export when the destination rejects a chunk', async () => {
    nativeCall.mockImplementation(
      ({ method }: { method: string; args: string }) => {
        if (method === 'readPortableExportChunk') return result(btoa('chunk'));
        return result(null);
      }
    );

    await expect(
      SecureStorageNative.exportPortableV1(() => {
        throw new Error('destination failed');
      })
    ).rejects.toThrow('destination failed');

    expect(nativeCall.mock.calls.map(([options]) => options.method)).toEqual([
      'beginPortableExport',
      'readPortableExportChunk',
      'abortPortableTransfer',
    ]);
  });

  it('streams import chunks and atomically finishes native validation', async () => {
    const chunks: Array<Uint8Array | null> = [
      Uint8Array.from([1, 2]),
      new Uint8Array(),
      Uint8Array.from([3]),
      null,
    ];
    nativeCall.mockImplementation(() => result(null));

    await SecureStorageNative.importPortableV1(() => chunks.shift() ?? null);

    expect(nativeCall.mock.calls.map(([options]) => options.method)).toEqual([
      'beginPortableImport',
      'pushPortableImportChunk',
      'pushPortableImportChunk',
      'finishPortableImport',
    ]);
    expect(JSON.parse(nativeCall.mock.calls[1][0].args)).toEqual({
      data: btoa(String.fromCharCode(1, 2)),
    });
    expect(JSON.parse(nativeCall.mock.calls[2][0].args)).toEqual({
      data: btoa(String.fromCharCode(3)),
    });
  });

  it('splits oversized reader chunks before crossing the bridge', async () => {
    const large = new Uint8Array(256 * 1024 + 3);
    large[large.length - 1] = 7;
    const chunks: Array<Uint8Array | null> = [large, null];
    nativeCall.mockImplementation(() => result(null));

    await SecureStorageNative.importPortableV1(() => chunks.shift() ?? null);

    const pushes = nativeCall.mock.calls.filter(
      ([options]) => options.method === 'pushPortableImportChunk'
    );
    expect(pushes).toHaveLength(2);
    expect(atob(JSON.parse(pushes[0][0].args).data)).toHaveLength(256 * 1024);
    expect(
      Array.from(atob(JSON.parse(pushes[1][0].args).data), c => c.charCodeAt(0))
    ).toEqual([0, 0, 7]);
  });

  it('serializes complete transfers so one abort cannot cancel another', async () => {
    let releaseRead: ((value: { result: string }) => void) | undefined;
    const blockedRead = new Promise<{ result: string }>(resolve => {
      releaseRead = resolve;
    });
    nativeCall.mockImplementation(
      ({ method }: { method: string; args: string }) => {
        if (method === 'readPortableExportChunk') return blockedRead;
        return result(null);
      }
    );

    const exporting = SecureStorageNative.exportPortableV1(() => {});
    await vi.waitFor(() => {
      expect(
        nativeCall.mock.calls.some(
          ([o]) => o.method === 'readPortableExportChunk'
        )
      ).toBe(true);
    });
    const importing = SecureStorageNative.importPortableV1(() => null);
    await Promise.resolve();
    expect(
      nativeCall.mock.calls.some(([o]) => o.method === 'beginPortableImport')
    ).toBe(false);

    releaseRead?.({ result: 'null' });
    await exporting;
    await importing;
    expect(nativeCall.mock.calls.map(([options]) => options.method)).toEqual([
      'beginPortableExport',
      'readPortableExportChunk',
      'finishPortableExport',
      'beginPortableImport',
      'finishPortableImport',
    ]);
  });

  it('aborts import when the source rejects', async () => {
    nativeCall.mockImplementation(() => result(null));

    await expect(
      SecureStorageNative.importPortableV1(() => {
        throw new Error('source failed');
      })
    ).rejects.toThrow('source failed');

    expect(nativeCall.mock.calls.map(([options]) => options.method)).toEqual([
      'beginPortableImport',
      'abortPortableTransfer',
    ]);
  });
});
