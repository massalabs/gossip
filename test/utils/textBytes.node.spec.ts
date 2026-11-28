import { describe, expect, it } from 'vitest';
import { nearByteLimit, utf8Bytes } from '../../src/utils/textBytes';

describe('text bytes', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(utf8Bytes('')).toBe(0);
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('\u00e9')).toBe(2);
    expect(utf8Bytes('\u4e2d\u6587')).toBe(6);
    expect(utf8Bytes('\u{1f600}')).toBe(4);
  });

  it('is near a limit from 90 % of it', () => {
    expect(nearByteLimit(14_745, 16_384)).toBe(false);
    expect(nearByteLimit(14_746, 16_384)).toBe(true);
    expect(nearByteLimit(16_385, 16_384)).toBe(true);
  });
});
