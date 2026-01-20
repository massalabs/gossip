import { describe, it, expect } from 'vitest';
import { ROUTES } from '../../src/constants/routes';
import { encodeUserId, formatUserId } from 'gossip-sdk';

describe('App jsdom example', () => {
  it('runs in jsdom by default', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
  });

  it('builds discussion route paths correctly', () => {
    expect(ROUTES.discussion({ userId: '123' })).toBe('/discussion/123');
    expect(ROUTES.discussion()).toBe('/discussion/:userId');
  });

  it('formats userIds for display', () => {
    const raw = new Uint8Array(32).fill(7);
    const encoded = encodeUserId(raw);
    const formatted = formatUserId(encoded);

    expect(encoded.startsWith('gossip1')).toBe(true);
    expect(formatted).toContain('...');
    expect(formatted.length).toBeLessThan(encoded.length);
  });

  it('can use localStorage in jsdom (like app settings)', () => {
    localStorage.setItem('gossip-example', 'on');
    expect(localStorage.getItem('gossip-example')).toBe('on');
    localStorage.clear();
  });
});
