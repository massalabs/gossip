/**
 * What of a send may travel readable, and what may not.
 *
 * Nothing the tester types or picks, and nothing that identifies the device
 * beyond the platform, is readable on the backend: the note, the original
 * names, types and sizes of the attached files, the user agent and the hash
 * of the log's gzip stream go into one small JSON document, encrypted like
 * any attachment (GDL1) and sent as the attachment `m0`. The attached files
 * travel under the opaque names `a1`, `a2`, …. The `done` call's `meta` keeps
 * only what is needed to find and decrypt an upload.
 */

/** The attachment that carries the private document. */
export const PRIVATE_DOC_NAME = 'm0';

/** Opaque server-side name of the attached file number `index` (from 1). */
export function attachmentName(index: number): string {
  return `a${index}`;
}

export interface PrivateFile {
  /** `a1`, `a2`, … as stored. */
  name: string;
  originalName: string;
  mime: string;
  size: number;
}

export interface PrivateDoc {
  v: 1;
  note: string;
  attachments: PrivateFile[];
  userAgent: string;
  /** SHA-256 of the log's gzip stream, to check a decryption. */
  gzipSha256: string;
}

export function privateDoc(o: {
  note: string;
  files: { name: string; file: { name: string; type: string; size: number } }[];
  userAgent: string;
  gzipSha256: string;
}): PrivateDoc {
  return {
    v: 1,
    note: o.note,
    attachments: o.files.map(({ name, file }) => ({
      name,
      originalName: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
    })),
    userAgent: o.userAgent,
    gzipSha256: o.gzipSha256,
  };
}

/** The readable `meta` of `done`: nothing typed, picked or device-specific. */
export function publicMeta(o: {
  enc: string;
  keyFp: string;
  appVersion: string;
  commit: string;
  platform: string;
  includeSecrets: boolean;
  onlyNew: boolean;
  fromLine: number;
  toLine: number;
  lines: number;
  rawBytes: number;
  recordBytes: number;
  gzipSize: number;
  sentAt: string;
}): Record<string, unknown> {
  return {
    enc: o.enc,
    keyFp: o.keyFp,
    appVersion: o.appVersion,
    commit: o.commit,
    platform: o.platform,
    includeSecrets: o.includeSecrets,
    onlyNew: o.onlyNew,
    fromLine: o.fromLine,
    toLine: o.toLine,
    lines: o.lines,
    rawBytes: o.rawBytes,
    recordBytes: o.recordBytes,
    gzipSize: o.gzipSize,
    sentAt: o.sentAt,
  };
}
