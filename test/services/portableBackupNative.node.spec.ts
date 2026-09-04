import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GossipSdk } from '@massalabs/gossip-sdk';

const mocks = vi.hoisted(() => ({
  platform: 'android',
  plugin: {
    selectExportDestination: vi.fn(),
    selectImportSource: vi.fn(),
    readImportChunk: vi.fn(),
    finishImportSource: vi.fn(),
    beginExport: vi.fn(),
    writeExportChunk: vi.fn(),
    finishExport: vi.fn(),
    beginVerification: vi.fn(),
    readVerificationChunk: vi.fn(),
    finishVerification: vi.fn(),
    listInterruptedOutputs: vi.fn(),
    deleteOutput: vi.fn(),
    resetRecoveryJournal: vi.fn(),
    startProtection: vi.fn(),
    updateProtection: vi.fn(),
    stopProtection: vi.fn(),
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => mocks.platform },
  registerPlugin: () => mocks.plugin,
}));

import {
  cleanupInterruptedNativeBackups,
  exportNativeBackup,
  streamNativeBackupImport,
} from '../../src/services/portableBackupNative';
import { PortableBackupCleanupRequiredError } from '../../src/services/portableBackup';

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function sdkFor(bytes: Uint8Array): GossipSdk {
  return {
    async exportPortableV1(
      write: (chunk: Uint8Array) => Promise<void>,
      progress: (value: { writtenBytes: number; totalBytes: number }) => void
    ) {
      progress({ writtenBytes: 0, totalBytes: bytes.byteLength });
      await write(bytes.slice());
      progress({
        writtenBytes: bytes.byteLength,
        totalBytes: bytes.byteLength,
      });
    },
  } as unknown as GossipSdk;
}

const destination = { token: 'opaque-token', name: 'backup.gossipbackup' };
const labels = {
  notificationTitle: 'Backup',
  preparing: 'Preparing',
  writing: 'Writing',
  verifying: 'Verifying',
};

function decodeWrite(): Uint8Array {
  const encoded = mocks.plugin.writeExportChunk.mock.calls[0][0].data;
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}

describe('Android portable backup transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform = 'android';
    for (const method of [
      'beginExport',
      'beginVerification',
      'finishVerification',
      'startProtection',
      'updateProtection',
      'stopProtection',
      'finishImportSource',
    ] as const) {
      mocks.plugin[method].mockResolvedValue(undefined);
    }
    mocks.plugin.writeExportChunk.mockImplementation(async () => ({
      writtenBytes: decodeWrite().byteLength,
    }));
    mocks.plugin.finishExport.mockImplementation(async () => ({
      writtenBytes: decodeWrite().byteLength,
    }));
    mocks.plugin.deleteOutput.mockResolvedValue({ deleted: true });
    mocks.plugin.listInterruptedOutputs.mockResolvedValue({ outputs: [] });
    mocks.plugin.resetRecoveryJournal.mockResolvedValue(undefined);
  });

  it('streams a read-only import source, wipes chunks, and releases its token', async () => {
    const expected = new Uint8Array(80).map((_, index) => index);
    mocks.plugin.readImportChunk
      .mockResolvedValueOnce({ data: base64(expected) })
      .mockResolvedValueOnce({ data: null });
    let borrowed: Uint8Array | null = null;
    const finishValidation = vi.fn().mockResolvedValue(undefined);

    await streamNativeBackupImport(
      { token: 'source-token', name: 'source.gossipbackup', totalBytes: 80 },
      chunk => {
        borrowed = chunk;
        expect(chunk).toEqual(expected);
      },
      finishValidation
    );

    expect(finishValidation).toHaveBeenCalledOnce();
    expect(mocks.plugin.finishImportSource).toHaveBeenCalledWith({
      token: 'source-token',
    });
    expect(Array.from(borrowed!)).toEqual(new Array(80).fill(0));
  });

  it('rejects changed native source length and still releases access', async () => {
    mocks.plugin.readImportChunk.mockResolvedValueOnce({
      data: base64(new Uint8Array(73)),
    });

    await expect(
      streamNativeBackupImport(
        { token: 'source-token', name: 'source.gossipbackup', totalBytes: 72 },
        vi.fn(),
        vi.fn()
      )
    ).rejects.toThrow('source length changed');
    expect(mocks.plugin.finishImportSource).toHaveBeenCalledWith({
      token: 'source-token',
    });
  });

  it('writes, fsyncs, reads back, and verifies exact native bytes', async () => {
    const expected = new Uint8Array([1, 2, 3, 4, 5]);
    mocks.plugin.readVerificationChunk
      .mockResolvedValueOnce({ data: base64(expected) })
      .mockResolvedValueOnce({ data: null });
    const progress: Array<[string, number, number]> = [];

    await exportNativeBackup(sdkFor(expected), destination, labels, value =>
      progress.push([value.phase, value.processedBytes, value.totalBytes])
    );

    expect(decodeWrite()).toEqual(expected);
    expect(mocks.plugin.finishExport).toHaveBeenCalledWith({
      token: destination.token,
    });
    expect(mocks.plugin.finishVerification).toHaveBeenCalledWith({
      token: destination.token,
    });
    expect(mocks.plugin.deleteOutput).not.toHaveBeenCalled();
    expect(mocks.plugin.stopProtection).toHaveBeenCalledOnce();
    expect(progress).toEqual([
      ['writing', 0, 5],
      ['writing', 5, 5],
      ['verifying', 0, 5],
      ['verifying', 5, 5],
    ]);
  });

  it('deletes a committed destination after read-back corruption', async () => {
    const expected = new Uint8Array([1, 2, 3]);
    mocks.plugin.readVerificationChunk
      .mockResolvedValueOnce({ data: base64(new Uint8Array([9, 2, 3])) })
      .mockResolvedValueOnce({ data: null });

    await expect(
      exportNativeBackup(sdkFor(expected), destination, labels)
    ).rejects.toThrow('Native backup read-back verification failed');
    expect(mocks.plugin.deleteOutput).toHaveBeenCalledWith({
      token: destination.token,
    });
    expect(mocks.plugin.finishVerification).not.toHaveBeenCalled();
  });

  it('surfaces manual cleanup when deletion and truncation are unavailable', async () => {
    const expected = new Uint8Array([1, 2, 3]);
    mocks.plugin.readVerificationChunk.mockRejectedValueOnce(
      new Error('provider unavailable')
    );
    mocks.plugin.deleteOutput.mockResolvedValueOnce({ deleted: false });

    await expect(
      exportNativeBackup(sdkFor(expected), destination, labels)
    ).rejects.toBeInstanceOf(PortableBackupCleanupRequiredError);
  });

  it('resets only an unreadable iOS journal after explicit manual cleanup', async () => {
    mocks.platform = 'ios';
    mocks.plugin.listInterruptedOutputs.mockRejectedValueOnce(
      new Error('journal unreadable')
    );

    const { forgetInterruptedNativeBackups } =
      await import('../../src/services/portableBackupNative');
    await expect(forgetInterruptedNativeBackups()).resolves.toBeUndefined();
    expect(mocks.plugin.resetRecoveryJournal).toHaveBeenCalledOnce();
  });

  it('never invokes the iOS journal reset after an Android listing failure', async () => {
    mocks.plugin.listInterruptedOutputs.mockRejectedValueOnce(
      new Error('Android bridge unavailable')
    );
    const { forgetInterruptedNativeBackups } =
      await import('../../src/services/portableBackupNative');

    await expect(forgetInterruptedNativeBackups()).rejects.toThrow(
      'Android bridge unavailable'
    );
    expect(mocks.plugin.resetRecoveryJournal).not.toHaveBeenCalled();
  });

  it('deletes every recoverable interrupted output before retry', async () => {
    mocks.plugin.listInterruptedOutputs.mockResolvedValueOnce({
      outputs: [
        { token: 'one', name: 'one.gossipbackup' },
        { token: 'two', name: 'two.gossipbackup' },
      ],
    });
    mocks.plugin.deleteOutput
      .mockResolvedValueOnce({ deleted: true })
      .mockResolvedValueOnce({ deleted: true });

    await expect(cleanupInterruptedNativeBackups()).resolves.toEqual({
      cleaned: true,
      remaining: [],
    });
    expect(mocks.plugin.deleteOutput).toHaveBeenCalledTimes(2);
  });
});
