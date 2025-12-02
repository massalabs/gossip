import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_PUBLIC_BASE_URL } from '../../src/constants/links';
import { AppRoute } from '../../src/constants/routes';
import { generateDeepLinkUrl } from '../../src/utils/inviteUrl';
import { defineWindowLocation, setWindowOrigin } from '../helpers/window';

describe('inviteUrl - generateDeepLinkUrl', () => {
  const originalLocation = window.location;

  const resetEnvAndLocation = () => {
    // Ensure VITE_APP_BASE_URL does not leak between tests
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_APP_BASE_URL;
    defineWindowLocation(originalLocation);
  };

  beforeEach(resetEnvAndLocation);
  afterEach(resetEnvAndLocation);

  it('throws when userId is empty or whitespace', () => {
    expect(() => generateDeepLinkUrl('')).toThrowError('userId is required');
    expect(() => generateDeepLinkUrl('   ')).toThrowError('userId is required');
  });

  it('uses VITE_APP_BASE_URL when defined', () => {
    const base = 'https://custom.example.com';
    const userId = 'user123';
    // @ts-expect-error - readonly env in tests
    import.meta.env.VITE_APP_BASE_URL = base;

    const url = generateDeepLinkUrl(userId);
    expect(url).toBe(`${base}/${AppRoute.invite}/${userId}`);
  });

  it('uses window.location.origin when not localhost and env is not set', () => {
    // Ensure env var is not set
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_APP_BASE_URL;

    setWindowOrigin('https://app.example.com');

    const url = generateDeepLinkUrl('user123');
    expect(url).toBe(`https://app.example.com/${AppRoute.invite}/user123`);
  });

  it('falls back to DEFAULT_PUBLIC_BASE_URL when origin is localhost', () => {
    // Ensure env var is not set
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_APP_BASE_URL;

    setWindowOrigin('http://localhost:5173');

    const url = generateDeepLinkUrl('user123');
    expect(url).toBe(`${DEFAULT_PUBLIC_BASE_URL}/${AppRoute.invite}/user123`);
  });

  it('encodes userId safely in URL', () => {
    // Ensure env var is not set and origin is null to force DEFAULT_PUBLIC_BASE_URL
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_APP_BASE_URL;
    setWindowOrigin(null);

    const url = generateDeepLinkUrl('user with spaces@example.com');
    const encodedId = encodeURIComponent('user with spaces@example.com');

    expect(url).toBe(
      `${DEFAULT_PUBLIC_BASE_URL}/${AppRoute.invite}/${encodedId}`
    );
  });
});
