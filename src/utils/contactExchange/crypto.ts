import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { blake3 } from '@noble/hashes/blake3';
import { randomBytes } from '@noble/hashes/utils';
import {
  type ContactCodeHeader,
  EPHEMERAL_KEY_LENGTH,
  RENDEZVOUS_ID_LENGTH,
  encodeHeader,
} from './frame';

/**
 * Crypto of the Bluetooth exchange (CONTACT-EXCHANGE.md):
 *
 *   scanner → presenter  request  = 0x01 ‖ B
 *   presenter → scanner  response = 0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(payload)
 *
 *   transcript = "gossip-contact-exchange/1" ‖ header(73) ‖ B
 *   key        = HKDF-SHA256(X25519(a, B) = X25519(b, A), salt = rendezvous id,
 *                            info = transcript)
 *
 * A and the rendezvous id come from the QR header, B is the scanner's
 * ephemeral key. The AEAD's associated data is the transcript too.
 */

const VERSION = 1;
const LABEL = new TextEncoder().encode('gossip-contact-exchange/1');
const NONCE_LENGTH = 24;
export const REQUEST_LENGTH = 1 + EPHEMERAL_KEY_LENGTH;

export interface EphemeralKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function generateRendezvousId(): Uint8Array {
  return randomBytes(RENDEZVOUS_ID_LENGTH);
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes.slice(0, 16), b =>
    b.toString(16).padStart(2, '0')
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The BLE service and characteristic UUIDs of one code, derived from its
 * rendezvous id: they look random to a bystander and change with every code.
 */
export function rendezvousUuids(rendezvousId: Uint8Array): {
  serviceUuid: string;
  characteristicUuid: string;
} {
  const derive = (label: string) =>
    formatUuid(
      blake3(rendezvousId, { context: `gossip-contact-exchange/1 ${label}` })
    );
  return {
    serviceUuid: derive('service'),
    characteristicUuid: derive('characteristic'),
  };
}

function transcript(header: ContactCodeHeader, scannerKey: Uint8Array) {
  const headerBytes = encodeHeader(header);
  const out = new Uint8Array(LABEL.length + headerBytes.length + 32);
  out.set(LABEL, 0);
  out.set(headerBytes, LABEL.length);
  out.set(scannerKey, LABEL.length + headerBytes.length);
  return out;
}

function sessionKey(
  shared: Uint8Array,
  header: ContactCodeHeader,
  info: Uint8Array
): Uint8Array {
  return hkdf(sha256, shared, header.rendezvousId, info, 32);
}

/** Scanner side: the request to write, and the secret to open the answer. */
export function createRequest(): {
  request: Uint8Array;
  keyPair: EphemeralKeyPair;
} {
  const keyPair = generateEphemeralKeyPair();
  const request = new Uint8Array(REQUEST_LENGTH);
  request[0] = VERSION;
  request.set(keyPair.publicKey, 1);
  return { request, keyPair };
}

/**
 * Presenter side: seals the payload for the scanner that sent `request`.
 * Null for a malformed request or a low-order key.
 */
export function sealResponse(
  presenterSecret: Uint8Array,
  header: ContactCodeHeader,
  request: Uint8Array,
  payload: Uint8Array
): Uint8Array | null {
  if (request.length !== REQUEST_LENGTH || request[0] !== VERSION) return null;
  const scannerKey = request.slice(1);
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(presenterSecret, scannerKey);
  } catch {
    return null;
  }
  const info = transcript(header, scannerKey);
  const key = sessionKey(shared, header, info);
  const nonce = randomBytes(NONCE_LENGTH);
  const sealed = xchacha20poly1305(key, nonce, info).encrypt(payload);
  shared.fill(0);
  key.fill(0);
  const out = new Uint8Array(1 + NONCE_LENGTH + sealed.length);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(sealed, 1 + NONCE_LENGTH);
  return out;
}

/** Scanner side: opens the presenter's answer; null if anything is off. */
export function openResponse(
  keyPair: EphemeralKeyPair,
  header: ContactCodeHeader,
  response: Uint8Array
): Uint8Array | null {
  if (response.length < 1 + NONCE_LENGTH + 16 || response[0] !== VERSION) {
    return null;
  }
  try {
    const shared = x25519.getSharedSecret(
      keyPair.secretKey,
      header.ephemeralKey
    );
    const info = transcript(header, keyPair.publicKey);
    const key = sessionKey(shared, header, info);
    shared.fill(0);
    const nonce = response.slice(1, 1 + NONCE_LENGTH);
    const plain = xchacha20poly1305(key, nonce, info).decrypt(
      response.slice(1 + NONCE_LENGTH)
    );
    key.fill(0);
    return plain;
  } catch {
    return null;
  }
}
