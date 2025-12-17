import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEWEB_DEV_INVITE_DOMAIN } from '../../src/constants/links';
import { AppRoute } from '../../src/constants/routes';
import { generateDeepLinkUrl } from '../../src/utils/inviteUrl';
import { defineWindowLocation, setWindowOrigin } from '../helpers/window';

describe('inviteUrl - generateDeepLinkUrl', () => {
  const originalLocation = window.location;

  const resetEnvAndLocation = () => {
    // Ensure VITE_INVITE_DOMAIN does not leak between tests
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_INVITE_DOMAIN;
    defineWindowLocation(originalLocation);
  };

  beforeEach(resetEnvAndLocation);
  afterEach(resetEnvAndLocation);

  it('throws when userId is empty or whitespace', () => {
    expect(() => generateDeepLinkUrl('')).toThrowError('userId is required');
    expect(() => generateDeepLinkUrl('   ')).toThrowError('userId is required');
  });

  it('uses VITE_INVITE_DOMAIN when defined', () => {
    const base = 'https://custom.example.com';
    const userId = 'user123';
    // @ts-expect-error - readonly env in tests
    import.meta.env.VITE_INVITE_DOMAIN = base;

    const url = generateDeepLinkUrl(userId);
    expect(url).toBe(`${base}/${AppRoute.invite}/${userId}`);
  });

  it('uses window.location.origin when not localhost and env is not set', () => {
    // Ensure env var is not set
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_INVITE_DOMAIN;

    setWindowOrigin('https://app.example.com');

    const url = generateDeepLinkUrl('user123');
    expect(url).toBe(`https://app.example.com/${AppRoute.invite}/user123`);
  });

  it('falls back to DEWEB_DEV_INVITE_DOMAIN when origin is localhost', () => {
    // Ensure env var is not set
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_INVITE_DOMAIN;

    setWindowOrigin('http://localhost:5173');

    const url = generateDeepLinkUrl('user123');
    expect(url).toBe(`${DEWEB_DEV_INVITE_DOMAIN}/${AppRoute.invite}/user123`);
  });

  it('encodes userId safely in URL', () => {
    // Ensure env var is not set and origin is null to force DEWEB_DEV_INVITE_DOMAIN
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_INVITE_DOMAIN;
    setWindowOrigin(null);

    const url = generateDeepLinkUrl('user with spaces@example.com');
    const encodedId = encodeURIComponent('user with spaces@example.com');

    expect(url).toBe(
      `${DEWEB_DEV_INVITE_DOMAIN}/${AppRoute.invite}/${encodedId}`
    );
  });
});
