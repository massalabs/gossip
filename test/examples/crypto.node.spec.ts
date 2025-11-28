// Runs in NODE mode (no DOM, pure logic testing)

import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';

describe('node environment example', () => {
  it('can use Node.js APIs', () => {
    const buf = Buffer.from('hello', 'utf-8');
    expect(buf.toString()).toBe('hello');
  });

  it('runs in node environment without DOM', () => {
    // In node environment, window/document are undefined
    // This test verifies we're actually in node mode, not browser
    expect(typeof window === 'undefined' || window === null).toBe(true);
    expect(typeof document === 'undefined' || document === null).toBe(true);
  });

  it('can test pure functions', () => {
    const add = (a: number, b: number) => a + b;
    expect(add(2, 3)).toBe(5);
  });

  it('can test crypto utilities', () => {
    // Example: Testing pure crypto logic without DOM
    const hash = (str: string) => {
      // Simplified example
      return str.split('').reduce((acc, char) => {
        return acc + char.charCodeAt(0);
      }, 0);
    };

    expect(hash('hello')).toBe(532);
  });
});
