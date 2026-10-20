import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
// The npm BC-UR implementation, used here only as a reference to check that
// the app's port produces and reads the same bytewords, parts and frames.
import { UR, UREncoder, URDecoder } from '@ngraveio/bc-ur';
import refBytewords from '@ngraveio/bc-ur/dist/bytewords';
import RefFountainEncoder from '@ngraveio/bc-ur/dist/fountainEncoder';
import {
  FountainDecoder,
  FountainEncoder,
  bytewordsDecode,
  bytewordsEncode,
  cborDecodeBytes,
  cborEncodeBytes,
  chooseFragments,
  crc32,
  decodePart,
  encodePart,
} from '../../src/utils/contactExchange/bcur';

/** Deterministic bytes. */
function message(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed;
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s >> 16;
  }
  return out;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('BC-UR port', () => {
  it('computes the IEEE CRC32', () => {
    // "123456789" is the standard check value
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('matches the reference bytewords', () => {
    for (const length of [1, 5, 73, 300]) {
      const data = message(length, length);
      const ours = bytewordsEncode(data);
      expect(ours).toBe(
        refBytewords.encode(hex(data), refBytewords.STYLES.MINIMAL)
      );
      expect(hex(bytewordsDecode(ours.toUpperCase()))).toBe(hex(data));
    }
    expect(() => bytewordsDecode('abcd')).toThrow();
    const bad = bytewordsEncode(message(10, 1));
    expect(() => bytewordsDecode(bad.slice(0, -2) + 'ae')).toThrow();
  });

  it('matches the reference CBOR of byte strings', () => {
    for (const length of [0, 23, 24, 255, 256, 3200, 70000]) {
      const data = message(length, 3);
      const ours = cborEncodeBytes(data);
      expect(hex(ours)).toBe(
        UR.fromBuffer(Buffer.from(data)).cbor.toString('hex')
      );
      expect(hex(cborDecodeBytes(ours)!)).toBe(hex(data));
    }
    // not minimal, or trailing bytes
    expect(cborDecodeBytes(new Uint8Array([0x58, 0x01, 0xaa]))).toBe(null);
    expect(cborDecodeBytes(new Uint8Array([0x41, 0xaa, 0xbb]))).toBe(null);
  });

  it('chooses the same fragments and parts as the reference', () => {
    for (const [length, maxFragment] of [
      [3134, 200],
      [1000, 100],
      [50, 10],
    ]) {
      const data = message(length, length);
      const ours = new FountainEncoder(data, maxFragment);
      const reference = new RefFountainEncoder(Buffer.from(data), maxFragment);
      expect(ours.seqLength).toBe(reference.fragmentsLength);
      for (let i = 0; i < ours.seqLength * 4; i++) {
        const a = ours.nextPart();
        const b = reference.nextPart();
        expect(hex(encodePart(a))).toBe(b.cbor().toString('hex'));
        expect(decodePart(encodePart(a))).toEqual(a);
      }
    }
    expect(chooseFragments(3, 10, 123)).toEqual([2]);
  });

  it('reads parts of the reference encoder, and the reference reads ours', () => {
    const data = message(3134, 9);
    const ur = UR.fromBuffer(Buffer.from(data));

    // ours decoding the reference's mixed parts only (skip the simple ones)
    const refEncoder = new UREncoder(ur, 200);
    const decoder = new FountainDecoder();
    for (let i = 0; i < 200 && !decoder.isSuccess(); i++) {
      const text = refEncoder.nextPart();
      const [, seqAndBody] = text.split(/\/(.+)/);
      const body = seqAndBody.split('/')[1];
      const part = decodePart(bytewordsDecode(body))!;
      if (part.seqNum <= part.seqLength) continue;
      decoder.receivePart(part);
    }
    expect(decoder.isSuccess()).toBe(true);
    expect(hex(cborDecodeBytes(decoder.resultMessage()!)!)).toBe(hex(data));

    // the reference decoding ours, mixed parts only
    const encoder = new FountainEncoder(cborEncodeBytes(data), 200);
    const refDecoder = new URDecoder();
    for (let i = 0; i < 200 && !refDecoder.isComplete(); i++) {
      const part = encoder.nextPart();
      if (part.seqNum <= part.seqLength) continue;
      refDecoder.receivePart(
        `ur:bytes/${part.seqNum}-${part.seqLength}/${bytewordsEncode(encodePart(part))}`
      );
    }
    expect(refDecoder.isSuccess()).toBe(true);
    expect(refDecoder.resultUR().decodeCBOR().toString('hex')).toBe(hex(data));
  });

  it('ignores parts that disagree with the first one', () => {
    const encoder = new FountainEncoder(message(500, 1), 50);
    const other = new FountainEncoder(message(500, 2), 50);
    const decoder = new FountainDecoder();
    expect(decoder.receivePart(encoder.nextPart())).toBe(true);
    expect(decoder.receivePart(other.nextPart())).toBe(false);
  });
});
