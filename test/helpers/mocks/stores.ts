/**
 * Store Mocks for Testing
 *
 * Provides factory functions for mocking Zustand stores.
 * These helpers reduce duplication when setting up store state in tests.
 *
 * Usage with vi.mock():
 * ```ts
 * vi.mock('../../stores/accountStore', () => ({
 *   useAccountStore: vi.fn(() => mockAccountStore({ userProfile: null }))
 * }));
 * ```
 *
 * Or for dynamic mocking in tests:
 * ```ts
 * vi.mocked(useAccountStore).mockReturnValue(mockAccountStore({ isLoading: true }));
 * ```
 */

import { vi } from 'vitest';
import type { UserProfile } from '../../../src/db';

/**
 * Mock user profile for authenticated state
 * Uses factory to ensure schema compliance
 */

/**
 * Mock invite data for deep links
 */
export const createMockInviteData = (overrides?: {
  name?: string;
  userId?: string;
  publicKey?: Uint8Array;
}) => ({
  name: overrides?.name || 'Alice',
  userId: overrides?.userId || 'AU12alice...',
  publicKey: overrides?.publicKey || new Uint8Array(32),
});

/**
 * Create mock account store state
 * Returns a complete mock of the account store with sensible defaults
 */
export const mockAccountStore = (state?: {
  userProfile?: UserProfile | null;
  isLoading?: boolean;
  hasExistingAccount?: () => Promise<boolean>;
}) => {
  const { userProfile = null, isLoading = false } = state || {};

  return {
    userProfile,
    isLoading,
    setUserProfile: vi.fn(),
    clearUserProfile: vi.fn(),
    hasExistingAccount:
      state?.hasExistingAccount || vi.fn().mockResolvedValue(false),
  };
};

/**
 * Create mock app store state
 * Returns a complete mock of the app store with sensible defaults
 */
export const mockAppStore = (state?: {
  isInitialized?: boolean;
  pendingDeepLinkInfo?: unknown;
}) => {
  const { isInitialized = true, pendingDeepLinkInfo = null } = state || {};

  return {
    isInitialized,
    pendingDeepLinkInfo,
    setIsInitialized: vi.fn(),
    setPendingDeepLinkInfo: vi.fn(),
  };
};

/**
 * Create mock discussion store state
 * Returns a complete mock of the discussion store with sensible defaults
 */
export const mockDiscussionStore = (state?: {
  contacts?: unknown[];
  discussions?: unknown[];
}) => {
  const { contacts = [], discussions = [] } = state || {};

  return {
    contacts,
    discussions,
    loadContacts: vi.fn(),
    loadDiscussions: vi.fn(),
  };
};

/**
 * Setup authenticated user state
 * Convenience helper to mock a logged-in user
 */
export const mockAuthenticatedUser = (userProfile?: UserProfile) => {
  return {
    accountStore: mockAccountStore({
      userProfile: userProfile,
      isLoading: false,
    }),
    appStore: mockAppStore({
      isInitialized: true,
      pendingDeepLinkInfo: null,
    }),
  };
};

/**
 * Setup unauthenticated state
 * Convenience helper to mock a logged-out user
 */
export const mockUnauthenticatedUser = () => {
  return {
    accountStore: mockAccountStore({
      userProfile: null,
      isLoading: false,
    }),
    appStore: mockAppStore({
      isInitialized: true,
      pendingDeepLinkInfo: null,
    }),
  };
};

/**
 * Setup onboarding state
 * Convenience helper for first-time user
 */
export const mockOnboardingState = () => {
  return {
    accountStore: mockAccountStore({
      userProfile: null,
      isLoading: false,
    }),
    appStore: mockAppStore({
      isInitialized: false,
      pendingDeepLinkInfo: null,
    }),
  };
};

/**
 * Setup state with pending deep link
 */
export const mockPendingDeepLinkState = (
  inviteData?: ReturnType<typeof createMockInviteData>
) => {
  return {
    accountStore: mockAccountStore({
      userProfile: null,
      isLoading: false,
    }),
    appStore: mockAppStore({
      isInitialized: true,
      pendingDeepLinkInfo: inviteData || createMockInviteData(),
    }),
  };
};
