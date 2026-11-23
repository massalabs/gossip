import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createSealer,
  encryptBytes,
  gdl1Size,
  GDL1_CHUNK,
  importRecipient,
  type Gdl1TestOverride,
} from '../../src/fullDebug/gdl1';
import { encryptedFile, fileAttachment } from '../../src/fullDebug/attachments';
import { PIECE } from '../../src/fullDebug/upload';
import { memoryBackend } from '../../src/fullDebug/writers';
// @ts-expect-error — plain .mjs script without types
import { decryptGdl1 } from '../../scripts/debug-logs-decrypt.mjs';

const root = resolve(__dirname, '../..');
const fixtures = join(root, 'test/fixtures/gdl1');
const SCRIPT = join(root, 'scripts/debug-logs-decrypt.mjs');

interface Vectors {
  recipientSpkiB64: string;
  recipientPoint: string;
  keyFp: string;
  ephemeralD: string;
  ephemeralPoint: string;
  noncePrefix: string;
  header: string;
  cases: {
    size: number;
    plainSha256: string;
    ciphertextSize: number;
    sha256: string;
    hex?: string;
    tailHex: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(join(fixtures, 'vectors.json'), 'utf8')
) as Vectors;
const TEST_PRIVATE_PEM = readFileSync(
  join(fixtures, 'TEST-ONLY-recipient-private.pem'),
  'utf8'
);
const testPrivate = createPrivateKey(TEST_PRIVATE_PEM);

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));
const override: Gdl1TestOverride = {
  ephemeralD: fromHex(vectors.ephemeralD),
  ephemeralPoint: fromHex(vectors.ephemeralPoint),
  noncePrefix: fromHex(vectors.noncePrefix),
};

function plaintext(size: number): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

async function decrypt(
  data: Uint8Array,
  key = testPrivate,
  pieceSize = 7777
): Promise<Buffer> {
  async function* pieces() {
    for (let i = 0; i < data.length; i += pieceSize) {
      yield Buffer.from(data.subarray(i, i + pieceSize));
    }
    if (data.length === 0) yield Buffer.alloc(0);
  }
  const out: Buffer[] = [];
  for await (const p of decryptGdl1(pieces(), key)) out.push(p as Buffer);
  return Buffer.concat(out);
}

const tmp = mkdtempSync(join(tmpdir(), 'gdl1-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('GDL1 (WebCrypto) against the reference vectors', async () => {
  const recipient = await importRecipient(vectors.recipientSpkiB64);

  it('reads the recipient key and its fingerprint', () => {
    expect(hex(recipient.point)).toBe(vectors.recipientPoint);
    expect(recipient.fingerprint).toBe(vectors.keyFp);
  });

  it('writes the vector header', async () => {
    const sealer = await createSealer(recipient, override);
    expect(hex(sealer.header)).toBe(vectors.header);
  });

  for (const c of vectors.cases) {
    it(`encrypts ${c.size} bytes exactly as the vectors`, async () => {
      const plain = plaintext(c.size);
      expect(sha(plain)).toBe(c.plainSha256);
      const ct = await encryptBytes(plain, recipient, override);
      expect(ct.length).toBe(c.ciphertextSize);
      expect(gdl1Size(c.size)).toBe(c.ciphertextSize);
      expect(sha(ct)).toBe(c.sha256);
      if (c.hex) expect(hex(ct)).toBe(c.hex);
      expect(hex(ct.subarray(ct.length - 48))).toBe(c.tailHex.slice(-96));
    });

    it(`encrypts an attachment of ${c.size} bytes by ranges as the vectors`, async () => {
      const enc = await encryptedFile(
        new Blob([plaintext(c.size)]),
        recipient,
        override
      );
      expect(await enc.hashAll()).toBe(c.sha256);
      // Odd ranges that cut the header and the chunks anywhere.
      const parts: Uint8Array[] = [];
      for (
        let at = 0, step = 1;
        at < enc.size;
        at += step, step = step * 3 + 5
      ) {
        parts.push(await enc.read(at, at + step));
      }
      const whole = Buffer.concat(parts);
      expect(whole.length).toBe(c.ciphertextSize);
      expect(sha(whole)).toBe(c.sha256);
    });
  }
});

describe('GDL1 round trip through the decrypt script', async () => {
  const recipient = await importRecipient(vectors.recipientSpkiB64);

  for (const size of [0, 1, 65535, 65536, 65537, 3 * GDL1_CHUNK, 200000]) {
    it(`decrypts ${size} bytes with a fresh ephemeral key`, async () => {
      const plain = plaintext(size);
      const a = await encryptBytes(plain, recipient);
      const b = await encryptBytes(plain, recipient);
      // a fresh ephemeral key and nonce prefix for every file
      expect(hex(a.subarray(4, 73))).not.toBe(hex(b.subarray(4, 73)));
      expect(hex(await decrypt(a))).toBe(hex(plain));
    });
  }

  it('sends an attachment piece by piece that decrypts to the file', async () => {
    const plain = new Uint8Array(PIECE * 2 + 12345);
    crypto.getRandomValues(plain.subarray(0, 65536));
    const file = new File([plain], 'clip.mp4', { type: 'video/mp4' });
    const a = await fileAttachment(1, file, recipient);
    expect(a.plainSize).toBe(plain.length);
    expect(a.size).toBe(gdl1Size(plain.length));
    const pieces: Uint8Array[] = [];
    for (let n = 0; n < a.pieces; n++) pieces.push(await a.readPiece(n));
    const sent = Buffer.concat(pieces);
    expect(sha(sent)).toBe(a.sha256);
    expect(sent.subarray(0, 4).toString()).toBe('GDL1');
    expect(hex(await decrypt(sent))).toBe(hex(plain));
  });

  it('stops when an attached file changes after it was hashed', async () => {
    let version = 0;
    const data = [plaintext(100_000), plaintext(100_000).map(b => b ^ 1)];
    const blob = {
      size: 100_000,
      slice: (s: number, e: number) => new Blob([data[version].slice(s, e)]),
    } as unknown as Blob;
    const enc = await encryptedFile(blob, recipient);
    await enc.hashAll();
    version = 1;
    await expect(enc.read(0, PIECE)).rejects.toThrow(/changed/);
  });

  it('the web log: gzip, encrypted, decrypts to the lines', async () => {
    const backend = memoryBackend(l => l);
    await backend.writer.append(
      '{"src":"app","ev":"x","f":{"c":{"m":"hi"}}}',
      false
    );
    const p = await backend.source.prepare({
      strip: false,
      fromLine: 0,
      recipient,
    });
    expect(p.enc).toBe('GDL1');
    const parts: Uint8Array[] = [];
    for (let n = 0; n < p.pieces; n++)
      parts.push(await backend.source.readPiece(n));
    const sent = Buffer.concat(parts);
    expect(sent.length).toBe(p.size);
    expect(sha(sent)).toBe(p.sha256);
    const gz = await decrypt(sent);
    expect(gz.length).toBe(p.plainSize);
    expect(sha(gz)).toBe(p.plainSha256);
    const text = gunzipSync(gz).toString('utf8');
    expect(text).toContain('"ev":"x"');
    expect(sent.includes(Buffer.from('"ev":"x"'))).toBe(false);
  });

  it('the CLI decrypts and gunzips, with the key from a file, env or stdin', async () => {
    const lines = Buffer.from(
      '{"n":1,"ev":"a"}\n{"n":2,"ev":"b"}\n'.repeat(5000)
    );
    const ct = await encryptBytes(new Uint8Array(gzipSync(lines)), recipient);
    const input = join(tmp, 'in.gdl1');
    writeFileSync(input, ct);
    const keyFile = join(tmp, 'k.pem');
    writeFileSync(keyFile, TEST_PRIVATE_PEM);
    const env = { ...process.env, DEBUG_LOGS_PRIVATE_KEY: '' };

    execFileSync(
      'node',
      [SCRIPT, '--gunzip', '--key-file', keyFile, input, join(tmp, 'o1')],
      { env, stdio: 'pipe' }
    );
    expect(readFileSync(join(tmp, 'o1')).equals(lines)).toBe(true);

    execFileSync('node', [SCRIPT, '--gunzip', input, join(tmp, 'o2')], {
      env: { ...env, DEBUG_LOGS_PRIVATE_KEY: TEST_PRIVATE_PEM },
      stdio: 'pipe',
    });
    expect(readFileSync(join(tmp, 'o2')).equals(lines)).toBe(true);

    execFileSync('node', [SCRIPT, input, join(tmp, 'o3')], {
      env,
      input: TEST_PRIVATE_PEM,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(gunzipSync(readFileSync(join(tmp, 'o3'))).equals(lines)).toBe(true);
  });
});

describe('GDL1 refuses damaged files', async () => {
  const recipient = await importRecipient(vectors.recipientSpkiB64);
  const plain = plaintext(3 * GDL1_CHUNK + 1000);
  const ct = Buffer.from(await encryptBytes(plain, recipient));
  const RECORD = GDL1_CHUNK + 20;
  const chunkAt = (i: number) => 73 + i * RECORD;

  const bad: [string, Buffer][] = [
    ['cut inside the header', ct.subarray(0, 50)],
    ['header only', ct.subarray(0, 73)],
    ['cut inside a chunk', ct.subarray(0, chunkAt(1) + 100)],
    [
      'cut at a chunk boundary (last chunk dropped)',
      ct.subarray(0, chunkAt(3)),
    ],
    ['cut after the first chunk', ct.subarray(0, chunkAt(1))],
    [
      'a flipped bit in a ciphertext',
      (() => {
        const b = Buffer.from(ct);
        b[chunkAt(2) + 4 + 10] ^= 0x01;
        return b;
      })(),
    ],
    [
      'a flipped bit in a tag',
      (() => {
        const b = Buffer.from(ct);
        b[b.length - 1] ^= 0x80;
        return b;
      })(),
    ],
    [
      'a flipped bit in the ephemeral key',
      (() => {
        const b = Buffer.from(ct);
        b[30] ^= 0x01;
        return b;
      })(),
    ],
    [
      'a flipped bit in the nonce prefix',
      (() => {
        const b = Buffer.from(ct);
        b[70] ^= 0x01;
        return b;
      })(),
    ],
    [
      'two chunks swapped',
      Buffer.concat([
        ct.subarray(0, chunkAt(0)),
        ct.subarray(chunkAt(1), chunkAt(2)),
        ct.subarray(chunkAt(0), chunkAt(1)),
        ct.subarray(chunkAt(2)),
      ]),
    ],
    [
      'a chunk repeated',
      Buffer.concat([
        ct.subarray(0, chunkAt(2)),
        ct.subarray(chunkAt(1), chunkAt(2)),
        ct.subarray(chunkAt(2)),
      ]),
    ],
    [
      'bytes after the last chunk',
      Buffer.concat([ct, Buffer.from([0, 0, 0, 16])]),
    ],
    ['a wrong magic', Buffer.concat([Buffer.from('GDL2'), ct.subarray(4)])],
  ];

  it('decrypts the intact file', async () => {
    expect((await decrypt(ct)).equals(Buffer.from(plain))).toBe(true);
  });

  for (const [what, data] of bad) {
    it(`fails on ${what}`, async () => {
      await expect(decrypt(data)).rejects.toThrow();
    });
  }

  it('fails with the wrong private key', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    await expect(decrypt(ct, other)).rejects.toThrow(/wrong private key/);
  });

  it('the CLI fails loudly and leaves no output on a truncated file', () => {
    const input = join(tmp, 'cut.gdl1');
    writeFileSync(input, ct.subarray(0, chunkAt(3)));
    const out = join(tmp, 'cut.out');
    const r = spawnSync('node', [SCRIPT, input, out], {
      env: { ...process.env, DEBUG_LOGS_PRIVATE_KEY: TEST_PRIVATE_PEM },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DECRYPTION FAILED/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.part`)).toBe(false);
  });
});

describe('the built-in key', () => {
  it('is required', async () => {
    await expect(importRecipient(undefined)).rejects.toThrow(/no key/);
    await expect(importRecipient('')).rejects.toThrow(/no key/);
  });
  it('must be a P-256 public key', async () => {
    await expect(importRecipient('bm90IGEga2V5')).rejects.toThrow(/P-256/);
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' })
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64');
    await expect(importRecipient(p384)).rejects.toThrow(/P-256/);
  });
});
