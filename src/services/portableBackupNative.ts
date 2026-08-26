import { Capacitor, registerPlugin } from '@capacitor/core';
import { sha256 } from '@noble/hashes/sha2';
import type {
  GossipSdk,
  PortableTransferProgress,
} from '@massalabs/gossip-sdk';
import {
  PortableBackupCleanupRequiredError,
  type PortableBackupProgress,
} from './portableBackup';

const CHUNK_BYTES = 256 * 1024;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024;

interface NativeDestination {
  token: string;
  name: string;
}

interface NativeSource extends NativeDestination {
  totalBytes: number;
}

interface NativeFilePlugin {
  selectExportDestination(): Promise<NativeDestination>;
  selectImportSource(): Promise<NativeSource>;
  readImportChunk(options: {
    token: string;
    maxBytes: number;
  }): Promise<{ data: string | null }>;
  finishImportSource(options: { token: string }): Promise<void>;
  beginExport(options: { token: string }): Promise<void>;
  writeExportChunk(options: {
    token: string;
    data: string;
  }): Promise<{ writtenBytes: number }>;
  finishExport(options: { token: string }): Promise<{ writtenBytes: number }>;
  beginVerification(options: { token: string }): Promise<void>;
  readVerificationChunk(options: {
    token: string;
    maxBytes: number;
  }): Promise<{ data: string | null }>;
  finishVerification(options: { token: string }): Promise<void>;
  listInterruptedOutputs(): Promise<{ outputs: NativeDestination[] }>;
  deleteOutput(options: { token: string }): Promise<{ deleted: boolean }>;
  forgetOutput(options: { token: string }): Promise<void>;
  resetRecoveryJournal(): Promise<void>;
  abandon(options: { token: string }): Promise<{ deleted: boolean }>;
  startProtection(options: { title: string; text: string }): Promise<void>;
  updateProtection(options: {
    text: string;
    processedBytes: number;
    totalBytes: number;
  }): Promise<void>;
  stopProtection(): Promise<void>;
}

const nativeFiles = registerPlugin<NativeFilePlugin>('PortableBackupFile');

export interface NativeBackupLabels {
  notificationTitle: string;
  preparing: string;
  writing: string;
  verifying: string;
}

export type NativeBackupDestination = NativeDestination;
export type NativeBackupSource = NativeSource;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Backup cancelled', 'AbortError');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function validProgress(progress: PortableTransferProgress): boolean {
  return (
    Number.isSafeInteger(progress.totalBytes) &&
    progress.totalBytes > 0 &&
    progress.totalBytes <= MAX_BACKUP_BYTES &&
    Number.isSafeInteger(progress.writtenBytes) &&
    progress.writtenBytes >= 0 &&
    progress.writtenBytes <= progress.totalBytes
  );
}

export function selectNativeBackupDestination(): Promise<NativeBackupDestination> {
  return nativeFiles.selectExportDestination();
}

export function selectNativeBackupSource(): Promise<NativeBackupSource> {
  return nativeFiles.selectImportSource();
}

export function releaseNativeBackupSource(
  source: NativeBackupSource
): Promise<void> {
  return nativeFiles.finishImportSource({ token: source.token });
}

/** Stream a read-only native document through bounded, wipeable bridge chunks. */
export async function streamNativeBackupImport(
  source: NativeBackupSource,
  receive: (chunk: Uint8Array) => void | Promise<void>,
  finishValidation: () => void | Promise<void>,
  onProgress?: (readBytes: number, totalBytes: number) => void,
  signal?: AbortSignal,
  labels?: NativeBackupLabels
): Promise<void> {
  if (
    !Number.isSafeInteger(source.totalBytes) ||
    source.totalBytes < 72 ||
    source.totalBytes > MAX_BACKUP_BYTES
  ) {
    await nativeFiles
      .finishImportSource({ token: source.token })
      .catch(() => {});
    throw new Error('Portable backup file size is invalid');
  }
  let readBytes = 0;
  try {
    if (labels) {
      await nativeFiles.startProtection({
        title: labels.notificationTitle,
        text: labels.preparing,
      });
    }
    onProgress?.(readBytes, source.totalBytes);
    while (true) {
      throwIfAborted(signal);
      const { data } = await nativeFiles.readImportChunk({
        token: source.token,
        maxBytes: CHUNK_BYTES,
      });
      throwIfAborted(signal);
      if (data === null) break;
      const chunk = fromBase64(data);
      try {
        if (
          chunk.byteLength === 0 ||
          chunk.byteLength > CHUNK_BYTES ||
          readBytes + chunk.byteLength > source.totalBytes
        ) {
          throw new Error('Native backup source length changed');
        }
        await receive(chunk);
        throwIfAborted(signal);
        readBytes += chunk.byteLength;
        onProgress?.(readBytes, source.totalBytes);
        if (labels) {
          await nativeFiles.updateProtection({
            text: labels.writing,
            processedBytes: readBytes,
            totalBytes: source.totalBytes,
          });
        }
      } finally {
        chunk.fill(0);
      }
    }
    if (readBytes !== source.totalBytes) {
      throw new Error('Native backup source length changed');
    }
    await finishValidation();
  } finally {
    await nativeFiles
      .finishImportSource({ token: source.token })
      .catch(() => {});
    if (labels) await nativeFiles.stopProtection().catch(() => {});
  }
}

export async function startNativeImportProtection(
  labels: NativeBackupLabels
): Promise<void> {
  await nativeFiles.startProtection({
    title: labels.notificationTitle,
    text: labels.preparing,
  });
}

export async function updateNativeImportProtection(
  text: string,
  processedBytes = 0,
  totalBytes = 0
): Promise<void> {
  await nativeFiles.updateProtection({ text, processedBytes, totalBytes });
}

export function stopNativeImportProtection(): Promise<void> {
  return nativeFiles.stopProtection();
}

export function isNativeBackupSelectionCancellation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'CANCELLED'
  );
}

export async function listInterruptedNativeBackups(): Promise<
  NativeBackupDestination[]
> {
  const { outputs } = await nativeFiles.listInterruptedOutputs();
  return outputs;
}

export interface NativeBackupCleanupResult {
  cleaned: boolean;
  remaining: NativeBackupDestination[];
}

export async function cleanupInterruptedNativeBackups(): Promise<NativeBackupCleanupResult> {
  const { outputs } = await nativeFiles.listInterruptedOutputs();
  const remaining: NativeBackupDestination[] = [];
  for (const output of outputs) {
    const result = await nativeFiles
      .deleteOutput({ token: output.token })
      .catch(() => ({ deleted: false }));
    if (!result.deleted) remaining.push(output);
  }
  return { cleaned: remaining.length === 0, remaining };
}

export async function forgetInterruptedNativeBackups(): Promise<void> {
  let outputs: NativeBackupDestination[];
  try {
    ({ outputs } = await nativeFiles.listInterruptedOutputs());
  } catch (error) {
    if (Capacitor.getPlatform() !== 'ios') throw error;
    // This path is reached only from the explicit manual-cleanup Continue
    // action. iOS authorizes reset only while its excluded local journal is
    // unreadable; normal readable journals must forget named tokens instead.
    await nativeFiles.resetRecoveryJournal();
    return;
  }
  for (const output of outputs) {
    await nativeFiles.forgetOutput({ token: output.token });
  }
}

export async function abandonNativeBackupDestination(
  destination: NativeBackupDestination
): Promise<boolean> {
  const { deleted } = await nativeFiles.abandon({ token: destination.token });
  return deleted;
}

export async function exportNativeBackup(
  sdk: GossipSdk,
  destination: NativeBackupDestination,
  labels: NativeBackupLabels,
  onProgress?: (progress: PortableBackupProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const hash = sha256.create();
  let expectedDigest: Uint8Array | null = null;
  let writtenBytes = 0;
  let totalBytes = 0;
  const outputOwned = true;
  let protectionUpdate = Promise.resolve();
  try {
    await nativeFiles.startProtection({
      title: labels.notificationTitle,
      text: labels.preparing,
    });
    await nativeFiles.beginExport({ token: destination.token });
    await sdk.exportPortableV1(
      async source => {
        try {
          throwIfAborted(signal);
          await protectionUpdate;
          if (
            source.byteLength === 0 ||
            source.byteLength > CHUNK_BYTES ||
            writtenBytes + source.byteLength > totalBytes
          ) {
            throw new Error('Native backup output exceeds declared size');
          }
          const encoded = toBase64(source);
          const result = await nativeFiles.writeExportChunk({
            token: destination.token,
            data: encoded,
          });
          throwIfAborted(signal);
          hash.update(source);
          writtenBytes += source.byteLength;
          if (result.writtenBytes !== writtenBytes) {
            throw new Error('Native backup destination length changed');
          }
        } finally {
          source.fill(0);
        }
      },
      progress => {
        if (!validProgress(progress)) {
          throw new Error('Invalid native portable backup progress');
        }
        totalBytes = progress.totalBytes;
        onProgress?.({
          phase: 'writing',
          processedBytes: progress.writtenBytes,
          totalBytes,
        });
        protectionUpdate = protectionUpdate.then(() =>
          nativeFiles.updateProtection({
            text: labels.writing,
            processedBytes: progress.writtenBytes,
            totalBytes,
          })
        );
      },
      signal
    );
    await protectionUpdate;
    if (writtenBytes !== totalBytes) {
      throw new Error('Native backup output length changed');
    }
    const finished = await nativeFiles.finishExport({
      token: destination.token,
    });
    if (finished.writtenBytes !== totalBytes) {
      throw new Error('Native backup committed length changed');
    }
    expectedDigest = hash.digest();

    await nativeFiles.beginVerification({ token: destination.token });
    const verificationHash = sha256.create();
    let verifiedBytes = 0;
    onProgress?.({ phase: 'verifying', processedBytes: 0, totalBytes });
    try {
      while (true) {
        throwIfAborted(signal);
        const { data } = await nativeFiles.readVerificationChunk({
          token: destination.token,
          maxBytes: CHUNK_BYTES,
        });
        throwIfAborted(signal);
        if (data === null) break;
        const chunk = fromBase64(data);
        try {
          verifiedBytes += chunk.byteLength;
          if (verifiedBytes > totalBytes) {
            throw new Error('Native backup verification exceeds output');
          }
          verificationHash.update(chunk);
          onProgress?.({
            phase: 'verifying',
            processedBytes: verifiedBytes,
            totalBytes,
          });
          await nativeFiles.updateProtection({
            text: labels.verifying,
            processedBytes: verifiedBytes,
            totalBytes,
          });
        } finally {
          chunk.fill(0);
        }
      }
      const actualDigest = verificationHash.digest();
      try {
        if (
          verifiedBytes !== totalBytes ||
          !equalBytes(actualDigest, expectedDigest)
        ) {
          throw new Error('Native backup read-back verification failed');
        }
      } finally {
        actualDigest.fill(0);
      }
    } finally {
      verificationHash.destroy();
    }
    await nativeFiles.finishVerification({ token: destination.token });
  } catch (error) {
    const { deleted } = await nativeFiles
      .deleteOutput({ token: destination.token })
      .catch(() => ({ deleted: false }));
    if (!deleted && outputOwned) {
      throw new PortableBackupCleanupRequiredError(
        'The unverified native backup output must be deleted manually',
        error
      );
    }
    throw error;
  } finally {
    await nativeFiles.stopProtection().catch(() => {});
    hash.destroy();
    expectedDigest?.fill(0);
  }
}
