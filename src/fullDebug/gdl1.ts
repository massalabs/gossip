/**
 * GDL1: public-key encryption of what the full debug build sends (the log
 * and every attached file), so that the backend stores only ciphertext and
 * only the holder of the developers' private key can read a send.
 *
 *   header  "GDL1" | ephemeral P-256 public key, uncompressed (65) | nonce prefix (4)
 *   key     HKDF-SHA256(ikm = ECDH x coordinate,
 *                       salt = ephemeral public (65) | recipient public (65),
 *                       info = "gossip-debug-logs v1", 32 bytes)
 *   chunks  the plaintext cut in 65536-byte chunks (the last may be shorter,
 *           empty only when the whole plaintext is), each written as
 *           u32 BE length | AES-256-GCM ciphertext | 16-byte tag, with
 *           nonce = prefix | u64 BE index and AAD = 0x01 for the last chunk,
 *           0x00 otherwise (a reader detects a truncated file).
 *
 * A fresh ephemeral key and nonce prefix for every file of every send; the
 * ephemeral private key is not extractable and never leaves this object.
 * Same format natively (Gdl1.kt, DebugLogFilePlugin.swift); the reference and
 * the decryption are scripts/debug-logs-decrypt.mjs, the shared test vectors
 * test/fixtures/gdl1/vectors.json.
 */

export const GDL1 = 'GDL1';
export const GDL1_CHUNK = 65536;
export const GDL1_TAG = 16;
export const GDL1_HEADER = 4 + 65 + 4;
/** Bytes a chunk adds: its length field and its tag. */
export const GDL1_CHUNK_OVERHEAD = 4 + GDL1_TAG;
const INFO = new TextEncoder().encode('gossip-debug-logs v1');

export class Gdl1KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Gdl1KeyError';
  }
}

/** The developers' public key, built into the full debug app. */
export interface Gdl1Recipient {
  /** base64 of the DER SubjectPublicKeyInfo, as built in. */
  base64: string;
  /** Uncompressed point, 65 bytes. */
  point: Uint8Array;
  /** Hex SHA-256 of the DER: says which private key decrypts. */
  fingerprint: string;
  key: CryptoKey;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Copy into a fresh ArrayBuffer (WebCrypto wants a BufferSource). */
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Reads the built-in public key (`VITE_DEBUG_LOGS_PUBLIC_KEY`). Throws a
 * Gdl1KeyError when it is missing or is not a P-256 public key: nothing is
 * ever sent unencrypted.
 */
export async function importRecipient(
  base64: string | undefined
): Promise<Gdl1Recipient> {
  const b64 = (base64 ?? '').replace(/\s+/g, '');
  if (!b64) {
    throw new Gdl1KeyError(
      'this build has no key to encrypt the logs (VITE_DEBUG_LOGS_PUBLIC_KEY): nothing was sent'
    );
  }
  let der: Uint8Array;
  let key: CryptoKey;
  let point: Uint8Array;
  try {
    der = fromBase64(b64);
    key = await crypto.subtle.importKey(
      'spki',
      buf(der),
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
    point = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  } catch {
    throw new Gdl1KeyError(
      'the key built into this app to encrypt the logs is not a P-256 public key: nothing was sent'
    );
  }
  if (point.length !== 65 || point[0] !== 4) {
    throw new Gdl1KeyError('the built-in key is not an uncompressed P-256 key');
  }
  const fp = new Uint8Array(await crypto.subtle.digest('SHA-256', buf(der)));
  return { base64: b64, point, fingerprint: toHex(fp), key };
}

/** Size of the GDL1 file of a plaintext of `plainSize` bytes. */
export function gdl1Size(plainSize: number): number {
  const chunks = Math.max(1, Math.ceil(plainSize / GDL1_CHUNK));
  return GDL1_HEADER + chunks * GDL1_CHUNK_OVERHEAD + plainSize;
}

/** For the test vectors only: a given ephemeral key and nonce prefix. */
export interface Gdl1TestOverride {
  ephemeralD: Uint8Array;
  ephemeralPoint: Uint8Array;
  noncePrefix: Uint8Array;
}

/** One file being encrypted: its header, then its chunks by index. */
export interface Gdl1Sealer {
  header: Uint8Array;
  /** The record of chunk `index`: length | ciphertext | tag. */
  seal(index: number, plain: Uint8Array, last: boolean): Promise<Uint8Array>;
}

export async function createSealer(
  recipient: Gdl1Recipient,
  test?: Gdl1TestOverride
): Promise<Gdl1Sealer> {
  const subtle = crypto.subtle;
  let ephemeralPrivate: CryptoKey;
  let ephemeralPoint: Uint8Array;
  let prefix: Uint8Array;
  if (test) {
    ephemeralPoint = test.ephemeralPoint;
    ephemeralPrivate = await subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        d: base64url(test.ephemeralD),
        x: base64url(test.ephemeralPoint.subarray(1, 33)),
        y: base64url(test.ephemeralPoint.subarray(33, 65)),
      },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits']
    );
    prefix = test.noncePrefix.slice();
  } else {
    // The private half is not extractable: it cannot be logged or stored.
    const pair = (await subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits']
    )) as CryptoKeyPair;
    ephemeralPrivate = pair.privateKey;
    ephemeralPoint = new Uint8Array(
      await subtle.exportKey('raw', pair.publicKey)
    );
    prefix = crypto.getRandomValues(new Uint8Array(4));
  }
  const shared = await subtle.deriveBits(
    { name: 'ECDH', public: recipient.key },
    ephemeralPrivate,
    256
  );
  const salt = new Uint8Array(130);
  salt.set(ephemeralPoint, 0);
  salt.set(recipient.point, 65);
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, [
    'deriveKey',
  ]);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(INFO) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const header = new Uint8Array(GDL1_HEADER);
  header.set(new TextEncoder().encode(GDL1), 0);
  header.set(ephemeralPoint, 4);
  header.set(prefix, 69);
  return {
    header,
    async seal(index, plain, last) {
      if (plain.length > GDL1_CHUNK) throw new Error('GDL1 chunk too large');
      const nonce = new Uint8Array(12);
      nonce.set(prefix, 0);
      new DataView(nonce.buffer).setBigUint64(4, BigInt(index), false);
      const sealed = new Uint8Array(
        await subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: nonce,
            additionalData: new Uint8Array([last ? 1 : 0]),
            tagLength: 128,
          },
          key,
          buf(plain)
        )
      );
      const record = new Uint8Array(4 + sealed.length);
      new DataView(record.buffer).setUint32(0, sealed.length, false);
      record.set(sealed, 4);
      return record;
    },
  };
}

/** The GDL1 file of `plain`, whole (the web log: small, in memory). */
export async function encryptBytes(
  plain: Uint8Array,
  recipient: Gdl1Recipient,
  test?: Gdl1TestOverride
): Promise<Uint8Array> {
  const sealer = await createSealer(recipient, test);
  const out = new Uint8Array(gdl1Size(plain.length));
  out.set(sealer.header, 0);
  let at = GDL1_HEADER;
  const chunks = Math.max(1, Math.ceil(plain.length / GDL1_CHUNK));
  for (let i = 0; i < chunks; i++) {
    const record = await sealer.seal(
      i,
      plain.subarray(i * GDL1_CHUNK, (i + 1) * GDL1_CHUNK),
      i === chunks - 1
    );
    out.set(record, at);
    at += record.length;
  }
  return out;
}
