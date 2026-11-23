#!/usr/bin/env node
// Decrypts a debug-log upload of the full debug build (format GDL1), and is
// the reference implementation of that format: the app's three encryptors
// (src/fullDebug/gdl1.ts, Gdl1.kt, DebugLogFilePlugin.swift) are checked
// against vectors made with `encryptGdl1` below (test/fixtures/gdl1/).
//
//   node scripts/debug-logs-decrypt.mjs [--gunzip] [--key-file <pem>] <in.gdl1> <out>
//
// The private key (PEM, P-256) comes from the env variable
// DEBUG_LOGS_PRIVATE_KEY, or from the file given with --key-file, or, when
// neither is given, from stdin until EOF. It is never written anywhere.
// The output is written to `<out>.part` and renamed only once every chunk is
// authenticated and the end of the stream is seen; on any failure the partial
// output is deleted and the exit status is 1.
//
// Format GDL1 (docs/PRIVACY-CHECKS.md):
//   header  "GDL1" | ephemeral P-256 public key, uncompressed (65) | nonce prefix (4)
//   key     HKDF-SHA256(ikm = ECDH x coordinate,
//                       salt = ephemeral public (65) | recipient public (65),
//                       info = "gossip-debug-logs v1", 32 bytes)
//   chunks  plaintext cut in 65536-byte chunks (the last may be shorter;
//           empty only when the whole plaintext is), each
//           u32 BE length | AES-256-GCM(ciphertext | 16-byte tag), with
//           nonce = prefix | u64 BE index, AAD = 0x01 for the last chunk,
//           0x00 otherwise.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const MAGIC = Buffer.from('GDL1', 'ascii');
export const CHUNK = 65536;
export const TAG = 16;
export const POINT = 65;
export const PREFIX = 4;
export const HEADER = MAGIC.length + POINT + PREFIX;
export const INFO = Buffer.from('gossip-debug-logs v1', 'ascii');

const b64url = buf => Buffer.from(buf).toString('base64url');

/** 0x04 | X | Y of a P-256 KeyObject (public or private). */
export function uncompressedPoint(key) {
  const jwk = (key.type === 'private' ? createPublicKey(key) : key).export({
    format: 'jwk',
  });
  if (jwk.crv !== 'P-256') throw new Error('the key is not a P-256 key');
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

/** P-256 public KeyObject of an uncompressed point. */
export function publicKeyFromPoint(point) {
  if (point.length !== POINT || point[0] !== 4) {
    throw new Error('bad ephemeral public key');
  }
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

/** P-256 private KeyObject of a raw scalar `d` (32 bytes) and its point. */
export function privateKeyFromScalar(d, point) {
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64url(d),
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

/** Hex SHA-256 of the recipient key's DER (SubjectPublicKeyInfo). */
export function keyFingerprint(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/**
 * The AES key of a file: ECDH of `privateKey` with `peerPublic` (the
 * recipient's public key when encrypting, the ephemeral one when
 * decrypting), salted with both points in the fixed order.
 */
export function deriveKey(
  privateKey,
  peerPublic,
  ephemeralPoint,
  recipientPoint
) {
  const shared = diffieHellman({ privateKey, publicKey: peerPublic });
  const salt = Buffer.concat([ephemeralPoint, recipientPoint]);
  return {
    shared,
    key: Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32)),
  };
}

export function nonce(prefix, index) {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeBigUInt64BE(BigInt(index), 4);
  return n;
}

/**
 * Encrypts `plain` (a Buffer) for `recipientPublic` (KeyObject). Tests pass
 * `ephemeral` ({ d, point }) and `noncePrefix`; the app never does.
 */
export function encryptGdl1(plain, recipientPublic, opts = {}) {
  let ephemeralPrivate;
  let point;
  if (opts.ephemeral) {
    point = Buffer.from(opts.ephemeral.point);
    ephemeralPrivate = privateKeyFromScalar(
      Buffer.from(opts.ephemeral.d),
      point
    );
  } else {
    ephemeralPrivate = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    }).privateKey;
    point = uncompressedPoint(ephemeralPrivate);
  }
  const prefix = Buffer.from(opts.noncePrefix ?? randomBytes(PREFIX));
  const { key } = deriveKey(
    ephemeralPrivate,
    recipientPublic,
    point,
    uncompressedPoint(recipientPublic)
  );
  const parts = [MAGIC, point, prefix];
  const count = Math.max(1, Math.ceil(plain.length / CHUNK));
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    const c = createCipheriv('aes-256-gcm', key, nonce(prefix, i), {
      authTagLength: TAG,
    });
    c.setAAD(Buffer.from([last ? 1 : 0]));
    const body = Buffer.concat([
      c.update(plain.subarray(i * CHUNK, (i + 1) * CHUNK)),
      c.final(),
      c.getAuthTag(),
    ]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    parts.push(len, body);
  }
  return Buffer.concat(parts);
}

export class Gdl1Error extends Error {}

/**
 * Async generator: decrypts the GDL1 byte stream `input` (async iterable of
 * Buffers) with `privateKey` (KeyObject), yielding authenticated plaintext
 * chunks. Throws Gdl1Error on any bad header, tag, order, truncation or
 * trailing byte.
 */
export async function* decryptGdl1(input, privateKey) {
  let buf = Buffer.alloc(0);
  let key = null;
  let prefix = null;
  let index = 0;
  let held = null; // the last complete chunk, decrypted once we know if more follows
  const recipientPoint = uncompressedPoint(privateKey);

  const open = (body, last) => {
    const d = createDecipheriv('aes-256-gcm', key, nonce(prefix, index), {
      authTagLength: TAG,
    });
    d.setAAD(Buffer.from([last ? 1 : 0]));
    d.setAuthTag(body.subarray(body.length - TAG));
    try {
      const out = Buffer.concat([
        d.update(body.subarray(0, body.length - TAG)),
        d.final(),
      ]);
      index++;
      return out;
    } catch {
      if (index === 0 && !last) {
        throw new Gdl1Error(
          'chunk 0 does not authenticate: wrong private key, or the file is damaged'
        );
      }
      throw new Gdl1Error(
        last
          ? `chunk ${index} does not authenticate as the last one: the file is truncated or damaged (or the key is wrong)`
          : `chunk ${index} does not authenticate: the file is damaged or its chunks are out of order`
      );
    }
  };

  for await (const piece of input) {
    buf = buf.length ? Buffer.concat([buf, piece]) : Buffer.from(piece);
    if (!key) {
      if (buf.length < HEADER) continue;
      if (!buf.subarray(0, 4).equals(MAGIC)) {
        throw new Gdl1Error('not a GDL1 file (bad magic)');
      }
      const point = buf.subarray(4, 4 + POINT);
      prefix = Buffer.from(buf.subarray(4 + POINT, HEADER));
      let ephemeralPublic;
      try {
        ephemeralPublic = publicKeyFromPoint(point);
      } catch {
        throw new Gdl1Error('bad ephemeral public key in the header');
      }
      key = deriveKey(
        privateKey,
        ephemeralPublic,
        Buffer.from(point),
        recipientPoint
      ).key;
      buf = buf.subarray(HEADER);
    }
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len < TAG || len > CHUNK + TAG) {
        throw new Gdl1Error(
          `chunk ${index + (held ? 1 : 0)}: bad length ${len}`
        );
      }
      if (buf.length < 4 + len) break;
      if (held) {
        // More follows the held chunk: it is not the last one.
        if (held.length !== CHUNK + TAG) {
          throw new Gdl1Error(`chunk ${index}: short chunk before the end`);
        }
        yield open(held, false);
      }
      held = Buffer.from(buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
    }
  }
  if (!key) throw new Gdl1Error('truncated: no complete header');
  if (buf.length > 0) throw new Gdl1Error('truncated: a chunk is cut short');
  if (!held) throw new Gdl1Error('truncated: no chunk');
  const out = open(held, true);
  if (out.length === 0 && index !== 1) {
    throw new Gdl1Error('empty last chunk after other chunks');
  }
  yield out;
}

/** PEM or base64 DER (PKCS#8 or SEC1) of a P-256 private key. */
export function parsePrivateKey(text) {
  const t = text.trim();
  let key;
  try {
    key = t.includes('-----BEGIN')
      ? createPrivateKey(t)
      : createPrivateKey({
          key: Buffer.from(t, 'base64'),
          format: 'der',
          type: 'pkcs8',
        });
  } catch {
    throw new Gdl1Error('the private key cannot be read (PEM, P-256 expected)');
  }
  if (
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new Gdl1Error('the private key is not a P-256 key');
  }
  return key;
}

async function readStdin() {
  const parts = [];
  for await (const p of process.stdin) parts.push(p);
  return Buffer.concat(parts).toString('utf8');
}

function usage(message) {
  process.stderr.write(
    (message ? `${message}\n\n` : '') +
      'usage: node scripts/debug-logs-decrypt.mjs [--gunzip] [--key-file <private.pem>] <in.gdl1> <out>\n' +
      '  private key: env DEBUG_LOGS_PRIVATE_KEY, or --key-file, or stdin\n'
  );
  process.exit(2);
}

async function main(argv) {
  let gunzip = false;
  let keyFile = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gunzip') gunzip = true;
    else if (a === '--key-file')
      keyFile = argv[++i] ?? usage('--key-file needs a path');
    else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) usage();
  const [inPath, outPath] = positional;
  const fromEnv = process.env.DEBUG_LOGS_PRIVATE_KEY;
  if (fromEnv && keyFile) {
    usage('give the key once: DEBUG_LOGS_PRIVATE_KEY or --key-file, not both');
  }
  const keyText =
    fromEnv || (keyFile ? readFileSync(keyFile, 'utf8') : await readStdin());
  const privateKey = parsePrivateKey(keyText);
  process.stderr.write(
    `key fingerprint (keyFp): ${keyFingerprint(createPublicKey(privateKey))}\n`
  );

  const part = `${outPath}.part`;
  try {
    const plain = Readable.from(
      decryptGdl1(createReadStream(inPath), privateKey)
    );
    if (gunzip) await pipeline(plain, createGunzip(), createWriteStream(part));
    else await pipeline(plain, createWriteStream(part));
    renameSync(part, outPath);
  } catch (error) {
    rmSync(part, { force: true });
    process.stderr.write(
      `DECRYPTION FAILED: ${error instanceof Error ? error.message : error}\n`
    );
    process.exit(1);
  }
  process.stderr.write(`ok: ${outPath}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(process.argv.slice(2));
}
