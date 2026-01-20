/**
 * User ID utility tests
 */

import { describe, it, expect } from 'vitest';
import { bech32 } from '@scure/base';
import {
  encodeUserId,
  decodeUserId,
  isValidUserId,
  formatUserId,
} from '../src/utils/userId';

describe('userId utils', () => {
  it('encodes and decodes a 32-byte userId', () => {
    const bytes = new Uint8Array(32).fill(7);
    const encoded = encodeUserId(bytes);
    const decoded = decodeUserId(encoded);
    expect(decoded).toEqual(bytes);
  });

  it('throws on invalid length', () => {
    expect(() => encodeUserId(new Uint8Array(31))).toThrow(
      'User ID must be exactly 32 bytes'
    );
  });

  it('throws on invalid prefix', () => {
    const bytes = new Uint8Array(32).fill(8);
    const invalid = bech32.encode('wrong', bech32.toWords(bytes));
    expect(() => decodeUserId(invalid)).toThrow('Invalid prefix');
  });

  it('validates userId format', () => {
    const encoded = encodeUserId(new Uint8Array(32).fill(1));
    expect(isValidUserId(encoded)).toBe(true);
    expect(isValidUserId('invalid')).toBe(false);
  });

  it('formats userId for display', () => {
    const encoded = encodeUserId(new Uint8Array(32).fill(2));
    const formatted = formatUserId(encoded, 4, 4);
    expect(formatted.startsWith('gossip1')).toBe(true);
    expect(formatted.includes('...')).toBe(true);
  });
});
