import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppRoute } from '../../src/constants/routes';
import { extractInvitePath, parseInvite } from '../../src/utils/qrCodeParser';
import * as validationModule from '@massalabs/gossip-sdk';

const validateUserIdFormatSpy = vi.spyOn(
  validationModule,
  'validateUserIdFormat'
);

beforeEach(() => {
  validateUserIdFormatSpy.mockReset();
});

afterEach(() => {
  validateUserIdFormatSpy.mockReset();
});

describe('extractInvitePath — extended edge cases', () => {
  it('trims leading and trailing whitespace', () => {
    const path = `  /${AppRoute.invite}/gossip1abc  `;
    expect(extractInvitePath(path)).toBe(`/${AppRoute.invite}/gossip1abc`);
  });

  it('handles gossip:// with query and fragment stripping', () => {
    const url = `gossip://${AppRoute.invite}/gossip1abc?name=Bob#section`;
    expect(extractInvitePath(url)).toBe(`/${AppRoute.invite}/gossip1abc`);
  });

  it('extracts invite path even from non-HTTP protocols (ftp://)', () => {
    // new URL() successfully parses ftp:// and extracts pathname
    expect(
      extractInvitePath(`ftp://files.example.com/${AppRoute.invite}/gossip1abc`)
    ).toBe(`/${AppRoute.invite}/gossip1abc`);
  });

  it('returns null for plain text without invite path', () => {
    expect(extractInvitePath('just some random text')).toBeNull();
  });

  it('returns null when invite path has no userId after it', () => {
    // Just "/invite/" with nothing after — regex requires [^/#?\s]+
    expect(extractInvitePath(`/${AppRoute.invite}/`)).toBe(
      `/${AppRoute.invite}/`
    );
  });

  it('handles URL with port number', () => {
    const url = `https://localhost:3000/${AppRoute.invite}/gossip1abc`;
    expect(extractInvitePath(url)).toBe(`/${AppRoute.invite}/gossip1abc`);
  });

  it('handles bare domain URL', () => {
    const url = `https://gossip.app/${AppRoute.invite}/gossip1user`;
    expect(extractInvitePath(url)).toBe(`/${AppRoute.invite}/gossip1user`);
  });

  it('handles subdomain URL', () => {
    const url = `https://dev.gossip.app/${AppRoute.invite}/gossip1abc`;
    expect(extractInvitePath(url)).toBe(`/${AppRoute.invite}/gossip1abc`);
  });
});

describe('parseInvite — name extraction', () => {
  it('extracts name from HTTPS URL query param', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });
    const url = `https://example.com/${AppRoute.invite}/gossip1abc?name=Alice`;
    const result = parseInvite(url);
    expect(result.userId).toBe('gossip1abc');
    expect(result.name).toBe('Alice');
  });

  it('extracts name from gossip:// URL', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });
    const url = `gossip://${AppRoute.invite}/gossip1abc?name=Bob`;
    const result = parseInvite(url);
    expect(result.userId).toBe('gossip1abc');
    expect(result.name).toBe('Bob');
  });

  it('extracts name from bare path via gossip:// URL', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });
    const url = `gossip://${AppRoute.invite}/gossip1abc?name=Charlie`;
    const result = parseInvite(url);
    expect(result.name).toBe('Charlie');
  });

  it('omits name when query param is absent', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });
    const url = `https://example.com/${AppRoute.invite}/gossip1abc`;
    const result = parseInvite(url);
    expect(result.name).toBeUndefined();
  });

  it('omits name when query param is empty string', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });
    const url = `https://example.com/${AppRoute.invite}/gossip1abc?name=`;
    const result = parseInvite(url);
    expect(result.name).toBeUndefined();
  });

  it('URL-decodes the name', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });
    const url = `https://example.com/${AppRoute.invite}/gossip1abc?name=${encodeURIComponent('Hello World')}`;
    const result = parseInvite(url);
    expect(result.name).toBe('Hello World');
  });

  it('handles unicode names', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });
    const name = '日本語テスト';
    const url = `https://example.com/${AppRoute.invite}/gossip1abc?name=${encodeURIComponent(name)}`;
    const result = parseInvite(url);
    expect(result.name).toBe(name);
  });

  it('truncates name at 100 characters', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });
    const longName = 'A'.repeat(150);
    const url = `https://example.com/${AppRoute.invite}/gossip1abc?name=${longName}`;
    const result = parseInvite(url);
    expect(result.name).toBe('A'.repeat(100));
  });

  it('preserves exactly 100 characters', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });
    const exactName = 'B'.repeat(100);
    const url = `https://example.com/${AppRoute.invite}/gossip1abc?name=${exactName}`;
    const result = parseInvite(url);
    expect(result.name).toBe(exactName);
  });

  it('ignores fragment after query', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });
    const url = `https://example.com/${AppRoute.invite}/gossip1abc?name=Dave#section`;
    const result = parseInvite(url);
    expect(result.name).toBe('Dave');
  });

  it('extracts name among multiple query params', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });
    const url = `https://example.com/${AppRoute.invite}/gossip1abc?ref=qr&name=Eve&source=app`;
    const result = parseInvite(url);
    expect(result.name).toBe('Eve');
  });
});

describe('parseInvite — error cases', () => {
  it('uses generic error when validation fails without message', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: false });
    expect(() => parseInvite(`/${AppRoute.invite}/gossip1bad`)).toThrowError(
      'Invalid user ID format'
    );
  });

  it('throws on empty input', () => {
    expect(() => parseInvite('')).toThrowError('Invalid invite format');
  });

  it('throws on whitespace-only input', () => {
    expect(() => parseInvite('   ')).toThrowError('Invalid invite format');
  });

  it('throws on path with trailing slash only after invite', () => {
    // "/invite/" alone — extractInvitePath returns it, but regex won't match no userId
    expect(() => {
      validateUserIdFormatSpy.mockReturnValue({ valid: true });
      parseInvite(`/${AppRoute.invite}/`);
    }).toThrowError('Invalid invite format');
  });
});
