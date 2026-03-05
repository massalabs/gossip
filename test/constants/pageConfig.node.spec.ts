import { describe, it, expect } from 'vitest';
import {
  shouldShowBottomNav,
  getPageConfig,
} from '../../src/constants/pageConfig';

describe('pageConfig', () => {
  describe('shouldShowBottomNav', () => {
    it('returns true for /discussions', () => {
      expect(shouldShowBottomNav('/discussions')).toBe(true);
    });

    it('returns true for /settings', () => {
      expect(shouldShowBottomNav('/settings')).toBe(true);
    });

    it('returns false for /discussion/:userId (chat page)', () => {
      expect(shouldShowBottomNav('/discussion/abc123')).toBe(false);
    });

    it('returns false for /settings/security (sub-page)', () => {
      expect(shouldShowBottomNav('/settings/security')).toBe(false);
    });

    it('returns false for /new-contact', () => {
      expect(shouldShowBottomNav('/new-contact')).toBe(false);
    });

    it('returns false for unknown routes', () => {
      expect(shouldShowBottomNav('/unknown')).toBe(false);
    });
  });

  describe('getPageConfig', () => {
    it('returns config with showBottomNav true for main pages', () => {
      expect(getPageConfig('/discussions').showBottomNav).toBe(true);
      expect(getPageConfig('/settings').showBottomNav).toBe(true);
    });

    it('returns config with showBottomNav false for other pages', () => {
      expect(getPageConfig('/contact/123').showBottomNav).toBe(false);
    });
  });
});
