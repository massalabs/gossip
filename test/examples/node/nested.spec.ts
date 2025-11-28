import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';

describe('Node test (nested folder)', () => {
  it('works in test/examples/node/', () => {
    const buf = Buffer.from('nested', 'utf-8');
    expect(buf.toString()).toBe('nested');
  });

  it('has no DOM in node environment', () => {
    // In true node environment, these should be undefined
    expect(typeof window === 'undefined' || window === null).toBe(true);
    expect(typeof document === 'undefined' || document === null).toBe(true);
  });
});
