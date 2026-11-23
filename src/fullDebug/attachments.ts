/**
 * Files the tester attaches (screenshots, photos, videos, anything),
 * encrypted to the developers' key (GDL1, see gdl1.ts) and read in 64 KiB
 * chunks, never whole. What is hashed, cut in pieces and sent is the
 * ciphertext.
 *
 * The file is read twice: once to hash the ciphertext, then piece by piece
 * when sent (and again on a resume). Each chunk is encrypted again with the
 * same key and nonce, which gives the same bytes as long as the file is
 * unchanged. The tag of every chunk is kept from the first pass and compared
 * before a chunk is used: if the file changed in between, the send stops
 * instead of sending a second ciphertext under the same nonce.
 */
import { sha256 } from '@noble/hashes/sha2';
import { attachmentName, pieceCount, PIECE, type Attachment } from './upload';
import {
  createSealer,
  gdl1Size,
  GDL1_CHUNK,
  GDL1_CHUNK_OVERHEAD,
  GDL1_HEADER,
  GDL1_TAG,
  type Gdl1Recipient,
  type Gdl1TestOverride,
} from './gdl1';

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Bytes of a full chunk's record in the GDL1 file. */
const RECORD = GDL1_CHUNK + GDL1_CHUNK_OVERHEAD;

/**
 * The GDL1 file of `file`, readable by byte range without holding it whole.
 * `hashAll` must run once before `read`.
 */
export async function encryptedFile(
  file: Blob,
  recipient: Gdl1Recipient,
  test?: Gdl1TestOverride
) {
  const sealer = await createSealer(recipient, test);
  const plainSize = file.size;
  const chunks = Math.max(1, Math.ceil(plainSize / GDL1_CHUNK));
  const size = gdl1Size(plainSize);
  const tags = new Uint8Array(chunks * GDL1_TAG);
  let hashed = false;

  const record = async (i: number, first: boolean): Promise<Uint8Array> => {
    const plain = new Uint8Array(
      await file
        .slice(i * GDL1_CHUNK, Math.min(plainSize, (i + 1) * GDL1_CHUNK))
        .arrayBuffer()
    );
    const out = await sealer.seal(i, plain, i === chunks - 1);
    const tag = out.subarray(out.length - GDL1_TAG);
    if (first) {
      tags.set(tag, i * GDL1_TAG);
    } else {
      const kept = tags.subarray(i * GDL1_TAG, (i + 1) * GDL1_TAG);
      if (tag.some((b, j) => b !== kept[j])) {
        throw new Error(
          'an attached file changed after it was picked: pick it again'
        );
      }
    }
    return out;
  };

  return {
    size,
    plainSize,
    /** SHA-256 (hex) of the whole GDL1 file; keeps each chunk's tag. */
    async hashAll(onProgress?: (plainDone: number) => void): Promise<string> {
      const h = sha256.create();
      h.update(sealer.header);
      for (let i = 0; i < chunks; i++) {
        h.update(await record(i, true));
        onProgress?.(Math.min(plainSize, (i + 1) * GDL1_CHUNK));
      }
      hashed = true;
      return toHex(h.digest());
    },
    /** Bytes [start, end) of the GDL1 file. */
    async read(start: number, end: number): Promise<Uint8Array> {
      if (!hashed) throw new Error('hashAll first');
      end = Math.min(end, size);
      if (start >= end) return new Uint8Array(0);
      const out = new Uint8Array(end - start);
      if (start < GDL1_HEADER) {
        out.set(sealer.header.subarray(start, Math.min(end, GDL1_HEADER)), 0);
      }
      const from = Math.max(start, GDL1_HEADER);
      for (
        let i = Math.floor((from - GDL1_HEADER) / RECORD);
        i < chunks && GDL1_HEADER + i * RECORD < end;
        i++
      ) {
        const at = GDL1_HEADER + i * RECORD;
        const rec = await record(i, false);
        const lo = Math.max(start, at);
        const hi = Math.min(end, at + rec.length);
        out.set(rec.subarray(lo - at, hi - at), lo - start);
      }
      return out;
    },
  };
}

/** Encrypts and hashes `file` once; its pieces are encrypted again when sent. */
export async function fileAttachment(
  index: number,
  file: File,
  recipient: Gdl1Recipient,
  onHashProgress?: (done: number) => void,
  test?: Gdl1TestOverride
): Promise<Attachment> {
  const enc = await encryptedFile(file, recipient, test);
  const digest = await enc.hashAll(onHashProgress);
  return {
    name: attachmentName(index, file.name || 'file'),
    originalName: file.name,
    type: file.type || 'application/octet-stream',
    size: enc.size,
    plainSize: enc.plainSize,
    pieces: pieceCount(enc.size),
    sha256: digest,
    readPiece: n => enc.read(n * PIECE, (n + 1) * PIECE),
  };
}
