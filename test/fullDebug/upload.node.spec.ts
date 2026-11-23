import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  attachmentName,
  ATTACHMENT_NAME,
  PIECE,
  pieceCount,
  runUpload,
  type Attachment,
  type FetchLike,
  type UploadJob,
} from '../../src/fullDebug/upload';
import type { UploadSource } from '../../src/fullDebug/writers';

const SECRET = 'test-secret';

/** A fake backend that follows the /debug-logs contract. */
function fakeServer(
  opts: { failPieceOnce?: number; dropOnDone?: number } = {}
) {
  const pieces = new Map<string, Uint8Array>();
  let failed = false;
  let dropped = false;
  const calls: string[] = [];
  const res = (status: number, body?: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (init.headers.Authorization !== `Bearer ${SECRET}`) return res(401);
    const path = new URL(url).pathname;
    const m = /^\/debug-logs\/([\w-]+)\/([\w-]+)\/(.*)$/.exec(path);
    if (!m) return res(404);
    const rest = m[3];
    let p: RegExpExecArray | null;
    if (
      (p = /^(?:attachment\/([\w.-]+)\/)?piece\/(\d+)$/.exec(rest)) &&
      init.method === 'PUT'
    ) {
      const n = Number(p[2]);
      if (!p[1] && n === opts.failPieceOnce && !failed) {
        failed = true;
        return res(503);
      }
      pieces.set(`${p[1] ?? ''}#${n}`, new Uint8Array(init.body as Uint8Array));
      return res(204);
    }
    if (
      (p = /^(?:attachment\/([\w.-]+)\/)?pieces$/.exec(rest)) &&
      init.method === 'GET'
    ) {
      const prefix = `${p[1] ?? ''}#`;
      return res(200, {
        pieces: [...pieces.keys()]
          .filter(k => k.startsWith(prefix))
          .map(k => Number(k.slice(prefix.length))),
      });
    }
    if (rest === 'done' && init.method === 'POST') {
      const body = JSON.parse(init.body as string);
      if (opts.dropOnDone !== undefined && !dropped) {
        dropped = true;
        pieces.delete(`#${opts.dropOnDone}`);
      }
      const join = (prefix: string, count: number) => {
        const parts: Uint8Array[] = [];
        for (let n = 0; n < count; n++) {
          const part = pieces.get(`${prefix}#${n}`);
          if (!part) return null;
          parts.push(part);
        }
        return Buffer.concat(parts);
      };
      const log = join('', body.pieces);
      if (!log) return res(409, { missing: 'log' });
      if (createHash('sha256').update(log).digest('hex') !== body.sha256)
        return res(400);
      for (const a of body.attachments) {
        const data = join(a.name, a.pieces);
        if (!data) return res(409);
        if (createHash('sha256').update(data).digest('hex') !== a.sha256)
          return res(400);
      }
      return res(200, { size: log.length });
    }
    return res(404);
  };
  return { fetch, calls, pieces };
}

function source(data: Uint8Array): UploadSource {
  return {
    prepare: async () => {
      throw new Error('unused');
    },
    readPiece: async n => data.subarray(n * PIECE, (n + 1) * PIECE),
    discard: async () => {},
  };
}

function makeJob(data: Uint8Array, attachments: Attachment[] = []): UploadJob {
  return {
    install: 'inst_1',
    upload: 'up-1',
    prepared: {
      size: data.length,
      pieces: pieceCount(data.length),
      pieceSize: PIECE,
      sha256: createHash('sha256').update(data).digest('hex'),
      fromLine: 1,
      toLine: 10,
      rawBytes: 0,
      lines: 10,
    },
    meta: { note: 'n' },
    attachments,
  };
}

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

const base = 'https://api.test/debug-logs';
const noSleep = async () => {};

describe('debug log upload', () => {
  it('cuts a gzip stream in 512 KiB pieces and sends it with its sha256', async () => {
    const data = new Uint8Array(gzipSync(Buffer.from(bytes(1_300_000))));
    const server = fakeServer();
    const blob = bytes(PIECE + 10, 7);
    const attachment: Attachment = {
      name: attachmentName(1, 'screen shot.png'),
      originalName: 'screen shot.png',
      type: 'image/png',
      size: blob.length,
      pieces: pieceCount(blob.length),
      sha256: createHash('sha256').update(blob).digest('hex'),
      readPiece: async n => blob.subarray(n * PIECE, (n + 1) * PIECE),
    };
    const progress: number[] = [];
    const size = await runUpload(
      {
        base,
        secret: SECRET,
        source: source(data),
        fetch: server.fetch,
        sleep: noSleep,
        onProgress: d => progress.push(d),
      },
      makeJob(data, [attachment])
    );
    expect(size).toBe(data.length);
    expect(
      server.calls.filter(c => c.startsWith('PUT') && !c.includes('attachment'))
        .length
    ).toBe(pieceCount(data.length));
    expect(
      server.calls.filter(c =>
        c.includes('/attachment/a1-screen_shot.png/piece/')
      ).length
    ).toBe(2);
    expect(progress.at(-1)).toBe(data.length + blob.length);
  });

  it('retries a failed piece', async () => {
    const data = bytes(3 * PIECE);
    const server = fakeServer({ failPieceOnce: 1 });
    await runUpload(
      {
        base,
        secret: SECRET,
        source: source(data),
        fetch: server.fetch,
        sleep: noSleep,
      },
      makeJob(data)
    );
    expect(server.calls.filter(c => c.endsWith('/piece/1')).length).toBe(2);
  });

  it('resumes after a failed send with only the missing pieces', async () => {
    const data = bytes(3 * PIECE);
    const server = fakeServer({ failPieceOnce: 2 });
    const job = makeJob(data);
    await expect(
      runUpload(
        {
          base,
          secret: SECRET,
          source: source(data),
          fetch: server.fetch,
          sleep: noSleep,
          attempts: 1,
        },
        job
      )
    ).rejects.toThrow();
    server.calls.length = 0;
    await runUpload(
      {
        base,
        secret: SECRET,
        source: source(data),
        fetch: server.fetch,
        sleep: noSleep,
      },
      job
    );
    expect(server.calls[0]).toContain('GET');
    const puts = server.calls.filter(c => c.startsWith('PUT'));
    expect(puts).toEqual([`PUT ${base}/inst_1/up-1/piece/2`]);
  });

  it('sends the missing pieces again on 409', async () => {
    const data = bytes(2 * PIECE + 5);
    const server = fakeServer({ dropOnDone: 1 });
    const size = await runUpload(
      {
        base,
        secret: SECRET,
        source: source(data),
        fetch: server.fetch,
        sleep: noSleep,
      },
      makeJob(data)
    );
    expect(size).toBe(data.length);
    expect(server.calls.filter(c => c.endsWith('/piece/1')).length).toBe(2);
    expect(server.calls.filter(c => c.endsWith('/done')).length).toBe(2);
  });

  it('does not retry a refused secret', async () => {
    const data = bytes(10);
    const server = fakeServer();
    await expect(
      runUpload(
        {
          base,
          secret: 'wrong',
          source: source(data),
          fetch: server.fetch,
          sleep: noSleep,
        },
        makeJob(data)
      )
    ).rejects.toMatchObject({ status: 401 });
    expect(server.calls.length).toBe(1);
  });

  it('derives safe attachment names', () => {
    for (const n of [
      '../../etc/passwd',
      '.hidden',
      'Capture d’écran 2026.png',
      '',
      'x'.repeat(200),
      '视频.mp4',
    ]) {
      expect(attachmentName(3, n)).toMatch(ATTACHMENT_NAME);
    }
    expect(attachmentName(2, 'clip.mp4')).toBe('a2-clip.mp4');
  });
});
