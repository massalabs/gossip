import {
  type FountainPart,
  FountainDecoder,
  FountainEncoder,
  bytewordsDecode,
  bytewordsEncode,
  cborDecodeBytes,
  cborEncodeBytes,
  decodePart,
  encodePart,
} from './bcur';

/**
 * Animated contact code: the contact's public keys as BC-UR fountain-coded
 * QR frames (Blockchain Commons Uniform Resources). Every frame also carries
 * a small header (user id, ephemeral X25519 key, rendezvous id), so a single
 * frame is enough to start the Bluetooth exchange. Format: CONTACT-EXCHANGE.md.
 *
 *   header-only frame: UR:GOSSIP-CONTACT/<header>
 *   fountain frame:    UR:GOSSIP-CONTACT/<header>/<seq>-<count>/<fragment>
 *
 * `<header>` is the bytewords (minimal, with CRC32) of the CBOR byte string of
 * the 73 header bytes; `<seq>-<count>/<fragment>` is a standard BC-UR
 * multipart part of the UR whose CBOR is the byte string of the payload.
 */

export const CONTACT_UR_TYPE = 'gossip-contact';
const UR_PREFIX = `ur:${CONTACT_UR_TYPE}/`;

export const HEADER_VERSION = 1;
export const USER_ID_LENGTH = 32;
export const EPHEMERAL_KEY_LENGTH = 32;
export const RENDEZVOUS_ID_LENGTH = 8;
export const HEADER_LENGTH =
  1 + USER_ID_LENGTH + EPHEMERAL_KEY_LENGTH + RENDEZVOUS_ID_LENGTH;

/**
 * Bytes of payload per frame. With the header, a frame is about 610
 * alphanumeric characters: a version 13 QR code (69 modules) at error
 * correction L. The ~3 KB of keys take 16 fragments, so 16 frames at best.
 */
export const FRAGMENT_LENGTH = 200;

/** Bounds a decoder accepts, so a hostile code cannot make it allocate much. */
const MAX_MESSAGE_LENGTH = 16 * 1024;
const MAX_PARTS = 128;
const MAX_NAME_BYTES = 400;

export interface ContactCodeHeader {
  userId: Uint8Array;
  ephemeralKey: Uint8Array;
  rendezvousId: Uint8Array;
}

export interface ContactPayload {
  header: ContactCodeHeader;
  name?: string;
  publicKeys: Uint8Array;
}

export function encodeHeader(header: ContactCodeHeader): Uint8Array {
  if (
    header.userId.length !== USER_ID_LENGTH ||
    header.ephemeralKey.length !== EPHEMERAL_KEY_LENGTH ||
    header.rendezvousId.length !== RENDEZVOUS_ID_LENGTH
  ) {
    throw new Error('Invalid contact code header');
  }
  const out = new Uint8Array(HEADER_LENGTH);
  out[0] = HEADER_VERSION;
  out.set(header.userId, 1);
  out.set(header.ephemeralKey, 1 + USER_ID_LENGTH);
  out.set(header.rendezvousId, 1 + USER_ID_LENGTH + EPHEMERAL_KEY_LENGTH);
  return out;
}

export function decodeHeader(bytes: Uint8Array): ContactCodeHeader | null {
  if (bytes.length !== HEADER_LENGTH || bytes[0] !== HEADER_VERSION) {
    return null;
  }
  const keyStart = 1 + USER_ID_LENGTH;
  const ridStart = keyStart + EPHEMERAL_KEY_LENGTH;
  return {
    userId: bytes.slice(1, keyStart),
    ephemeralKey: bytes.slice(keyStart, ridStart),
    rendezvousId: bytes.slice(ridStart, HEADER_LENGTH),
  };
}

/**
 * The bytes both paths (QR frames and Bluetooth) deliver:
 * header (73) ‖ name length (u16 BE) ‖ name (UTF-8) ‖ public keys.
 * Carrying the header binds the keys to the code they were read from.
 */
export function encodePayload(payload: ContactPayload): Uint8Array {
  const header = encodeHeader(payload.header);
  const name = new TextEncoder().encode(payload.name?.trim() ?? '');
  if (name.length > MAX_NAME_BYTES) throw new Error('Name too long');
  const out = new Uint8Array(
    HEADER_LENGTH + 2 + name.length + payload.publicKeys.length
  );
  out.set(header, 0);
  out[HEADER_LENGTH] = name.length >> 8;
  out[HEADER_LENGTH + 1] = name.length & 0xff;
  out.set(name, HEADER_LENGTH + 2);
  out.set(payload.publicKeys, HEADER_LENGTH + 2 + name.length);
  return out;
}

export function decodePayload(bytes: Uint8Array): ContactPayload | null {
  if (bytes.length < HEADER_LENGTH + 2) return null;
  const header = decodeHeader(bytes.slice(0, HEADER_LENGTH));
  if (!header) return null;
  const nameLength = (bytes[HEADER_LENGTH] << 8) | bytes[HEADER_LENGTH + 1];
  const keysStart = HEADER_LENGTH + 2 + nameLength;
  if (nameLength > MAX_NAME_BYTES || keysStart >= bytes.length) return null;
  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.slice(HEADER_LENGTH + 2, keysStart)
    );
  } catch {
    return null;
  }
  return {
    header,
    ...(name && { name }),
    publicKeys: bytes.slice(keysStart),
  };
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function sameHeader(a: ContactCodeHeader, b: ContactCodeHeader) {
  return sameBytes(encodeHeader(a), encodeHeader(b));
}

function headerWords(header: ContactCodeHeader): string {
  return bytewordsEncode(cborEncodeBytes(encodeHeader(header)));
}

/** One frame with only the header: small, for cameras that struggle. */
export function headerOnlyFrame(header: ContactCodeHeader): string {
  return `${UR_PREFIX}${headerWords(header)}`.toUpperCase();
}

/**
 * The frames of an animated code: every simple part once, then as many mixed
 * parts again, shown in a loop. A scanner that misses frames fills the gaps
 * from the mixed ones or on the next loop.
 */
export function encodeContactFrames(payload: ContactPayload): string[] {
  const message = cborEncodeBytes(encodePayload(payload));
  const encoder = new FountainEncoder(message, FRAGMENT_LENGTH);
  const prefix = `${UR_PREFIX}${headerWords(payload.header)}/`;
  const count = encoder.seqLength * 2;
  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    const part = encoder.nextPart();
    const body = bytewordsEncode(encodePart(part));
    frames.push(
      `${prefix}${part.seqNum}-${part.seqLength}/${body}`.toUpperCase()
    );
  }
  return frames;
}

export type ParsedFrame =
  | { header: ContactCodeHeader; part?: undefined }
  | { header: ContactCodeHeader; part: FountainPart };

/** Parses one scanned text; null when it is not a valid contact frame. */
export function parseContactFrame(text: string): ParsedFrame | null {
  const lower = text.trim().toLowerCase();
  if (!lower.startsWith(UR_PREFIX)) return null;
  const components = lower.slice(UR_PREFIX.length).split('/');
  if (components.length !== 1 && components.length !== 3) return null;
  try {
    const headerBytes = cborDecodeBytes(bytewordsDecode(components[0]));
    if (!headerBytes) return null;
    const header = decodeHeader(headerBytes);
    if (!header) return null;
    if (components.length === 1) return { header };

    const seq = /^(\d{1,9})-(\d{1,3})$/.exec(components[1]);
    if (!seq) return null;
    const part = decodePart(bytewordsDecode(components[2]));
    if (
      !part ||
      part.seqNum !== Number(seq[1]) ||
      part.seqLength !== Number(seq[2]) ||
      part.seqNum < 1 ||
      part.seqLength < 2 ||
      part.seqLength > MAX_PARTS ||
      part.messageLength < 1 ||
      part.messageLength > MAX_MESSAGE_LENGTH ||
      part.fragment.length < 1 ||
      part.fragment.length * part.seqLength < part.messageLength ||
      part.fragment.length * (part.seqLength - 1) >= part.messageLength
    ) {
      return null;
    }
    return { header, part };
  } catch {
    return null;
  }
}

export type FrameResult =
  /** Not a contact frame, or a frame of another code than the first one read. */
  | { kind: 'ignored' }
  | {
      kind: 'progress';
      header: ContactCodeHeader;
      progress: number;
      /** The frame carried only the header (the static "simple" code). */
      headerOnly: boolean;
    }
  | { kind: 'complete'; payload: ContactPayload };

/**
 * Reassembles an animated code from frames in any order, with gaps and
 * repeats. It follows the code of the first valid frame and ignores others.
 * A completed payload still has to be checked against the user id
 * (`verifyContactPayload`).
 */
export class ContactCodeDecoder {
  private header: ContactCodeHeader | null = null;
  private fountain = new FountainDecoder();
  private done: ContactPayload | null = null;

  get lockedHeader(): ContactCodeHeader | null {
    return this.header;
  }

  receive(text: string): FrameResult {
    if (this.done) return { kind: 'complete', payload: this.done };
    const frame = parseContactFrame(text);
    if (!frame) return { kind: 'ignored' };
    if (!this.header) this.header = frame.header;
    else if (!sameHeader(this.header, frame.header)) return { kind: 'ignored' };

    if (frame.part) {
      this.fountain.receivePart(frame.part);
      if (this.fountain.isFailure()) {
        // A bad part poisoned the decoder: start again on the next frames.
        this.fountain = new FountainDecoder();
      } else if (this.fountain.isSuccess()) {
        const payload = this.finish(this.fountain.resultMessage());
        if (payload) {
          this.done = payload;
          return { kind: 'complete', payload };
        }
        this.fountain = new FountainDecoder();
      }
    }
    return {
      kind: 'progress',
      header: this.header,
      progress: Math.min(this.fountain.estimatedPercentComplete(), 0.99),
      headerOnly: !frame.part,
    };
  }

  private finish(message: Uint8Array | null): ContactPayload | null {
    const bytes = message && cborDecodeBytes(message);
    const payload = bytes && decodePayload(bytes);
    if (!payload || !this.header || !sameHeader(payload.header, this.header))
      return null;
    return payload;
  }
}
