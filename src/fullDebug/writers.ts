/**
 * Where the record goes: the native DebugLogFile plugin on Android, else an
 * in-memory buffer (web/PWA: no file in this first version).
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { RecordWriter } from './recorder';
import { encryptBytes, GDL1, type Gdl1Recipient } from './gdl1';

/**
 * The prepared log: one gzip stream, encrypted (GDL1, see gdl1.ts). `size`,
 * `pieces` and `sha256` are of the encrypted file, as sent; `plainSize` and
 * `plainSha256` of the gzip stream inside it.
 */
export interface UploadPrepared {
  /** "GDL1": the file is encrypted. Anything else is refused by send.ts. */
  enc: string;
  size: number;
  pieces: number;
  pieceSize: number;
  sha256: string;
  plainSize: number;
  plainSha256: string;
  fromLine: number;
  toLine: number;
  rawBytes: number;
  lines: number;
}

export interface RecordStats {
  installId: string;
  bytes: number;
  segments: number;
  firstLine: number;
  lastLine: number;
  cap: number;
}

export interface DebugLogFilePlugin {
  append(o: { lines: string; urgent?: boolean }): Promise<void>;
  flush(): Promise<void>;
  stats(): Promise<RecordStats>;
  listSegments(): Promise<{ segments: { name: string; size: number }[] }>;
  readSegment(o: {
    name: string;
    offset: number;
    length: number;
  }): Promise<{ data: string; size: number }>;
  setCap(o: { bytes: number }): Promise<void>;
  clear(): Promise<void>;
  setWebInfo(o: Record<string, unknown>): Promise<void>;
  takeNativeErrors(): Promise<{ errors: string[] }>;
  /** `recipientKey`: base64 DER of the public key to encrypt to. */
  prepareUpload(o: {
    strip: boolean;
    fromLine: number;
    recipientKey: string;
  }): Promise<UploadPrepared>;
  readPiece(o: { n: number }): Promise<{ data: string }>;
  discardUpload(): Promise<void>;
}

export interface PrepareOptions {
  strip: boolean;
  fromLine: number;
  recipient: Gdl1Recipient;
}

/** Source of an upload: one encrypted gzip stream, read piece by piece. */
export interface UploadSource {
  prepare(o: PrepareOptions): Promise<UploadPrepared>;
  readPiece(n: number): Promise<Uint8Array>;
  discard(): Promise<void>;
}

export interface RecordBackend {
  kind: 'native' | 'memory';
  writer: RecordWriter;
  stats(): Promise<RecordStats>;
  source: UploadSource;
  setCap(bytes: number): Promise<void>;
  clear(): Promise<void>;
  takeNativeErrors(): Promise<string[]>;
  setWebInfo(info: Record<string, unknown>): Promise<void>;
}

export const PIECE_SIZE = 512 * 1024;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function nativeBackend(): RecordBackend {
  const plugin = registerPlugin<DebugLogFilePlugin>('DebugLogFile');
  return {
    kind: 'native',
    writer: {
      append: (lines, urgent) => plugin.append({ lines, urgent }),
      flush: () => plugin.flush(),
    },
    stats: () => plugin.stats(),
    source: {
      prepare: o =>
        plugin.prepareUpload({
          strip: o.strip,
          fromLine: o.fromLine,
          recipientKey: o.recipient.base64,
        }),
      readPiece: async n => base64ToBytes((await plugin.readPiece({ n })).data),
      discard: () => plugin.discardUpload(),
    },
    setCap: bytes => plugin.setCap({ bytes }),
    clear: () => plugin.clear(),
    takeNativeErrors: async () =>
      (await plugin.takeNativeErrors()).errors ?? [],
    setWebInfo: info => plugin.setWebInfo(info),
  };
}

/** Lines kept in memory on the web (the newest; the oldest are dropped). */
const MEMORY_MAX_BYTES = 32 * 1024 * 1024;

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

const INSTALL_KEY = 'gossip-full-debug-install-id';

export function webInstallId(): string {
  try {
    const existing = localStorage.getItem(INSTALL_KEY);
    if (existing && /^[A-Za-z0-9_-]{1,64}$/.test(existing)) return existing;
    const id = randomId();
    localStorage.setItem(INSTALL_KEY, id);
    return id;
  } catch {
    return 'web-unknown';
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer)
  );
  let s = '';
  for (const b of digest) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * gzip of `text`, encrypted to `recipient`, with both SHA-256, in memory
 * (web only: small).
 */
export async function gzipEncryptAndHash(
  text: string,
  recipient: Gdl1Recipient
): Promise<{
  data: Uint8Array;
  sha256: string;
  plainSize: number;
  plainSha256: string;
}> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());
  const data = await encryptBytes(gz, recipient);
  return {
    data,
    sha256: await sha256Hex(data),
    plainSize: gz.length,
    plainSha256: await sha256Hex(gz),
  };
}

export function memoryBackend(
  stripLine: (line: string) => string
): RecordBackend {
  const lines: string[] = [];
  let bytes = 0;
  let n = 0;
  try {
    n = Number(localStorage.getItem('gossip-full-debug-last-n') ?? '0') || 0;
  } catch {
    // ignore
  }
  let prepared: Uint8Array | null = null;
  const installId = webInstallId();
  const push = (line: string) => {
    n++;
    const numbered =
      line === '{}' ? `{"n":${n}}` : `{"n":${n},${line.slice(1)}`;
    lines.push(numbered);
    bytes += numbered.length + 1;
    while (bytes > MEMORY_MAX_BYTES && lines.length > 1) {
      bytes -= (lines.shift() as string).length + 1;
    }
  };
  push(
    JSON.stringify({
      t: Date.now(),
      up: Math.round(performance.now()),
      src: 'app',
      ev: 'header',
      lvl: 'info',
      f: {
        install: installId,
        platform: Capacitor.getPlatform(),
        userAgent: navigator.userAgent,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        storage: 'memory',
      },
    })
  );
  const lineN = (l: string) => Number(/^\{"n":(\d+)/.exec(l)?.[1] ?? '0');
  return {
    kind: 'memory',
    writer: {
      append: async text => {
        for (const l of text.split('\n')) if (l.trim()) push(l.trim());
        try {
          localStorage.setItem('gossip-full-debug-last-n', String(n));
        } catch {
          // ignore
        }
      },
      flush: async () => {},
    },
    stats: async () => ({
      installId,
      bytes,
      segments: 1,
      firstLine: lines.length ? lineN(lines[0]) : 0,
      lastLine: n,
      cap: MEMORY_MAX_BYTES,
    }),
    source: {
      prepare: async ({ strip, fromLine, recipient }) => {
        const picked = lines.filter((l, i) => i === 0 || lineN(l) >= fromLine);
        const text =
          picked.map(l => (strip ? stripLine(l) : l)).join('\n') + '\n';
        const { data, sha256, plainSize, plainSha256 } =
          await gzipEncryptAndHash(text, recipient);
        prepared = data;
        return {
          enc: GDL1,
          size: data.length,
          pieces: Math.ceil(data.length / PIECE_SIZE),
          pieceSize: PIECE_SIZE,
          sha256,
          plainSize,
          plainSha256,
          fromLine: picked.length ? lineN(picked[0]) : 0,
          toLine: n,
          rawBytes: text.length,
          lines: picked.length,
        };
      },
      readPiece: async i => {
        if (!prepared) throw new Error('nothing prepared');
        return prepared.subarray(i * PIECE_SIZE, (i + 1) * PIECE_SIZE);
      },
      discard: async () => {
        prepared = null;
      },
    },
    setCap: async () => {},
    clear: async () => {
      lines.length = 0;
      bytes = 0;
    },
    takeNativeErrors: async () => [],
    setWebInfo: async () => {},
  };
}

export function createBackend(
  stripLine: (line: string) => string
): RecordBackend {
  // Android and iOS carry the same DebugLogFile plugin; the web keeps the
  // record in memory.
  return Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable('DebugLogFile')
    ? nativeBackend()
    : memoryBackend(stripLine);
}
