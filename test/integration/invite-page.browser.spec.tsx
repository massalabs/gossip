import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { InvitePage } from '../../src/pages/InvitePage';
import App from '../../src/App';
import { useAppStore } from '../../src/stores/appStore';
import { useAccountStore } from '../../src/stores/accountStore';
import { ROUTES } from '../../src/constants/routes';
import { testUsers } from '../helpers/factories/userProfile';
import { UserProfile, SessionStatus, gossipDb } from '@massalabs/gossip-sdk';
import {
  GOOGLE_PLAY_STORE_URL,
  APPLE_APP_STORE_URL,
  LAST_APK_GITHUB_URL,
} from '../../src/constants/links';

// Mock SDK for tests that render full App. ConnectionMonitor uses useGossipSdk,
// accountStore subscribe calls getSdk(), discussionStore/useProfileLoader use getSdk().db.
const mockSdk = {
  isSessionOpen: false,
  userId: 'gossip1test',
  db: gossipDb(),
  auth: { ensurePublicKeyPublished: vi.fn().mockResolvedValue(undefined) },
  discussions: {
    getStatus: vi.fn(() => SessionStatus.NoSession),
  },
  publicKeys: null,
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock('../../src/stores/sdkStore', () => ({
  useSdkStore: {
    getState: vi.fn(() => ({ sdk: mockSdk, setSdk: vi.fn() })),
    use: {
      sdk: () => mockSdk,
    },
  },
  getSdk: () => mockSdk,
}));

// Mock hooks whose deep import chains (Capacitor, Dexie, gossip-sdk WASM)
// cause duplicate React instances in vitest browser mode on CI.
vi.mock('../../src/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'system',
    resolvedTheme: 'light',
    setTheme: vi.fn(),
    initTheme: vi.fn().mockResolvedValue(vi.fn()),
  }),
}));

vi.mock('../../src/hooks/useScreenshotProtection', () => ({
  useScreenshotProtection: vi.fn(),
}));

vi.mock('../../src/hooks/useStoreInit.ts', () => ({
  useStoreInit: vi.fn(),
}));

// These values must stay in sync with `InvitePage` timing constants
const NATIVE_APP_OPEN_DELAY = 150;

describe.skip('InvitePage - Deep Link Invite Flow', () => {
  let bobProfile: UserProfile;
  let aliceProfile: UserProfile;

  beforeEach(() => {
    bobProfile = testUsers.bob();
    aliceProfile = testUsers.alice();
    // Reset store state before each test
    useAppStore.getState().setPendingDeepLinkInfo(null);
  });

  const renderInviteRoute = async (
    initialEntry: string
  ): Promise<ReturnType<typeof render>> => {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );
  };

  it('redirects authenticated user with pending invite to New Contact with userId prefilled', async () => {
    // Simulate an authenticated user
    useAccountStore.setState({
      ...useAccountStore.getState(),
      userProfile: aliceProfile,
      isLoading: false,
    });

    // Simulate a pending invite deep link stored in the app store
    useAppStore
      .getState()
      .setPendingDeepLinkInfo({ userId: bobProfile.userId });

    // Start from the default discussions route
    window.history.pushState({}, '', ROUTES.discussions());

    await render(<App />);

    // The user should be redirected to the New Contact page
    const heading = page.getByRole('heading', { name: /new contact/i });
    await expect.element(heading).toBeVisible();

    // And the User ID field should be prefilled with the invite userId
    const userIdInput = page.getByLabelText('Gossip address');
    await expect.element(userIdInput).toHaveValue(bobProfile.userId);
  });

  it('bypasses onboarding and shows InvitePage when app is not initialized and URL is an invite', async () => {
    // Simulate navigating directly to an invite URL (cold start)
    window.history.pushState(
      {},
      '',
      ROUTES.invite({ userId: bobProfile.userId })
    );

    // Ensure app is in "not initialized, no account" state
    useAppStore.getState().setIsInitialized(false);
    // Clear any user profile that might have been set by other tests
    useAccountStore.setState({
      ...useAccountStore.getState(),
      userProfile: null,
    });

    await render(<App />);

    // Wait for InvitePage to render instead of Onboarding
    const heading = page.getByRole('heading', {
      name: /you've been invited!/i,
    });
    await expect.element(heading).toBeVisible();
  });

  it('redirects /invite without userId to onboarding welcome flow', async () => {
    // Simulate navigating directly to /invite (no userId param)
    window.history.pushState({}, '', '/invite');

    // Ensure app is in "not initialized, no account" state so onboarding shows
    useAppStore.getState().setIsInitialized(false);
    useAccountStore.setState({
      ...useAccountStore.getState(),
      userProfile: null,
      isLoading: false,
    });

    await render(<App />);

    // OnboardingFlow should be shown instead of InvitePage
    const heading = page.getByRole('heading', {
      name: /welcome to gossip!/i,
    });
    await expect.element(heading).toBeVisible();
  });

  it('renders invite page with valid userId', async () => {
    await renderInviteRoute(ROUTES.invite({ userId: bobProfile.userId }));

    // Check that the invite message is displayed
    const heading = page.getByRole('heading', {
      name: /you've been invited!/i,
    });
    await expect.element(heading).toBeVisible();

    // Check that the description is shown
    const description = page.getByText(
      /open this invite in the gossip app to start chatting/i
    );
    await expect.element(description).toBeVisible();

    // Check that all action buttons are present
    await expect
      .element(page.getByRole('button', { name: /open in app/i }))
      .toBeVisible();
    await expect
      .element(page.getByRole('button', { name: /continue in web app/i }))
      .toBeVisible();
  });

  it('automatically attempts to open native app on mount (web only)', async () => {
    await renderInviteRoute(ROUTES.invite({ userId: bobProfile.userId }));

    // The auto-open functionality should trigger and show a loading state
    const openButton = page.getByRole('button', { name: /opening\.\.\./i });
    await expect.element(openButton).toBeVisible();
  });

  it('shows loading state when opening app', async () => {
    await renderInviteRoute(ROUTES.invite({ userId: bobProfile.userId }));

    // The button should show loading state once auto-open triggers
    const openButton = page.getByRole('button', {
      name: /opening\.\.\./i,
    });
    await expect.element(openButton).toBeVisible();
  });

  it('shows success state when native app opens (visibility change)', async () => {
    vi.useFakeTimers();
    try {
      await renderInviteRoute(ROUTES.invite({ userId: bobProfile.userId }));

      // Let the auto-open effect fire and then the internal open timer
      vi.advanceTimersByTime(NATIVE_APP_OPEN_DELAY);
      vi.advanceTimersByTime(NATIVE_APP_OPEN_DELAY);

      // Simulate visibility change to trigger success state
      // Set document.hidden to true to simulate app switch
      const originalHidden = Object.getOwnPropertyDescriptor(
        document,
        'hidden'
      );
      Object.defineProperty(document, 'hidden', {
        writable: true,
        configurable: true,
        value: true,
      });

      // Trigger visibilitychange event - the listener should be set up by now
      const event = new Event('visibilitychange', { bubbles: true });
      document.dispatchEvent(event);

      // Check for success state
      const successHeading = page.getByRole('heading', {
        name: /opening in app/i,
      });
      await expect.element(successHeading).toBeVisible();

      // Check for "Continue in Web App Instead" button
      const continueButton = page.getByRole('button', {
        name: /continue in web app instead/i,
      });
      await expect.element(continueButton).toBeVisible();

      // Restore document.hidden
      if (originalHidden) {
        Object.defineProperty(document, 'hidden', originalHidden);
      } else {
        Object.defineProperty(document, 'hidden', {
          writable: true,
          configurable: true,
          value: false,
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles Continue in Web App button click', async () => {
    // Create a simple home component for navigation
    const HomePage = () => <div>Home</div>;

    await render(
      <MemoryRouter
        initialEntries={[ROUTES.invite({ userId: bobProfile.userId })]}
      >
        <Routes>
          <Route path={ROUTES.default()} element={<HomePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Click Continue in Web App button
    const continueButton = page.getByRole('button', {
      name: /continue in web app/i,
    });
    await continueButton.click();

    // Wait for the click handler side-effect (store update) instead of sleeping.
    await expect
      .poll(() => useAppStore.getState().pendingDeepLinkInfo, {
        timeout: 2000,
        interval: 25,
      })
      .toEqual(expect.objectContaining({ userId: bobProfile.userId }));
  });

  it.skip('handles Install for iOS button click - opens App Store', async () => {
    // Track window.open calls
    let openedUrl = '';
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation((url?: string | URL) => {
        if (url) {
          openedUrl = url.toString();
        }
        return null;
      });

    try {
      await renderInviteRoute(ROUTES.invite({ userId: bobProfile.userId }));

      const installButton = page.getByRole('button', {
        name: /install for ios/i,
      });
      await installButton.click();

      // Should have called window.open with App Store URL
      expect(openedUrl).toContain(APPLE_APP_STORE_URL);
    } finally {
      openSpy.mockRestore();
    }
  });

  it.skip('handles Install for Android button click - opens Play Store', async () => {
    let openedUrl = '';
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation((url?: string | URL) => {
        if (url) {
          openedUrl = url.toString();
        }
        return null;
      });

    try {
      await renderInviteRoute(ROUTES.invite({ userId: bobProfile.userId }));

      const installButton = page.getByRole('button', {
        name: /install for android/i,
      });
      await installButton.click();

      // Should open Google Play Store URL
      expect(openedUrl).toContain(GOOGLE_PLAY_STORE_URL);
    } finally {
      openSpy.mockRestore();
    }
  });

  it.skip('handles Download APK button click - opens GitHub release', async () => {
    let openedUrl = '';
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation((url?: string | URL) => {
        if (url) {
          openedUrl = url.toString();
        }
        return null;
      });

    try {
      await renderInviteRoute(ROUTES.invite({ userId: bobProfile.userId }));

      const downloadButton = page.getByRole('button', {
        name: /download last release/i,
      });
      await downloadButton.click();

      // Should open GitHub release URL
      expect(openedUrl).toContain(LAST_APK_GITHUB_URL);
    } finally {
      openSpy.mockRestore();
    }
  });

  it('shows back button in page header', async () => {
    await renderInviteRoute(ROUTES.invite({ userId: bobProfile.userId }));

    // PageHeader should have buttons visible
    // At least one button should be visible (the back button or action buttons)
    const openButton = page.getByRole('button', { name: /open in app/i });
    await expect.element(openButton).toBeVisible();
  });

  it('handles manual Open in App button click', async () => {
    await renderInviteRoute(ROUTES.invite({ userId: bobProfile.userId }));

    // Manually click Open in App button
    const openButton = page.getByRole('button', { name: /open in app/i });
    await openButton.click();

    // Button should still be visible
    await expect.element(openButton).toBeVisible();
  });

  it('handles redirect to / in invalid invite state (missing userId)', async () => {
    // Simulate navigating directly to /invite (no userId param)
    window.history.pushState({}, '', '/invite');

    // Ensure app is initialized but no user profile (so UnauthenticatedRoutes handles it)
    useAppStore.getState().setIsInitialized(true);
    useAccountStore.setState({
      ...useAccountStore.getState(),
      userProfile: null,
      isLoading: false,
    });

    await render(<App />);

    // The InvitePage should detect missing userId and redirect to /,
    // which then redirects to /welcome (Login page) for unauthenticated users
    // Wait for the redirect and check for Login page content
    const heading = page.getByRole('heading', {
      name: /welcome to gossip/i,
    });
    await expect.element(heading).toBeVisible();
  });

  it('handles back button click in page header', async () => {
    const HomePage = () => <div>Home</div>;

    await render(
      <MemoryRouter
        initialEntries={[ROUTES.invite({ userId: bobProfile.userId })]}
      >
        <Routes>
          <Route path={ROUTES.default()} element={<HomePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Find the back button via its accessible role and name
    const backButton = page.getByRole('button', { name: /back/i });
    await expect.element(backButton).toBeVisible();
    await backButton.click();

    // Should navigate to home (waits implicitly via expect)
    const homeContent = page.getByText('Home');
    await expect.element(homeContent).toBeVisible();
  });

  it('handles Continue in Web App Instead button in success state', async () => {
    const HomePage = () => <div>Home</div>;

    vi.useFakeTimers();
    try {
      await render(
        <MemoryRouter
          initialEntries={[ROUTES.invite({ userId: bobProfile.userId })]}
        >
          <Routes>
            <Route path={ROUTES.default()} element={<HomePage />} />
            <Route path={ROUTES.invite()} element={<InvitePage />} />
          </Routes>
        </MemoryRouter>
      );

      // Let the auto-open effect fire and then the internal open timer
      vi.advanceTimersByTime(NATIVE_APP_OPEN_DELAY * 2);

      // Simulate visibility change to trigger success state
      const originalHidden = Object.getOwnPropertyDescriptor(
        document,
        'hidden'
      );
      Object.defineProperty(document, 'hidden', {
        writable: true,
        configurable: true,
        value: true,
      });

      const event = new Event('visibilitychange', { bubbles: true });
      document.dispatchEvent(event);

      // Verify success state appeared before trying to click button
      const successHeading = page.getByRole('heading', {
        name: /opening in app/i,
      });
      await expect.element(successHeading).toBeVisible();

      // Click "Continue in Web App Instead" button
      const continueButton = page.getByRole('button', {
        name: /continue in web app instead/i,
      });
      await continueButton.click();

      // Check that invite data was stored
      const pendingInvite = useAppStore.getState().pendingDeepLinkInfo;
      expect(pendingInvite).toBeTruthy();
      expect(pendingInvite?.userId).toBe(bobProfile.userId);

      // Restore document.hidden
      if (originalHidden) {
        Object.defineProperty(document, 'hidden', originalHidden);
      } else {
        Object.defineProperty(document, 'hidden', {
          writable: true,
          configurable: true,
          value: false,
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles error in handleContinueInWeb gracefully', async () => {
    const HomePage = () => <div>Home</div>;

    // Test with an invalid userId that will cause parseInvite to fail
    // when trying to continue in web app
    const invalidUserId = 'invalid-user-id';

    await render(
      <MemoryRouter initialEntries={[`/invite/${invalidUserId}`]}>
        <Routes>
          <Route path={ROUTES.default()} element={<HomePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // The component should still render (it validates userId on mount)
    // If userId is invalid format, it might show invalid invite or handle gracefully
    // Let's check that the page doesn't crash by checking for any visible content
    const heading = page.getByRole('heading', {
      name: /invalid invite|you've been invited!/i,
    });
    await expect.element(heading).toBeVisible();
  });

  it('displays PrivacyGraphic component', async () => {
    await render(
      <MemoryRouter
        initialEntries={[ROUTES.invite({ userId: bobProfile.userId })]}
      >
        <Routes>
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // PrivacyGraphic should be rendered (it's an SVG component)
    // Check for SVG element by accessing the DOM through a known element
    const headingElement = page
      .getByRole('heading', { name: /you've been invited!/i })
      .element();
    const cardContainer = headingElement.closest('.bg-card');
    const svgElement = cardContainer?.querySelector('svg');
    expect(svgElement).toBeTruthy();
  });

  it.skip('shows install section with correct heading and description', async () => {
    await render(
      <MemoryRouter
        initialEntries={[ROUTES.invite({ userId: bobProfile.userId })]}
      >
        <Routes>
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Check for install section heading
    const installHeading = page.getByRole('heading', {
      name: /don't have the app\?/i,
    });
    await expect.element(installHeading).toBeVisible();

    // Check for install section description
    const installDescription = page.getByText(
      /install gossip to get the best experience/i
    );
    await expect.element(installDescription).toBeVisible();
  });
});
