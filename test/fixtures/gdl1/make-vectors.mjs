// TEST ONLY. Writes vectors.json: the GDL1 test vectors that the app's three
// encryptors (src/fullDebug/gdl1.ts, Gdl1.kt, DebugLogFilePlugin.swift) are
// checked against, made with the reference implementation
// (scripts/debug-logs-decrypt.mjs).
//
// The recipient key pair TEST-ONLY-recipient-*.pem and the ephemeral scalar
// below are for these vectors only: they protect nothing and must never be
// built into an app. Rerunning this script gives the same file.
//
//   node test/fixtures/gdl1/make-vectors.mjs

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveKey,
  encryptGdl1,
  keyFingerprint,
  privateKeyFromScalar,
  uncompressedPoint,
} from '../../../scripts/debug-logs-decrypt.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const SIZES = [0, 1, 65535, 65536, 65537, 200000];
const EPHEMERAL_D =
  '16557eb229e3416543632cf48b0f8154bd2d2961029baf2f8aa192dad549cea9';
const NONCE_PREFIX = '9b5b8a83';

/** Byte i of a test plaintext. */
export function testPlaintext(size) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

const sha = b => createHash('sha256').update(b).digest('hex');

function main() {
  const recipientPrivate = createPrivateKey(
    readFileSync(join(here, 'TEST-ONLY-recipient-private.pem'), 'utf8')
  );
  const recipientPublic = createPublicKey(
    readFileSync(join(here, 'TEST-ONLY-recipient-public.pem'), 'utf8')
  );
  if (
    !uncompressedPoint(recipientPrivate).equals(
      uncompressedPoint(recipientPublic)
    )
  ) {
    throw new Error('the two test-only PEM files do not match');
  }
  const d = Buffer.from(EPHEMERAL_D, 'hex');
  // The point of d, through a throwaway private key built from d alone.
  const point = uncompressedPoint(
    createPrivateKey({
      key: Buffer.concat([
        Buffer.from(
          '3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420',
          'hex'
        ),
        d,
      ]),
      format: 'der',
      type: 'pkcs8',
    })
  );
  const ephemeral = { d, point };
  const prefix = Buffer.from(NONCE_PREFIX, 'hex');
  const { shared, key } = deriveKey(
    privateKeyFromScalar(d, point),
    recipientPublic,
    point,
    uncompressedPoint(recipientPublic)
  );
  const cases = SIZES.map(size => {
    const plain = testPlaintext(size);
    const ct = encryptGdl1(plain, recipientPublic, {
      ephemeral,
      noncePrefix: prefix,
    });
    return {
      size,
      plainSha256: sha(plain),
      ciphertextSize: ct.length,
      sha256: sha(ct),
      ...(size <= 1 ? { hex: ct.toString('hex') } : {}),
      tailHex: ct.subarray(Math.max(0, ct.length - 48)).toString('hex'),
    };
  });
  const out = {
    warning:
      'TEST ONLY. The recipient key pair (TEST-ONLY-recipient-*.pem) and the ephemeral key are public test values: never build them into an app.',
    format: 'GDL1',
    plaintext: 'byte i = (i * 31 + 7) & 0xff',
    recipientSpkiB64: recipientPublic
      .export({ type: 'spki', format: 'der' })
      .toString('base64'),
    recipientPoint: uncompressedPoint(recipientPublic).toString('hex'),
    keyFp: keyFingerprint(recipientPublic),
    ephemeralD: EPHEMERAL_D,
    ephemeralPoint: point.toString('hex'),
    noncePrefix: NONCE_PREFIX,
    shared: shared.toString('hex'),
    key: key.toString('hex'),
    header: Buffer.concat([Buffer.from('GDL1'), point, prefix]).toString('hex'),
    cases,
  };
  writeFileSync(
    join(here, 'vectors.json'),
    JSON.stringify(out, null, 2) + '\n'
  );
}

main();
