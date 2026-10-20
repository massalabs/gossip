import { beforeAll, describe, expect, it } from 'vitest';
import {
  generateUserKeys,
  encodeUserId,
  type UserPublicKeys,
} from '@massalabs/gossip-sdk';
import {
  ContactCodeDecoder,
  type ContactCodeHeader,
  type ContactPayload,
  createRequest,
  decodePayload,
  encodeContactFrames,
  encodePayload,
  generateEphemeralKeyPair,
  generateRendezvousId,
  headerOnlyFrame,
  openResponse,
  parseContactFrame,
  rendezvousUuids,
  sealResponse,
  verifyContactPayload,
} from '../../src/utils/contactExchange';
import { parseInvite, tryParseInvite } from '../../src/utils/invite';

const QR_ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]+$/;

/** Deterministic shuffle so a failure can be replayed. */
function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function decodeAll(frames: string[]): ContactPayload | null {
  const decoder = new ContactCodeDecoder();
  for (const frame of frames) {
    const result = decoder.receive(frame);
    if (result.kind === 'complete') return result.payload;
  }
  return null;
}

describe('contact exchange', () => {
  let keys: UserPublicKeys;
  let otherKeys: UserPublicKeys;
  let header: ContactCodeHeader;
  let payload: ContactPayload;
  let presenter: ReturnType<typeof generateEphemeralKeyPair>;

  beforeAll(async () => {
    keys = (await generateUserKeys('contact-exchange-test-a')).public_keys();
    otherKeys = (
      await generateUserKeys('contact-exchange-test-b')
    ).public_keys();
    presenter = generateEphemeralKeyPair();
    header = {
      userId: keys.derive_id(),
      ephemeralKey: presenter.publicKey,
      rendezvousId: generateRendezvousId(),
    };
    payload = { header, name: 'Alice Ünïcode', publicKeys: keys.to_bytes() };
  });

  describe('frames', () => {
    it('round-trips the payload bytes', () => {
      const decoded = decodePayload(encodePayload(payload));
      expect(decoded?.name).toBe('Alice Ünïcode');
      expect(decoded?.publicKeys).toEqual(payload.publicKeys);
      expect(decoded?.header.userId).toEqual(header.userId);
    });

    it('produces QR alphanumeric frames of a scannable size', () => {
      const frames = encodeContactFrames(payload);
      expect(frames.length).toBeGreaterThan(10);
      for (const frame of frames) {
        expect(frame).toMatch(QR_ALPHANUMERIC);
        expect(frame.length).toBeLessThan(700);
      }
      expect(headerOnlyFrame(header)).toMatch(QR_ALPHANUMERIC);
    });

    it('decodes all frames in order', () => {
      const result = decodeAll(encodeContactFrames(payload));
      expect(result?.publicKeys).toEqual(payload.publicKeys);
      expect(result?.name).toBe('Alice Ünïcode');
    });

    it('decodes with missed, duplicated and shuffled frames', () => {
      const frames = encodeContactFrames(payload);
      for (const seed of [1, 7, 42, 1234]) {
        // drop a quarter of the frames, repeat some, shuffle the rest
        const kept = frames.filter((_, i) => (i + seed) % 4 !== 0);
        const noisy = shuffle([...kept, ...kept.slice(0, 5)], seed);
        // two loops of the animation, as a camera would see them
        const result = decodeAll([...noisy, ...shuffle(frames, seed + 1)]);
        expect(result?.publicKeys).toEqual(payload.publicKeys);
      }
    });

    it('reports progress and the header from a single frame', () => {
      const frames = encodeContactFrames(payload);
      for (const frame of [frames[3], frames[frames.length - 1]]) {
        const decoder = new ContactCodeDecoder();
        const result = decoder.receive(frame);
        expect(result.kind).toBe('progress');
        if (result.kind !== 'progress') return;
        expect(result.header.userId).toEqual(header.userId);
        expect(result.header.ephemeralKey).toEqual(header.ephemeralKey);
        expect(result.header.rendezvousId).toEqual(header.rendezvousId);
        expect(result.progress).toBeLessThan(1);
      }
      const simple = parseContactFrame(headerOnlyFrame(header));
      expect(simple?.header.rendezvousId).toEqual(header.rendezvousId);
      expect(simple?.part).toBeUndefined();
    });

    it('ignores frames of another code and garbage', () => {
      const decoder = new ContactCodeDecoder();
      const frames = encodeContactFrames(payload);
      decoder.receive(frames[0]);
      const other = encodeContactFrames({
        ...payload,
        header: { ...header, rendezvousId: generateRendezvousId() },
      });
      expect(decoder.receive(other[1]).kind).toBe('ignored');
      expect(decoder.receive('hello').kind).toBe('ignored');
      expect(decoder.receive(frames[1].slice(0, -4) + 'AAAA').kind).toBe(
        'ignored'
      );
      expect(decoder.receive('UR:GOSSIP-CONTACT/1-2/ABCD').kind).toBe(
        'ignored'
      );
    });

    it('keeps plain invite codes working', () => {
      const userId = encodeUserId(header.userId);
      const invite = parseInvite(
        `https://gossip.app/invite/${userId}?name=Bob`
      );
      expect(invite).toEqual({ userId, name: 'Bob' });
      expect(parseContactFrame(`https://gossip.app/invite/${userId}`)).toBe(
        null
      );
      expect(tryParseInvite(encodeContactFrames(payload)[0])).toBe(null);
    });
  });

  describe('verification', () => {
    it('accepts keys that hash to the user id', () => {
      const contact = verifyContactPayload(payload);
      expect(contact?.userId).toBe(encodeUserId(header.userId));
      expect(contact?.name).toBe('Alice Ünïcode');
      expect(contact?.publicKeys.to_bytes()).toEqual(keys.to_bytes());
    });

    it('rejects keys that do not match the user id', () => {
      expect(
        verifyContactPayload({ ...payload, publicKeys: otherKeys.to_bytes() })
      ).toBe(null);
      const result = decodeAll(
        encodeContactFrames({ ...payload, publicKeys: otherKeys.to_bytes() })
      );
      expect(result).not.toBe(null);
      expect(verifyContactPayload(result!)).toBe(null);
      expect(
        verifyContactPayload({ ...payload, publicKeys: new Uint8Array(64) })
      ).toBe(null);
    });
  });

  describe('bluetooth key exchange', () => {
    it('both sides derive the same key', () => {
      const { request, keyPair } = createRequest();
      const plain = encodePayload(payload);
      const response = sealResponse(
        presenter.secretKey,
        header,
        request,
        plain
      );
      expect(response).not.toBe(null);
      expect(openResponse(keyPair, header, response!)).toEqual(plain);
    });

    it('fails on tampering, a wrong key or another code', () => {
      const { request, keyPair } = createRequest();
      const plain = encodePayload(payload);
      const response = sealResponse(
        presenter.secretKey,
        header,
        request,
        plain
      )!;

      const flipped = response.slice();
      flipped[flipped.length - 20] ^= 1;
      expect(openResponse(keyPair, header, flipped)).toBe(null);

      const nonceFlipped = response.slice();
      nonceFlipped[2] ^= 1;
      expect(openResponse(keyPair, header, nonceFlipped)).toBe(null);

      expect(openResponse(createRequest().keyPair, header, response)).toBe(
        null
      );

      const otherHeader = { ...header, rendezvousId: generateRendezvousId() };
      expect(openResponse(keyPair, otherHeader, response)).toBe(null);

      // an impostor without the presenter's secret
      const impostor = generateEphemeralKeyPair();
      const forged = sealResponse(impostor.secretKey, header, request, plain)!;
      expect(openResponse(keyPair, header, forged)).toBe(null);
    });

    it('rejects malformed requests and low-order keys', () => {
      const plain = encodePayload(payload);
      expect(
        sealResponse(presenter.secretKey, header, new Uint8Array(10), plain)
      ).toBe(null);
      const zero = new Uint8Array(33);
      zero[0] = 1;
      expect(sealResponse(presenter.secretKey, header, zero, plain)).toBe(null);
    });

    it('derives distinct, well-formed UUIDs per rendezvous id', () => {
      const a = rendezvousUuids(header.rendezvousId);
      const b = rendezvousUuids(generateRendezvousId());
      expect(a.serviceUuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(a.serviceUuid).not.toBe(a.characteristicUuid);
      expect(a.serviceUuid).not.toBe(b.serviceUuid);
      expect(rendezvousUuids(header.rendezvousId)).toEqual(a);
    });
  });
});
