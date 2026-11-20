/**
 * The wasm bindings decode public and secret keys only from their exact
 * encoding: a user ID is the hash of the encoded public keys, so bytes with
 * trailing data or another encoding of the same keys must not pass for them.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  UserPublicKeys,
  UserSecretKeys,
  generate_user_keys,
} from '../../src/wasm/bindings';
import { ensureWasmInitialized } from '../../src/wasm';

/** The first length is written as 251 then a u16; 252 then a u32 is wider. */
function widerLengthPrefix(bytes: Uint8Array): Uint8Array {
  expect(bytes[0]).toBe(251);
  return Uint8Array.from([252, bytes[1], bytes[2], 0, 0, ...bytes.subarray(3)]);
}

function refusedForms(bytes: Uint8Array): [string, Uint8Array][] {
  return [
    ['one trailing byte', Uint8Array.from([...bytes, 0])],
    [
      'many trailing bytes',
      Uint8Array.from([...bytes, ...new Uint8Array(64).fill(0xff)]),
    ],
    ['cut by one byte', bytes.slice(0, bytes.length - 1)],
    ['cut in the middle', bytes.slice(0, bytes.length >> 1)],
    ['empty', new Uint8Array(0)],
    ['wider length prefix', widerLengthPrefix(bytes)],
  ];
}

describe('key decoding in the wasm bindings', () => {
  let publicBytes: Uint8Array;
  let secretBytes: Uint8Array;

  beforeAll(async () => {
    await ensureWasmInitialized();
    const keys = generate_user_keys('exact key encoding');
    const pk = keys.public_keys();
    const sk = keys.secret_keys();
    publicBytes = new Uint8Array(pk.to_bytes());
    secretBytes = new Uint8Array(sk.to_bytes());
    pk.free();
    sk.free();
    keys.free();
  });

  it('accepts the exact encoding of the public keys', () => {
    const keys = UserPublicKeys.from_bytes(publicBytes);
    expect(new Uint8Array(keys.to_bytes())).toEqual(publicBytes);
    keys.free();
  });

  it('accepts the exact encoding of the secret keys', () => {
    const keys = UserSecretKeys.from_bytes(secretBytes);
    expect(new Uint8Array(keys.to_bytes())).toEqual(secretBytes);
    keys.free();
  });

  it('refuses any other bytes for the public keys', () => {
    for (const [name, bytes] of refusedForms(publicBytes)) {
      expect(() => UserPublicKeys.from_bytes(bytes), name).toThrow(
        /Deserialization error/
      );
    }
  });

  it('refuses any other bytes for the secret keys', () => {
    for (const [name, bytes] of refusedForms(secretBytes)) {
      expect(() => UserSecretKeys.from_bytes(bytes), name).toThrow(
        /Deserialization error/
      );
    }
  });
});
