/**
 * Battle Tests for Route Constants
 *
 * Comprehensive tests for the route() helper function and route utilities
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ROUTES } from '../../src/constants/routes';

describe('Route Function - Static Routes', () => {
  it('should return pattern when called without params', () => {
    expect(ROUTES.discussions()).toBe('/');
    expect(ROUTES.settings()).toBe('/settings');
    expect(ROUTES.newContact()).toBe('/new-contact');
    expect(ROUTES.welcome()).toBe('/welcome');
  });

  it('should not have path or pattern properties (use function call instead)', () => {
    expect(ROUTES.discussions).not.toHaveProperty('path');
    expect(ROUTES.discussions).not.toHaveProperty('pattern');
    expect(ROUTES.settings).not.toHaveProperty('path');
    expect(ROUTES.welcome).not.toHaveProperty('path');
  });

  it('should ignore params object for static routes', () => {
    expect(ROUTES.discussions({ foo: 'bar' })).toBe('/');
    expect(ROUTES.settings({ id: '123' })).toBe('/settings');
  });
});

describe('Route Function - Dynamic Routes (Single Param)', () => {
  it('should return pattern when called without params', () => {
    expect(ROUTES.contact()).toBe('/contact/:userId');
    expect(ROUTES.discussion()).toBe('/discussion/:userId');
  });

  it('should replace param with value', () => {
    expect(ROUTES.contact({ userId: 'alice123' })).toBe('/contact/alice123');
    expect(ROUTES.discussion({ userId: 'bob456' })).toBe('/discussion/bob456');
  });

  it('should return pattern when called without params', () => {
    expect(ROUTES.contact()).toBe('/contact/:userId');
    expect(ROUTES.discussion()).toBe('/discussion/:userId');
  });

  it('should handle numeric param values', () => {
    expect(ROUTES.contact({ userId: 12345 })).toBe('/contact/12345');
  });

  it('should handle empty string param', () => {
    expect(ROUTES.contact({ userId: '' })).toBe('/contact/');
  });

  it('should URL-encode special characters', () => {
    expect(ROUTES.contact({ userId: 'user@example.com' })).toBe(
      '/contact/user%40example.com'
    );

    expect(ROUTES.contact({ userId: 'hello world' })).toBe(
      '/contact/hello%20world'
    );

    expect(ROUTES.contact({ userId: 'user/with/slashes' })).toBe(
      '/contact/user%2Fwith%2Fslashes'
    );
  });
});

describe('Route Function - Dynamic Routes (Multiple Params)', () => {
  it('should return pattern when called without params', () => {
    expect(ROUTES.discussionSettings()).toBe(
      '/discussion/:discussionId/settings'
    );
  });

  it('should replace param with value', () => {
    expect(ROUTES.discussionSettings({ discussionId: '789' })).toBe(
      '/discussion/789/settings'
    );
  });
});

describe('Route Function - Missing Params', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('should warn when params are missing in non-production', () => {
    // In test environment, warnings should show (NODE_ENV !== 'production')
    consoleWarnSpy.mockClear();
    ROUTES.contact({});

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[routes] Missing required params for /contact/:userId: userId'
    );
  });

  it('should not warn in production', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    ROUTES.contact({});

    expect(consoleWarnSpy).not.toHaveBeenCalled();

    process.env.NODE_ENV = originalEnv;
  });

  it('should return pattern with unreplaced params when missing', () => {
    const result = ROUTES.contact({});
    expect(result).toBe('/contact/:userId');
  });

  it('should warn about null params', () => {
    consoleWarnSpy.mockClear();
    ROUTES.contact({ userId: null as unknown as string });

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[routes] Missing required params for /contact/:userId: userId'
    );
  });

  it('should warn about undefined params', () => {
    consoleWarnSpy.mockClear();
    ROUTES.contact({ userId: undefined as unknown as string });

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[routes] Missing required params for /contact/:userId: userId'
    );
  });
});

describe('Route Constants - Consistency', () => {
  it('ROUTES should have all expected routes', () => {
    expect(ROUTES).toHaveProperty('discussions');
    expect(ROUTES).toHaveProperty('wallet');
    expect(ROUTES).toHaveProperty('settings');
    expect(ROUTES).toHaveProperty('newContact');
    expect(ROUTES).toHaveProperty('newDiscussion');
    expect(ROUTES).toHaveProperty('contact');
    expect(ROUTES).toHaveProperty('discussion');
    expect(ROUTES).toHaveProperty('discussionSettings');
    expect(ROUTES).toHaveProperty('default');
  });

  it('ROUTES should have all expected routes', () => {
    expect(ROUTES).toHaveProperty('welcome');
    expect(ROUTES).toHaveProperty('setup');
    expect(ROUTES).toHaveProperty('default');
  });

  it('all routes should be functions', () => {
    expect(typeof ROUTES.discussions).toBe('function');
    expect(typeof ROUTES.contact).toBe('function');
    expect(typeof ROUTES.welcome).toBe('function');
  });

  it('should use function call for consistency', () => {
    expect(ROUTES.discussions()).toBe('/');
    expect(ROUTES.contact()).toBe('/contact/:userId');
    expect(ROUTES.welcome()).toBe('/welcome');
  });

  it('default routes should exist and be valid', () => {
    expect(ROUTES.default()).toBe('/');
  });
});

describe('Route Function - Real-world Scenarios', () => {
  it('should handle navigation flow: discussions -> contact -> back', () => {
    const discussionsPath = ROUTES.discussions();
    const contactPath = ROUTES.contact({ userId: 'alice' });

    expect(discussionsPath).toBe('/');
    expect(contactPath).toBe('/contact/alice');
  });

  it('should handle complex navigation: discussion -> discussion settings', () => {
    const userId = 'bob123';
    const discussionPath = ROUTES.discussion({ userId });
    const settingsPath = ROUTES.discussionSettings({
      discussionId: userId,
    });

    expect(discussionPath).toBe('/discussion/bob123');
    expect(settingsPath).toBe('/discussion/bob123/settings');
  });

  it('should handle unauthenticated -> authenticated flow', () => {
    const welcomePath = ROUTES.welcome();
    const setupPath = ROUTES.setup();
    const homePath = ROUTES.discussions();

    expect(welcomePath).toBe('/welcome');
    expect(setupPath).toBe('/setup');
    expect(homePath).toBe('/');
  });

  it('should handle multiple users in same session', () => {
    const alice = ROUTES.contact({ userId: 'alice' });
    const bob = ROUTES.contact({ userId: 'bob' });
    const charlie = ROUTES.discussion({ userId: 'charlie' });

    expect(alice).toBe('/contact/alice');
    expect(bob).toBe('/contact/bob');
    expect(charlie).toBe('/discussion/charlie');
  });

  it('should handle userId with Massa address format', () => {
    const massaAddress = 'AU12alice123456789';
    const path = ROUTES.contact({ userId: massaAddress });

    expect(path).toBe('/contact/AU12alice123456789');
  });
});
