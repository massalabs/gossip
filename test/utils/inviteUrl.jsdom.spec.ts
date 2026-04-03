import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEWEB_DEV_INVITE_DOMAIN } from '../../src/constants/links';
import { AppRoute } from '../../src/constants/routes';
import {
  buildInvitePath,
  generateDeepLinkUrl,
  toGossipInviteHref,
} from '../../src/utils/invite';
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

  it('use localhost on web when origin is localhost', () => {
    // Ensure env var is not set
    // @ts-expect-error - readonly env in tests
    delete import.meta.env.VITE_INVITE_DOMAIN;

    setWindowOrigin('http://localhost:5173');

    const url = generateDeepLinkUrl('user123');
    expect(url).toBe(`http://localhost:5173/${AppRoute.invite}/user123`);
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

  describe('username parameter', () => {
    const base = 'https://custom.example.com';

    beforeEach(() => {
      // @ts-expect-error - readonly env in tests
      import.meta.env.VITE_INVITE_DOMAIN = base;
    });

    it('omits ?name= when no username is provided', () => {
      const url = generateDeepLinkUrl('user123');
      expect(url).toBe(`${base}/${AppRoute.invite}/user123`);
      expect(url).not.toContain('?name=');
    });

    it('omits ?name= when username is undefined', () => {
      const url = generateDeepLinkUrl('user123', undefined);
      expect(url).toBe(`${base}/${AppRoute.invite}/user123`);
      expect(url).not.toContain('?name=');
    });

    it('omits ?name= when username is empty string', () => {
      const url = generateDeepLinkUrl('user123', '');
      expect(url).toBe(`${base}/${AppRoute.invite}/user123`);
      expect(url).not.toContain('?name=');
    });

    it('omits ?name= when username is only whitespace', () => {
      const url = generateDeepLinkUrl('user123', '   ');
      expect(url).toBe(`${base}/${AppRoute.invite}/user123`);
      expect(url).not.toContain('?name=');
    });

    it('includes ?name= when username is provided', () => {
      const url = generateDeepLinkUrl('user123', 'Alice');
      expect(url).toBe(`${base}/${AppRoute.invite}/user123?name=Alice`);
    });

    it('trims whitespace from username', () => {
      const url = generateDeepLinkUrl('user123', '  Alice  ');
      expect(url).toBe(`${base}/${AppRoute.invite}/user123?name=Alice`);
    });

    it('URL-encodes special characters in username', () => {
      const url = generateDeepLinkUrl('user123', 'John Doe & Friends');
      expect(url).toBe(
        `${base}/${AppRoute.invite}/user123?name=${encodeURIComponent('John Doe & Friends')}`
      );
    });

    it('URL-encodes unicode characters in username', () => {
      const url = generateDeepLinkUrl('user123', 'Héloïse 🎉');
      expect(url).toBe(
        `${base}/${AppRoute.invite}/user123?name=${encodeURIComponent('Héloïse 🎉')}`
      );
    });
  });
});

describe('inviteUrl - buildInvitePath', () => {
  it('builds path without query', () => {
    expect(buildInvitePath('gossip1abc')).toBe(
      `/${AppRoute.invite}/gossip1abc`
    );
  });

  it('appends query from URLSearchParams', () => {
    const sp = new URLSearchParams({ name: 'Alice' });
    expect(buildInvitePath('user123', sp)).toBe(
      `/${AppRoute.invite}/user123?name=Alice`
    );
  });

  it('appends query string', () => {
    expect(buildInvitePath('user123', 'name=Bob')).toBe(
      `/${AppRoute.invite}/user123?name=Bob`
    );
  });

  it('throws when userId is empty', () => {
    expect(() => buildInvitePath('')).toThrowError('userId is required');
  });
});

describe('inviteUrl - toGossipInviteHref', () => {
  it('converts invite path to gossip:// URL', () => {
    expect(toGossipInviteHref(`/${AppRoute.invite}/gossip1abc`)).toBe(
      `gossip://${AppRoute.invite}/gossip1abc`
    );
  });

  it('throws when path does not start with /', () => {
    expect(() => toGossipInviteHref('invite/foo')).toThrowError(
      'invitePath must start with /'
    );
  });
});
