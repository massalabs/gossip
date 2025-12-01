import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppRoute } from '../../src/constants/routes';
import { extractInvitePath, parseInvite } from '../../src/utils/qrCodeParser';
import * as validationModule from '../../src/utils/validation';

describe('qrCodeParser - extractInvitePath', () => {
  it('returns path when given a bare invite path', () => {
    const path = `${AppRoute.invite}/gossip1abc`;
    expect(extractInvitePath(path)).toBe(path);
  });

  it('handles full HTTPS URL', () => {
    const url = `https://example.com${AppRoute.invite}/gossip1abc`;
    expect(extractInvitePath(url)).toBe(`${AppRoute.invite}/gossip1abc`);
  });

  it('handles HTTP URL', () => {
    const url = `http://example.com${AppRoute.invite}/gossip1abc`;
    expect(extractInvitePath(url)).toBe(`${AppRoute.invite}/gossip1abc`);
  });

  it('handles gossip protocol URL', () => {
    const url = `gossip://${AppRoute.invite}/gossip1abc`;
    const expectedPath = `${AppRoute.invite}/gossip1abc`;
    expect(extractInvitePath(url)).toBe(expectedPath);
  });

  it('returns null for non-invite paths', () => {
    expect(extractInvitePath('/not-invite/xyz')).toBeNull();
    expect(extractInvitePath('https://example.com/other/xyz')).toBeNull();
    expect(extractInvitePath('gossip://other/xyz')).toBeNull();
  });

  it('returns null for empty or whitespace input', () => {
    expect(extractInvitePath('')).toBeNull();
    expect(extractInvitePath('   ')).toBeNull();
  });
});

describe('qrCodeParser - parseInvite', () => {
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

  it('parses a valid invite path and validates userId', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });
    const userId = 'gossip1validuser';

    const result = parseInvite(
      `${AppRoute.invite}/${encodeURIComponent(userId)}`
    );

    expect(validateUserIdFormatSpy).toHaveBeenCalledWith(userId);
    expect(result).toEqual({ userId });
  });

  it('throws on invalid invite format (no /invite/ path)', () => {
    validateUserIdFormatSpy.mockReturnValue({ valid: true });

    expect(() => parseInvite('/not-invite/abc')).toThrowError(
      'Invalid invite format'
    );
  });

  it('throws when validation fails', () => {
    validateUserIdFormatSpy.mockReturnValue({
      valid: false,
      error: 'Invalid format — must be a valid user ID',
    });

    const userId = 'gossip1invalid';
    expect(() =>
      parseInvite(`${AppRoute.invite}/${encodeURIComponent(userId)}`)
    ).toThrowError('Invalid format — must be a valid user ID');
  });
});
