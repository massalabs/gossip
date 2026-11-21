/**
 * Markers to find in the raw bytes of a database: a random string written
 * through the SDK, looked for in every encoding a record might keep it in
 * (UTF-8, UTF-16, hexadecimal, base64 at the three alignments), so that a
 * search that finds nothing means the bytes are gone, not merely re-encoded.
 * Browser-safe: no Node.js imports.
 */

const encoder = new TextEncoder();

/** A marker that occurs nowhere by chance: a prefix and 24 random letters. */
export function newMarker(prefix: string): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const random = crypto.getRandomValues(new Uint8Array(24));
  return prefix + Array.from(random, b => letters[b % letters.length]).join('');
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** The byte patterns under which `marker` may be stored. */
export function markerPatterns(marker: string): Uint8Array[] {
  const utf8 = encoder.encode(marker);
  const hex = Array.from(utf8, b => b.toString(16).padStart(2, '0')).join('');
  const patterns = [
    utf8,
    encoder.encode(hex),
    encoder.encode(hex.toUpperCase()),
    new Uint8Array(
      new Uint16Array(Array.from(marker, c => c.charCodeAt(0))).buffer
    ),
  ];
  // Base64 at each alignment, without the edge characters that depend on the
  // bytes around the marker.
  for (let shift = 0; shift < 3; shift++) {
    const padded = new Uint8Array(shift + utf8.length);
    padded.set(utf8, shift);
    const b64 = base64(padded);
    const start = Math.ceil((shift * 4) / 3) + 1;
    const end = Math.floor(((shift + utf8.length) * 4) / 3) - 1;
    const inner = b64.slice(start, end);
    patterns.push(encoder.encode(inner));
    patterns.push(
      encoder.encode(inner.replace(/\+/g, '-').replace(/\//g, '_'))
    );
  }
  return patterns;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  const first = needle[0];
  const last = haystack.length - needle.length;
  for (let i = haystack.indexOf(first); i !== -1 && i <= last; ) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
    i = haystack.indexOf(first, i + 1);
  }
  return -1;
}

/** Where each marker occurs in `chunks` (named byte ranges); empty if nowhere. */
export function findMarkers(
  chunks: { name: string; bytes: Uint8Array }[],
  markers: string[]
): string[] {
  const found: string[] = [];
  for (const marker of markers) {
    for (const pattern of markerPatterns(marker)) {
      for (const { name, bytes } of chunks) {
        const at = indexOf(bytes, pattern);
        if (at !== -1) found.push(`${marker} in ${name} at ${at}`);
      }
    }
  }
  return found;
}
