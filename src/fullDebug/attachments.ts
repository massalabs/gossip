/**
 * Files the tester attaches (screenshots, photos, videos, anything): read in
 * 512 KiB slices, never whole, with an incremental SHA-256.
 */
import { sha256 } from '@noble/hashes/sha2';
import { attachmentName, pieceCount, PIECE, type Attachment } from './upload';

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function slice(file: Blob, n: number): Promise<Uint8Array> {
  return new Uint8Array(
    await file
      .slice(n * PIECE, Math.min(file.size, (n + 1) * PIECE))
      .arrayBuffer()
  );
}

/** Reads `file` once to hash it; the pieces are read again when sent. */
export async function fileAttachment(
  index: number,
  file: File,
  onHashProgress?: (done: number) => void
): Promise<Attachment> {
  const pieces = pieceCount(file.size);
  const h = sha256.create();
  for (let n = 0; n < pieces; n++) {
    h.update(await slice(file, n));
    onHashProgress?.(Math.min(file.size, (n + 1) * PIECE));
  }
  return {
    name: attachmentName(index, file.name || 'file'),
    originalName: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    pieces,
    sha256: toHex(h.digest()),
    readPiece: n => slice(file, n),
  };
}
