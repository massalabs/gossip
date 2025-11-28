import { describe, it, expect } from 'vitest';

describe('Default unit test example', () => {
  it('runs in jsdom by default', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
  });

  it('can test simple functions', () => {
    const add = (a: number, b: number) => a + b;
    expect(add(2, 3)).toBe(5);
  });

  it('has access to localStorage', () => {
    localStorage.setItem('test', 'value');
    expect(localStorage.getItem('test')).toBe('value');
    localStorage.clear();
  });
});
