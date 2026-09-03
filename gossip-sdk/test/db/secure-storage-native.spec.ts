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
        if (method === 'beginPortableExport') return result(11);
        if (method === 'readPortableExportChunk') return result(chunks.shift());
        return result(null);
      }
    );
    const written: number[][] = [];
    const progress: Array<[number, number]> = [];

    await SecureStorageNative.exportPortableV1(
      chunk => {
        written.push(Array.from(chunk));
      },
      value => progress.push([value.writtenBytes, value.totalBytes])
    );

    expect(written).toEqual([
      Array.from(new TextEncoder().encode('first')),
      Array.from(new TextEncoder().encode('second')),
    ]);
    expect(progress).toEqual([
      [0, 11],
      [5, 11],
      [11, 11],
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
        if (method === 'beginPortableExport') return result(5);
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

  it('stages, migrates, then installs a native import', async () => {
    nativeCall.mockImplementation(() => result(null));

    await SecureStorageNative.beginPortableImport();
    await SecureStorageNative.pushPortableImportChunk(
      Uint8Array.from([1, 2, 3])
    );
    await SecureStorageNative.validatePortableImport();
    await SecureStorageNative.beginPortableOuterMigration();
    await SecureStorageNative.finishPortableOuterMigration();
    await SecureStorageNative.installPortableImport();

    expect(nativeCall.mock.calls.map(([options]) => options.method)).toEqual([
      'beginPortableImport',
      'pushPortableImportChunk',
      'validatePortableImport',
      'beginPortableOuterMigration',
      'finishPortableOuterMigration',
      'installPortableImport',
    ]);
    expect(JSON.parse(nativeCall.mock.calls[1][0].args)).toEqual({
      data: btoa(String.fromCharCode(1, 2, 3)),
    });
  });

  it('splits oversized staged chunks before crossing the bridge', async () => {
    const large = new Uint8Array(256 * 1024 + 3);
    large[large.length - 1] = 7;
    nativeCall.mockImplementation(() => result(null));

    await SecureStorageNative.pushPortableImportChunk(large);

    const pushes = nativeCall.mock.calls.filter(
      ([options]) => options.method === 'pushPortableImportChunk'
    );
    expect(pushes).toHaveLength(2);
    expect(atob(JSON.parse(pushes[0][0].args).data)).toHaveLength(256 * 1024);
    expect(
      Array.from(atob(JSON.parse(pushes[1][0].args).data), c => c.charCodeAt(0))
    ).toEqual([0, 0, 7]);
  });

  it('sequences native outer-migration password admission', async () => {
    nativeCall.mockImplementation(() => result(null));
    const password = new Uint8Array([7, 8, 9]);

    await SecureStorageNative.beginPortableOuterMigration();
    await SecureStorageNative.admitPortableOuterMigrationPassword(password);
    await SecureStorageNative.finishPortableOuterMigration();

    expect(nativeCall.mock.calls.map(([options]) => options.method)).toEqual([
      'beginPortableOuterMigration',
      'admitPortableOuterMigrationPassword',
      'finishPortableOuterMigration',
    ]);
    expect(JSON.parse(nativeCall.mock.calls[1][0].args)).toEqual({
      password: btoa(String.fromCharCode(7, 8, 9)),
    });
    // The caller retains this successful password for later private migration.
    expect(Array.from(password)).toEqual([7, 8, 9]);
  });

  it('keeps each staged native push contiguous under concurrency', async () => {
    nativeCall.mockImplementation(() => result(null));
    const first = new Uint8Array(256 * 1024 + 1).fill(1);
    const second = new Uint8Array(256 * 1024 + 1).fill(2);

    await Promise.all([
      SecureStorageNative.pushPortableImportChunk(first),
      SecureStorageNative.pushPortableImportChunk(second),
    ]);

    const firstBytes = nativeCall.mock.calls.map(([options]) => {
      const { data } = JSON.parse(options.args) as { data: string };
      return atob(data).charCodeAt(0);
    });
    expect(firstBytes).toEqual([1, 1, 2, 2]);
  });

  it('authenticates a staged candidate without adding slot metadata', async () => {
    nativeCall.mockResolvedValueOnce({
      result: JSON.stringify({
        userId:
          'gossip1ywzkutgadznd0509tsl4gs4xjvsudhzgjuxc46ytngvq0lacx5es2xyz5s',
        username: 'Alice',
        avatar: null,
        createdAtMs: 1234,
      }),
    });
    const password = new Uint8Array([1, 2, 3]);

    await expect(
      SecureStorageNative.authenticatePortableImportCandidate({ password })
    ).resolves.toEqual({
      userId:
        'gossip1ywzkutgadznd0509tsl4gs4xjvsudhzgjuxc46ytngvq0lacx5es2xyz5s',
      username: 'Alice',
      avatar: null,
      createdAtMs: 1234,
    });
    expect(nativeCall).toHaveBeenCalledWith({
      method: 'authenticatePortableImportCandidate',
      args: JSON.stringify({ password: btoa(String.fromCharCode(1, 2, 3)) }),
    });
  });
});
