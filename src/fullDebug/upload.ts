/**
 * Sending the record to the backend (full debug build only).
 *
 *   PUT  {base}/{install}/{upload}/piece/{n}                    raw body -> 204
 *   GET  {base}/{install}/{upload}/pieces                       -> {"pieces":[...]}
 *   PUT  {base}/{install}/{upload}/attachment/{name}/piece/{n}  raw body -> 204
 *   GET  {base}/{install}/{upload}/attachment/{name}/pieces     -> {"pieces":[...]}
 *   POST {base}/{install}/{upload}/done
 *        {"pieces","sha256","attachments":[{"name","pieces","sha256"}],"meta"}
 *        -> 200 {"size"}; 409: pieces missing, send them again
 *
 * All with `Authorization: Bearer <secret>`. The log is one gzip stream and
 * each attachment one file, both cut into 512 KiB pieces; a failed send
 * resumes with the same upload id and only the pieces the server lacks.
 */
import type { UploadPrepared, UploadSource } from './writers';

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const ATTACHMENT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/;
export const PIECE = 512 * 1024;
export const MAX_LOG_PIECES = 16384;
export const MAX_ATTACHMENT_PIECES = 4096;
export const MAX_ATTACHMENTS = 8;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: BodyInit }
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

/** One file to attach, read piece by piece (never whole). */
export interface Attachment {
  /** Safe name on the server, see attachmentName. */
  name: string;
  originalName: string;
  type: string;
  size: number;
  pieces: number;
  sha256: string;
  readPiece(n: number): Promise<Uint8Array>;
}

export interface UploadJob {
  install: string;
  upload: string;
  prepared: UploadPrepared;
  meta: Record<string, unknown>;
  attachments: Attachment[];
  /** A send of this job was tried before: ask the server what it holds. */
  started?: boolean;
}

export interface UploadOptions {
  base: string;
  secret: string;
  source: UploadSource;
  fetch?: FetchLike;
  /** Bytes sent so far, of the total (log and attachments). */
  onProgress?: (done: number, total: number) => void;
  /** Attempts per request before the send fails. */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export function randomUploadId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** `https://api.example.com/v2` -> `https://api.example.com/debug-logs` */
export function uploadBase(apiUrl: string | undefined): string | null {
  if (!apiUrl) return null;
  try {
    return `${new URL(apiUrl).origin}/debug-logs`;
  } catch {
    return null;
  }
}

/** `a<index>-<original name, sanitised>`, matching ATTACHMENT_NAME. */
export function attachmentName(index: number, original: string): string {
  const cleaned = original
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^[.]+/, '')
    .slice(-50);
  const name = `a${index}-${cleaned || 'file'}`.slice(0, 64);
  return ATTACHMENT_NAME.test(name) ? name : `a${index}-file`;
}

/** Number of pieces of `size` bytes (an empty file is one empty piece). */
export function pieceCount(size: number): number {
  return Math.max(1, Math.ceil(size / PIECE));
}

function getFetch(o: UploadOptions): FetchLike {
  return o.fetch ?? (globalThis.fetch.bind(globalThis) as unknown as FetchLike);
}

function headers(o: UploadOptions, type?: string): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${o.secret}` };
  if (type) h['Content-Type'] = type;
  return h;
}

async function withRetry<T>(o: UploadOptions, fn: () => Promise<T>): Promise<T> {
  const attempts = o.attempts ?? 4;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      // A refused secret or a too large send does not get better by retrying.
      if (
        error instanceof UploadError &&
        error.status !== undefined &&
        [400, 401, 403, 404, 413].includes(error.status)
      ) {
        throw error;
      }
      if (i + 1 < attempts) await sleep(500 * 2 ** i);
    }
  }
  if (last instanceof Error) throw last;
  throw new UploadError('send failed');
}

/** One stream to send: the log or an attachment. */
interface Stream {
  /** URL prefix: `{base}/{install}/{upload}` or `.../attachment/{name}`. */
  prefix: string;
  pieces: number;
  size: number;
  readPiece(n: number): Promise<Uint8Array>;
  sent: Set<number>;
}

async function serverPieces(o: UploadOptions, s: Stream): Promise<number[]> {
  const res = await getFetch(o)(`${s.prefix}/pieces`, {
    method: 'GET',
    headers: headers(o),
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new UploadError(`pieces: HTTP ${res.status}`, res.status);
  const body = (await res.json()) as { pieces?: unknown };
  return Array.isArray(body.pieces)
    ? body.pieces.filter((n): n is number => Number.isInteger(n))
    : [];
}

function pieceBytes(s: Stream, n: number): number {
  return Math.max(0, Math.min(PIECE, s.size - n * PIECE));
}

async function sendStream(
  o: UploadOptions,
  s: Stream,
  askServer: boolean,
  progress: { done: number; total: number }
): Promise<void> {
  if (askServer) {
    const have = await withRetry(o, () => serverPieces(o, s));
    for (const n of s.sent) progress.done -= pieceBytes(s, n);
    s.sent = new Set(have.filter(n => n >= 0 && n < s.pieces));
    for (const n of s.sent) progress.done += pieceBytes(s, n);
    o.onProgress?.(progress.done, progress.total);
  }
  for (let n = 0; n < s.pieces; n++) {
    if (s.sent.has(n)) continue;
    await withRetry(o, async () => {
      const data = await s.readPiece(n);
      const res = await getFetch(o)(`${s.prefix}/piece/${n}`, {
        method: 'PUT',
        headers: headers(o, 'application/octet-stream'),
        body: data as BodyInit,
      });
      if (!res.ok) {
        throw new UploadError(`piece ${n}: HTTP ${res.status}`, res.status);
      }
    });
    s.sent.add(n);
    progress.done += pieceBytes(s, n);
    o.onProgress?.(progress.done, progress.total);
  }
}

const streams = new WeakMap<UploadJob, Stream[]>();

function jobStreams(o: UploadOptions, job: UploadJob): Stream[] {
  let list = streams.get(job);
  if (list) return list;
  const root = `${o.base}/${encodeURIComponent(job.install)}/${encodeURIComponent(job.upload)}`;
  list = [
    {
      prefix: root,
      pieces: job.prepared.pieces,
      size: job.prepared.size,
      readPiece: n => o.source.readPiece(n),
      sent: new Set(),
    },
    ...job.attachments.map(a => ({
      prefix: `${root}/attachment/${encodeURIComponent(a.name)}`,
      pieces: a.pieces,
      size: a.size,
      readPiece: (n: number) => a.readPiece(n),
      sent: new Set<number>(),
    })),
  ];
  streams.set(job, list);
  return list;
}

/**
 * Sends (or resumes) `job`. Returns the size the server stored. Throws an
 * UploadError when the send fails; calling it again with the same job resumes.
 */
export async function runUpload(
  o: UploadOptions,
  job: UploadJob
): Promise<number> {
  if (!ID_PATTERN.test(job.install) || !ID_PATTERN.test(job.upload)) {
    throw new UploadError('bad install or upload id');
  }
  if (job.prepared.pieces > MAX_LOG_PIECES) {
    throw new UploadError('the log is too large to send', 413);
  }
  for (const a of job.attachments) {
    if (!ATTACHMENT_NAME.test(a.name) || a.pieces > MAX_ATTACHMENT_PIECES) {
      throw new UploadError(`attachment ${a.originalName} cannot be sent`, 413);
    }
  }
  const list = jobStreams(o, job);
  const progress = {
    done: list.reduce(
      (sum, s) => sum + [...s.sent].reduce((x, n) => x + pieceBytes(s, n), 0),
      0
    ),
    total: list.reduce((sum, s) => sum + s.size, 0),
  };
  const resumed = job.started === true;
  job.started = true;
  for (const s of list) await sendStream(o, s, resumed, progress);

  const body = JSON.stringify({
    pieces: job.prepared.pieces,
    sha256: job.prepared.sha256,
    attachments: job.attachments.map(a => ({
      name: a.name,
      pieces: a.pieces,
      sha256: a.sha256,
    })),
    meta: job.meta,
  });
  for (let round = 0; round < 3; round++) {
    const res = await withRetry(o, async () => {
      const r = await getFetch(o)(
        `${o.base}/${encodeURIComponent(job.install)}/${encodeURIComponent(job.upload)}/done`,
        { method: 'POST', headers: headers(o, 'application/json'), body }
      );
      if (r.status >= 500) {
        throw new UploadError(`done: HTTP ${r.status}`, r.status);
      }
      return r;
    });
    if (res.status === 409) {
      // The server lacks pieces: ask each stream what it has, send the rest.
      for (const s of list) await sendStream(o, s, true, progress);
      continue;
    }
    if (!res.ok) throw new UploadError(`done: HTTP ${res.status}`, res.status);
    try {
      const answer = (await res.json()) as { size?: unknown };
      return typeof answer.size === 'number' ? answer.size : job.prepared.size;
    } catch {
      return job.prepared.size;
    }
  }
  throw new UploadError('the server still lacks pieces after 3 rounds', 409);
}
