/**
 * One send of the record, as the dialog drives it: prepare (flush, gzip,
 * cut), read the attached files' hashes, upload, remember what was sent.
 * Self-contained: no account, database, engine or SDK session.
 */
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { fullDebug } from './state';
import {
  randomUploadId,
  runUpload,
  uploadBase,
  type Attachment,
  type UploadJob,
} from './upload';
import { fileAttachment } from './attachments';
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
): Promise<{ upload: string; size: number }> {
  const backend = fullDebug.backend;
  const recorder = fullDebug.recorder;
  if (!backend || !recorder) throw new Error('record not started');
  const config = uploadConfig();
  if (!config) throw new Error('no upload address or secret in this build');

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
      },
    });
    await recorder.flushAll();
    const stats = await backend.stats();
    const prepared = await backend.source.prepare({
      strip: !request.includeSecrets,
      fromLine: request.onlyNew ? lastSentLine() + 1 : 0,
    });
    const total = request.files.reduce((s, f) => s + f.size, 0);
    let before = 0;
    const attachments: Attachment[] = [];
    for (let i = 0; i < request.files.length; i++) {
      const file = request.files[i];
      attachments.push(
        await fileAttachment(i + 1, file, done =>
          onPhase({ phase: 'hashing', done: before + done, total })
        )
      );
      before += file.size;
    }
    job = {
      install: stats.installId,
      upload: randomUploadId(),
      prepared,
      attachments,
      meta: {
        note: request.note,
        includeSecrets: request.includeSecrets,
        onlyNew: request.onlyNew,
        appVersion: APP_VERSION,
        build: APP_BUILD_ID,
        commit: import.meta.env.VITE_APP_BUILD_ID ?? 'unknown',
        platform: Capacitor.getPlatform(),
        userAgent: navigator.userAgent,
        fromLine: prepared.fromLine,
        toLine: prepared.toLine,
        lines: prepared.lines,
        rawBytes: prepared.rawBytes,
        recordBytes: stats.bytes,
        sentAt: new Date().toISOString(),
        attachments: attachments.map(a => ({
          name: a.name,
          originalName: a.originalName,
          type: a.type,
          size: a.size,
        })),
      },
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
  return { upload: job.upload, size };
}

/** The fallback: the gzip of the record through the system share sheet. */
export async function shareRecord(includeSecrets: boolean): Promise<void> {
  const backend = fullDebug.backend;
  const recorder = fullDebug.recorder;
  if (!backend || !recorder) throw new Error('record not started');
  await recorder.flushAll();
  if (!pending) {
    await backend.source.prepare({ strip: !includeSecrets, fromLine: 0 });
  }
  if (backend.kind === 'native') {
    const { uri } = await Filesystem.getUri({
      path: 'debug-upload/upload.gz',
      directory: Directory.Cache,
    });
    await Share.share({
      title: 'Gossip debug logs',
      files: [uri],
      dialogTitle: 'Gossip debug logs',
    });
    return;
  }
  // Web: download the gzip.
  const prepared = await backend.source.prepare({
    strip: !includeSecrets,
    fromLine: 0,
  });
  const parts: BlobPart[] = [];
  for (let n = 0; n < prepared.pieces; n++) {
    parts.push((await backend.source.readPiece(n)) as BlobPart);
  }
  const url = URL.createObjectURL(new Blob(parts, { type: 'application/gzip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `gossip-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl.gz`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
