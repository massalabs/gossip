import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_PUBLIC_BASE_URL } from '../../src/constants/links';
import { AppRoute } from '../../src/constants/routes';
import { generateDeepLinkUrl } from '../../src/utils/inviteUrl';

// Helper to safely override window.location.origin in jsdom
const setWindowOrigin = (origin: string | null) => {
  const location = window.location;
  if (origin === null) {
    // @ts-expect-error - jsdom types
    delete window.location;
    // @ts-expect-error - jsdom types
    window.location = location;
    return;
  }

  Object.defineProperty(window, 'location', {
    value: {
      ...location,
      origin,
    },
    writable: true,
  });
};

describe('inviteUrl - generateDeepLinkUrl', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    // Reset just the VITE_APP_BASE_URL and location before each test
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_APP_BASE_URL;
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  afterEach(() => {
    // Clean up VITE_APP_BASE_URL and restore location after each test
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_APP_BASE_URL;
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  it('throws when userId is empty or whitespace', () => {
    expect(() => generateDeepLinkUrl('')).toThrowError('userId is required');
    expect(() => generateDeepLinkUrl('   ')).toThrowError('userId is required');
  });

  it('uses VITE_APP_BASE_URL when defined', () => {
    // @ts-expect-error - readonly env in tests
    import.meta.env.VITE_APP_BASE_URL = 'https://custom.example.com';

    const url = generateDeepLinkUrl('user123');
    expect(url).toBe(`https://custom.example.com${AppRoute.invite}/user123`);
  });

  it('uses window.location.origin when not localhost and env is not set', () => {
    // Ensure env var is not set
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_APP_BASE_URL;

    setWindowOrigin('https://app.example.com');

    const url = generateDeepLinkUrl('user123');
    expect(url).toBe(`https://app.example.com${AppRoute.invite}/user123`);
  });

  it('falls back to DEFAULT_PUBLIC_BASE_URL when origin is localhost', () => {
    // Ensure env var is not set
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_APP_BASE_URL;

    setWindowOrigin('http://localhost:5173');

    const url = generateDeepLinkUrl('user123');
    expect(url).toBe(`${DEFAULT_PUBLIC_BASE_URL}${AppRoute.invite}/user123`);
  });

  it('encodes userId safely in URL', () => {
    // Ensure env var is not set and origin is null to force DEFAULT_PUBLIC_BASE_URL
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_APP_BASE_URL;
    setWindowOrigin(null);

    const url = generateDeepLinkUrl('user with spaces@example.com');
    const encodedId = encodeURIComponent('user with spaces@example.com');

    expect(url).toBe(
      `${DEFAULT_PUBLIC_BASE_URL}${AppRoute.invite}/${encodedId}`
    );
  });
});
