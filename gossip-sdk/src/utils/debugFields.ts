/**
 * Small helpers that build the fields of debug log lines (see debugLog.ts).
 * All of them are cheap and none of them throws.
 */

import { decodeUserId } from './userId.js';

const HEX = '0123456789abcdef';

/**
 * First 8 hex characters of an ID: enough to follow it, too short to be
 * content. A Gossip user ID (`gossip1…`) gives the same short ID as its
 * bytes, so that a user reads the same in every line.
 */
export function shortId(id: Uint8Array | string | null | undefined): string {
  if (id == null) return '';
  try {
    if (typeof id === 'string') {
      if (id.startsWith('gossip1')) return shortId(decodeUserId(id));
      return id.slice(0, 8);
    }
    let out = '';
    for (let i = 0; i < 4 && i < id.length; i++) {
      out += HEX[id[i] >> 4] + HEX[id[i] & 15];
    }
    return out;
  } catch {
    return '';
  }
}

/** Full hex of a buffer, for content and secret fields only. */
export function hex(bytes: Uint8Array | null | undefined): string {
  if (!bytes) return '';
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  }
  return out;
}

/** Error name, message and stack, for the fields of a failure line. */
export function errFields(error: unknown): Record<string, unknown> {
  try {
    if (error instanceof Error) {
      return { err: error.name, msg: error.message, stack: error.stack };
    }
    return { err: typeof error, msg: String(error) };
  } catch {
    return { err: 'unknown' };
  }
}

/** Milliseconds since an earlier `performance.now()`, rounded to 0.1 ms. */
export function since(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10;
}
