import { sha256 } from '@noble/hashes/sha2';

/**
 * The subset of BC-UR (Blockchain Commons Uniform Resources, BCR-2020-005)
 * the contact code needs: minimal bytewords with their CRC32, the CBOR of a
 * byte string and of a multipart part, and the fountain encoder and decoder
 * (Xoshiro256** seeded by SHA-256, the alias-method degree sampler and the
 * shuffle of the reference implementation).
 *
 * A port of the reference algorithms written for the browser: the npm
 * implementation (@ngraveio/bc-ur) relies on Node's Buffer, assert and
 * process. Tests check that both produce and read the same frames.
 */

// ── CRC32 (IEEE, as zlib) ───────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32Bytes(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

// ── Bytewords (minimal style) ───────────────────────────────────────────

const WORDS =
  'ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom';

const MINIMAL_WORDS = Array.from(
  { length: 256 },
  (_, i) => WORDS[i * 4] + WORDS[i * 4 + 3]
);
const MINIMAL_INDEX = new Map(MINIMAL_WORDS.map((w, i) => [w, i]));

/** Minimal bytewords of `bytes` followed by their CRC32, lowercase. */
export function bytewordsEncode(bytes: Uint8Array): string {
  const withCrc = new Uint8Array(bytes.length + 4);
  withCrc.set(bytes);
  withCrc.set(uint32Bytes(crc32(bytes)), bytes.length);
  let out = '';
  for (const b of withCrc) out += MINIMAL_WORDS[b];
  return out;
}

/** Decodes minimal bytewords (any case) and checks the CRC32; throws if bad. */
export function bytewordsDecode(text: string): Uint8Array {
  const lower = text.toLowerCase();
  if (lower.length % 2 !== 0 || lower.length < 10) {
    throw new Error('Invalid bytewords');
  }
  const bytes = new Uint8Array(lower.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const value = MINIMAL_INDEX.get(lower.slice(i * 2, i * 2 + 2));
    if (value === undefined) throw new Error('Invalid bytewords');
    bytes[i] = value;
  }
  const body = bytes.slice(0, -4);
  const expected = uint32Bytes(crc32(body));
  for (let i = 0; i < 4; i++) {
    if (bytes[body.length + i] !== expected[i]) {
      throw new Error('Invalid bytewords checksum');
    }
  }
  return body;
}

// ── CBOR (only what parts and byte strings need) ────────────────────────

function cborHead(major: number, value: number): number[] {
  const m = major << 5;
  if (value < 24) return [m | value];
  if (value < 0x100) return [m | 24, value];
  if (value < 0x10000) return [m | 25, value >> 8, value & 0xff];
  return [
    m | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

/** Reads a definite-length head of `major`, minimal form only. */
function readHead(
  bytes: Uint8Array,
  offset: number,
  major: number
): { value: number; next: number } | null {
  const initial = bytes[offset];
  if (initial === undefined || initial >> 5 !== major) return null;
  const info = initial & 0x1f;
  if (info < 24) return { value: info, next: offset + 1 };
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
  if (size === 0 || offset + 1 + size > bytes.length) return null;
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + bytes[offset + 1 + i];
  const min = size === 1 ? 24 : size === 2 ? 0x100 : 0x10000;
  if (value < min) return null;
  return { value, next: offset + 1 + size };
}

export function cborEncodeBytes(bytes: Uint8Array): Uint8Array {
  const head = cborHead(2, bytes.length);
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head);
  out.set(bytes, head.length);
  return out;
}

/** The byte string that is exactly `cbor`, or null. */
export function cborDecodeBytes(cbor: Uint8Array): Uint8Array | null {
  const head = readHead(cbor, 0, 2);
  if (!head || head.next + head.value !== cbor.length) return null;
  return cbor.slice(head.next);
}

// ── Fountain parts ──────────────────────────────────────────────────────

export interface FountainPart {
  seqNum: number;
  seqLength: number;
  messageLength: number;
  checksum: number;
  fragment: Uint8Array;
}

/** CBOR array [seqNum, seqLength, messageLength, checksum, fragment]. */
export function encodePart(part: FountainPart): Uint8Array {
  const head = [
    0x85,
    ...cborHead(0, part.seqNum),
    ...cborHead(0, part.seqLength),
    ...cborHead(0, part.messageLength),
    ...cborHead(0, part.checksum),
  ];
  const fragment = cborEncodeBytes(part.fragment);
  const out = new Uint8Array(head.length + fragment.length);
  out.set(head);
  out.set(fragment, head.length);
  return out;
}

export function decodePart(cbor: Uint8Array): FountainPart | null {
  if (cbor[0] !== 0x85) return null;
  let offset = 1;
  const ints: number[] = [];
  for (let i = 0; i < 4; i++) {
    const head = readHead(cbor, offset, 0);
    if (!head) return null;
    ints.push(head.value);
    offset = head.next;
  }
  const fragment = cborDecodeBytes(cbor.slice(offset));
  if (!fragment || fragment.length === 0) return null;
  const [seqNum, seqLength, messageLength, checksum] = ints;
  return { seqNum, seqLength, messageLength, checksum, fragment };
}

// ── Xoshiro256** and the fragment choice ────────────────────────────────

const MASK64 = (1n << 64n) - 1n;
const TWO_POW_64 = 2 ** 64;

function rotl(x: bigint, k: bigint): bigint {
  return ((x << k) & MASK64) | (x >> (64n - k));
}

class Xoshiro256 {
  private s: bigint[] = [0n, 0n, 0n, 0n];

  constructor(seed: Uint8Array) {
    const digest = sha256(seed);
    for (let i = 0; i < 4; i++) {
      let v = 0n;
      for (let n = 0; n < 8; n++) v = (v << 8n) | BigInt(digest[i * 8 + n]);
      this.s[i] = v;
    }
  }

  next(): bigint {
    const s = this.s;
    const result = (rotl((s[1] * 5n) & MASK64, 7n) * 9n) & MASK64;
    const t = (s[1] << 17n) & MASK64;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 45n);
    return result;
  }

  nextDouble(): number {
    return Number(this.next()) / TWO_POW_64;
  }

  nextInt(low: number, high: number): number {
    return Math.floor(this.nextDouble() * (high - low + 1) + low);
  }
}

/** Walker/Vose alias sampler, in the order of the reference implementation. */
function aliasSample(probabilities: number[], rng: Xoshiro256): number {
  const n = probabilities.length;
  const sum = probabilities.reduce((a, b) => a + b, 0);
  const scaled = probabilities.map(p => (p * n) / sum);
  const prob = new Array<number>(n);
  const alias = new Array<number>(n);
  const small: number[] = [];
  const large: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    if (scaled[i] < 1) small.push(i);
    else large.push(i);
  }
  while (small.length > 0 && large.length > 0) {
    const less = small.pop()!;
    const more = large.pop()!;
    prob[less] = scaled[less];
    alias[less] = more;
    scaled[more] = scaled[more] + scaled[less] - 1;
    if (scaled[more] < 1) small.push(more);
    else large.push(more);
  }
  while (large.length > 0) prob[large.pop()!] = 1;
  while (small.length > 0) prob[small.pop()!] = 1;
  const c = Math.floor(rng.nextDouble() * n);
  return rng.nextDouble() < prob[c] ? c : alias[c];
}

/** The fragments XORed into part `seqNum`: the first `seqLength` are simple. */
export function chooseFragments(
  seqNum: number,
  seqLength: number,
  checksum: number
): number[] {
  if (seqNum <= seqLength) return [seqNum - 1];
  const seed = new Uint8Array(8);
  seed.set(uint32Bytes(seqNum), 0);
  seed.set(uint32Bytes(checksum), 4);
  const rng = new Xoshiro256(seed);
  const degree =
    aliasSample(
      Array.from({ length: seqLength }, (_, i) => 1 / (i + 1)),
      rng
    ) + 1;
  const remaining = Array.from({ length: seqLength }, (_, i) => i);
  const shuffled: number[] = [];
  while (remaining.length > 0) {
    const index = rng.nextInt(0, remaining.length - 1);
    shuffled.push(remaining.splice(index, 1)[0]);
  }
  return shuffled.slice(0, degree);
}

function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i++) target[i] ^= source[i];
}

// ── Encoder ─────────────────────────────────────────────────────────────

export class FountainEncoder {
  readonly fragments: Uint8Array[];
  readonly messageLength: number;
  readonly checksum: number;
  private seqNum = 0;

  constructor(
    message: Uint8Array,
    maxFragmentLength: number,
    minFragmentLength = 10
  ) {
    const length = FountainEncoder.nominalFragmentLength(
      message.length,
      minFragmentLength,
      maxFragmentLength
    );
    this.messageLength = message.length;
    this.checksum = crc32(message);
    this.fragments = [];
    for (let start = 0; start < message.length; start += length) {
      const fragment = new Uint8Array(length);
      fragment.set(message.slice(start, start + length));
      this.fragments.push(fragment);
    }
  }

  static nominalFragmentLength(
    messageLength: number,
    minFragmentLength: number,
    maxFragmentLength: number
  ): number {
    const maxFragmentCount = Math.ceil(messageLength / minFragmentLength);
    let fragmentLength = 0;
    for (let count = 1; count <= maxFragmentCount; count++) {
      fragmentLength = Math.ceil(messageLength / count);
      if (fragmentLength <= maxFragmentLength) break;
    }
    return fragmentLength;
  }

  get seqLength(): number {
    return this.fragments.length;
  }

  nextPart(): FountainPart {
    this.seqNum = (this.seqNum + 1) >>> 0;
    const fragment = new Uint8Array(this.fragments[0].length);
    for (const index of chooseFragments(
      this.seqNum,
      this.seqLength,
      this.checksum
    )) {
      xorInto(fragment, this.fragments[index]);
    }
    return {
      seqNum: this.seqNum,
      seqLength: this.seqLength,
      messageLength: this.messageLength,
      checksum: this.checksum,
      fragment,
    };
  }
}

// ── Decoder ─────────────────────────────────────────────────────────────

interface MixedPart {
  indexes: number[];
  fragment: Uint8Array;
}

function containsAll(outer: number[], inner: number[]): boolean {
  return inner.every(i => outer.includes(i));
}

function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && containsAll(a, b);
}

/** If `b`'s fragments are all in `a`, removes them from `a`. */
function reduce(a: MixedPart, b: MixedPart): MixedPart {
  if (!containsAll(a.indexes, b.indexes)) return a;
  const fragment = a.fragment.slice();
  xorInto(fragment, b.fragment);
  return { indexes: a.indexes.filter(i => !b.indexes.includes(i)), fragment };
}

/**
 * Reassembles a message from fountain parts in any order, with repeats.
 * The first part fixes the message length, checksum and fragment size;
 * parts that disagree are ignored.
 */
export class FountainDecoder {
  private expected: {
    seqLength: number;
    messageLength: number;
    checksum: number;
    fragmentLength: number;
  } | null = null;
  private simple = new Map<number, Uint8Array>();
  private mixed: MixedPart[] = [];
  private queue: MixedPart[] = [];
  private processed = 0;
  private result: Uint8Array | null = null;
  private failed = false;

  isSuccess(): boolean {
    return this.result !== null;
  }

  isFailure(): boolean {
    return this.failed;
  }

  resultMessage(): Uint8Array | null {
    return this.result;
  }

  /** A rough share of the parts needed, below 1 until complete. */
  estimatedPercentComplete(): number {
    if (this.result) return 1;
    if (!this.expected) return 0;
    return Math.min(0.99, this.processed / (this.expected.seqLength * 1.75));
  }

  receivePart(part: FountainPart): boolean {
    if (this.result || this.failed) return false;
    if (!this.expected) {
      this.expected = {
        seqLength: part.seqLength,
        messageLength: part.messageLength,
        checksum: part.checksum,
        fragmentLength: part.fragment.length,
      };
    } else if (
      part.seqLength !== this.expected.seqLength ||
      part.messageLength !== this.expected.messageLength ||
      part.checksum !== this.expected.checksum ||
      part.fragment.length !== this.expected.fragmentLength
    ) {
      return false;
    }
    this.queue.push({
      indexes: chooseFragments(part.seqNum, part.seqLength, part.checksum),
      fragment: part.fragment,
    });
    while (!this.result && !this.failed && this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.indexes.length === 1) this.processSimple(next);
      else this.processMixed(next);
    }
    this.processed++;
    return true;
  }

  private processSimple(part: MixedPart): void {
    const index = part.indexes[0];
    if (this.simple.has(index)) return;
    this.simple.set(index, part.fragment);
    const expected = this.expected!;
    if (this.simple.size === expected.seqLength) {
      const message = new Uint8Array(
        expected.seqLength * expected.fragmentLength
      );
      for (const [i, fragment] of this.simple) {
        message.set(fragment, i * expected.fragmentLength);
      }
      const trimmed = message.slice(0, expected.messageLength);
      if (crc32(trimmed) === expected.checksum) this.result = trimmed;
      else this.failed = true;
      return;
    }
    this.reduceMixedBy(part);
  }

  private processMixed(part: MixedPart): void {
    if (this.mixed.some(m => sameSet(m.indexes, part.indexes))) return;
    let reduced = part;
    for (const [index, fragment] of this.simple) {
      reduced = reduce(reduced, { indexes: [index], fragment });
    }
    for (const m of this.mixed) reduced = reduce(reduced, m);
    if (reduced.indexes.length === 0) return;
    if (reduced.indexes.length === 1) {
      this.queue.push(reduced);
      return;
    }
    this.reduceMixedBy(reduced);
    this.mixed.push(reduced);
  }

  private reduceMixedBy(part: MixedPart): void {
    const kept: MixedPart[] = [];
    for (const m of this.mixed) {
      const reduced = reduce(m, part);
      if (reduced.indexes.length === 1) this.queue.push(reduced);
      else if (reduced.indexes.length > 1) kept.push(reduced);
    }
    this.mixed = kept;
  }
}
