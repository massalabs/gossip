/**
 * One send of the record, as the dialog drives it: prepare (flush, gzip,
 * encrypt, cut), encrypt and hash the attached files, upload, remember what
 * was sent. Self-contained: no account, database, engine or SDK session.
 *
 * Everything that leaves the phone, by upload or through "share the file
 * instead", is encrypted to the developers' public key built in with
 * VITE_DEBUG_LOGS_PUBLIC_KEY (GDL1, see gdl1.ts). Without a valid key
 * nothing is sent: there is no plaintext fallback.
 */
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { fullDebug } from './state';
import {
  randomUploadId,
  runUpload,
  uploadBase,
  MAX_USER_FILES,
  type Attachment,
  type UploadJob,
} from './upload';
import { fileAttachment } from './attachments';
import {
  attachmentName,
  privateDoc,
  publicMeta,
  PRIVATE_DOC_NAME,
} from './private';
import { GDL1, importRecipient, type Gdl1Recipient } from './gdl1';
import { rememberSend, uploadRef } from './sentRefs';
import type { UploadPrepared } from './writers';
import { APP_BUILD_ID, APP_VERSION } from '../config/version';

const LAST_SENT_KEY = 'gossip-full-debug-last-sent-line';

export function lastSentLine(): number {
  try {
    return Number(localStorage.getItem(LAST_SENT_KEY) ?? '0') || 0;
  } catch {
    return 0;
  }
}

export function uploadConfig(): { base: string; secret: string } | null {
  const base = uploadBase(import.meta.env.VITE_GOSSIP_API_URL);
  const secret = import.meta.env.VITE_DEBUG_LOGS_UPLOAD_SECRET;
  if (!base || !secret) return null;
  return { base, secret };
}

/** The built-in public key; rejects when it is missing or invalid. */
export function debugLogsRecipient(): Promise<Gdl1Recipient> {
  return importRecipient(import.meta.env.VITE_DEBUG_LOGS_PUBLIC_KEY);
}

/** Refuses a prepared log that is not encrypted (an outdated native plugin). */
function checkEncrypted(prepared: UploadPrepared): void {
  if (prepared.enc !== GDL1) {
    throw new Error(
      'the log was not encrypted by this build: nothing was sent'
    );
  }
}

export interface SendRequest {
  note: string;
  includeSecrets: boolean;
  onlyNew: boolean;
  files: File[];
}

export type SendPhase =
  | { phase: 'preparing' }
  | { phase: 'hashing'; done: number; total: number }
  | { phase: 'sending'; done: number; total: number };

/** The job of the last failed send, resumed by "Try again". */
let pending: { request: SendRequest; job: UploadJob } | null = null;

function sameRequest(a: SendRequest, b: SendRequest): boolean {
  return (
    a.note === b.note &&
    a.includeSecrets === b.includeSecrets &&
    a.onlyNew === b.onlyNew &&
    a.files.length === b.files.length &&
    a.files.every((f, i) => f === b.files[i])
  );
}

export async function sendRecord(
  request: SendRequest,
  onPhase: (p: SendPhase) => void
): Promise<{ upload: string; size: number; ref: string }> {
  const backend = fullDebug.backend;
  const recorder = fullDebug.recorder;
  if (!backend || !recorder) throw new Error('record not started');
  const config = uploadConfig();
  if (!config) throw new Error('no upload address or secret in this build');
  const recipient = await debugLogsRecipient();

  let job: UploadJob;
  if (pending && sameRequest(pending.request, request)) {
    job = pending.job;
  } else {
    onPhase({ phase: 'preparing' });
    recorder.record({
      src: 'app',
      ev: 'fulldebug.send',
      lvl: 'info',
      f: {
        includeSecrets: request.includeSecrets,
        onlyNew: request.onlyNew,
        files: request.files.length,
        keyFp: recipient.fingerprint,
      },
    });
    await recorder.flushAll();
    const stats = await backend.stats();
    const prepared = await backend.source.prepare({
      strip: !request.includeSecrets,
      fromLine: request.onlyNew ? lastSentLine() + 1 : 0,
      recipient,
    });
    checkEncrypted(prepared);
    if (request.files.length > MAX_USER_FILES) {
      throw new Error(`at most ${MAX_USER_FILES} files per send`);
    }
    const total = request.files.reduce((s, f) => s + f.size, 0);
    let before = 0;
    const files: Attachment[] = [];
    for (let i = 0; i < request.files.length; i++) {
      const file = request.files[i];
      files.push(
        await fileAttachment(attachmentName(i + 1), file, recipient, done =>
          onPhase({ phase: 'hashing', done: before + done, total })
        )
      );
      before += file.size;
    }
    // The note, the files' names and types and the user agent: encrypted,
    // as the attachment m0 (private.ts).
    const doc = privateDoc({
      note: request.note,
      files: request.files.map((file, i) => ({ name: files[i].name, file })),
      userAgent: navigator.userAgent,
      gzipSha256: prepared.plainSha256,
    });
    const docFile = new Blob([JSON.stringify(doc)], {
      type: 'application/json',
    });
    const attachments = [
      await fileAttachment(PRIVATE_DOC_NAME, docFile, recipient),
      ...files,
    ];
    job = {
      install: stats.installId,
      upload: randomUploadId(),
      prepared,
      attachments,
      // Readable on the backend: only what finds and decrypts an upload. The
      // log and every attachment are GDL1 files encrypted to the key whose
      // DER has the SHA-256 keyFp.
      meta: publicMeta({
        enc: GDL1,
        keyFp: recipient.fingerprint,
        appVersion: APP_VERSION,
        commit: import.meta.env.VITE_APP_BUILD_ID ?? APP_BUILD_ID,
        platform: Capacitor.getPlatform(),
        includeSecrets: request.includeSecrets,
        onlyNew: request.onlyNew,
        fromLine: prepared.fromLine,
        toLine: prepared.toLine,
        lines: prepared.lines,
        rawBytes: prepared.rawBytes,
        recordBytes: stats.bytes,
        gzipSize: prepared.plainSize,
        sentAt: new Date().toISOString(),
      }),
    };
    pending = { request, job };
  }

  const size = await runUpload(
    {
      base: config.base,
      secret: config.secret,
      source: backend.source,
      onProgress: (done, total) => onPhase({ phase: 'sending', done, total }),
    },
    job
  );
  pending = null;
  try {
    localStorage.setItem(LAST_SENT_KEY, String(job.prepared.toLine));
  } catch {
    // ignore
  }
  recorder.record({
    src: 'app',
    ev: 'fulldebug.sent',
    lvl: 'info',
    f: { upload: job.upload, size, toLine: job.prepared.toLine },
  });
  void backend.source.discard().catch(() => {});
  const ref = uploadRef(job.install, job.upload);
  rememberSend(ref);
  return { upload: job.upload, size, ref };
}

/** `gossip-debug-log-<install>-<UTC time>.gdl1` */
export function shareFileName(install: string, at: Date): string {
  const time = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `gossip-debug-log-${install}-${time}.gdl1`;
}

const SHARE_DIR = 'debug-share';

/**
 * The fallback: the encrypted log (the same GDL1 file as an upload, never a
 * plaintext export) through the system share sheet, or a download on the
 * web. Decrypt with scripts/debug-logs-decrypt.mjs --gunzip.
 */
export async function shareRecord(includeSecrets: boolean): Promise<void> {
  const backend = fullDebug.backend;
  const recorder = fullDebug.recorder;
  if (!backend || !recorder) throw new Error('record not started');
  const recipient = await debugLogsRecipient();
  await recorder.flushAll();
  const install = (await backend.stats()).installId;
  const name = shareFileName(install, new Date());
  if (backend.kind === 'native') {
    let prepared = pending?.job.prepared;
    if (!prepared) {
      prepared = await backend.source.prepare({
        strip: !includeSecrets,
        fromLine: 0,
        recipient,
      });
    }
    checkEncrypted(prepared);
    // Shared under its own name; the previous shared copy is removed.
    await Filesystem.rmdir({
      path: SHARE_DIR,
      directory: Directory.Cache,
      recursive: true,
    }).catch(() => {});
    await Filesystem.mkdir({
      path: SHARE_DIR,
      directory: Directory.Cache,
      recursive: true,
    }).catch(() => {});
    await Filesystem.copy({
      from: 'debug-upload/upload.gdl1',
      directory: Directory.Cache,
      to: `${SHARE_DIR}/${name}`,
      toDirectory: Directory.Cache,
    });
    const { uri } = await Filesystem.getUri({
      path: `${SHARE_DIR}/${name}`,
      directory: Directory.Cache,
    });
    await Share.share({
      title: 'Gossip debug logs (encrypted)',
      files: [uri],
      dialogTitle: 'Gossip debug logs (encrypted)',
    });
    return;
  }
  // Web: download the encrypted file.
  const prepared = await backend.source.prepare({
    strip: !includeSecrets,
    fromLine: 0,
    recipient,
  });
  checkEncrypted(prepared);
  const parts: BlobPart[] = [];
  for (let n = 0; n < prepared.pieces; n++) {
    parts.push((await backend.source.readPiece(n)) as BlobPart);
  }
  const url = URL.createObjectURL(
    new Blob(parts, { type: 'application/octet-stream' })
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
