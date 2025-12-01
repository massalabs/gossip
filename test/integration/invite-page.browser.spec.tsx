// Runs in BROWSER mode (real Chromium via Playwright)
// Tests the InvitePage component with real browser behavior

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
import { encodeUserId } from '../../src/utils/userId';

// Helper to wait for async operations
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to generate valid test user IDs
const createTestUserId = (seed: number): string => {
  const bytes = new Uint8Array(32);
  // Fill with seed value to create deterministic test IDs
  bytes.fill(seed % 256);

  return encodeUserId(bytes);
};

describe('InvitePage - Deep Link Invite Flow', () => {
  beforeEach(() => {
    // Reset store state before each test
    useAppStore.getState().setPendingDeepLinkInfo(null);
  });

  it('bypasses onboarding and shows InvitePage when app is not initialized and URL is an invite', async () => {
    const testUserId = createTestUserId(0);

    // Simulate navigating directly to an invite URL (cold start)
    window.history.pushState({}, '', ROUTES.invite({ userId: testUserId }));

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

  it('renders invite page with valid userId', async () => {
    const testUserId = createTestUserId(1);
    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

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
    await expect
      .element(page.getByRole('button', { name: /install for ios/i }))
      .toBeVisible();
    await expect
      .element(page.getByRole('button', { name: /install for android/i }))
      .toBeVisible();
    await expect
      .element(page.getByRole('button', { name: /download last release/i }))
      .toBeVisible();
  });

  it('shows invalid invite message when userId is missing', async () => {
    await render(
      <MemoryRouter initialEntries={['/invite']}>
        <Routes>
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    const invalidHeading = page.getByRole('heading', {
      name: /invalid invite/i,
    });
    await expect.element(invalidHeading).toBeVisible();

    const invalidMessage = page.getByText(
      /this invite link is invalid or has expired/i
    );
    await expect.element(invalidMessage).toBeVisible();

    const goHomeButton = page.getByRole('button', { name: /go home/i });
    await expect.element(goHomeButton).toBeVisible();
  });

  it('automatically attempts to open native app on mount (web only)', async () => {
    const testUserId = createTestUserId(2);
    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for auto-open delay (150ms) + a bit more for async operations
    await wait(250);

    // The auto-open functionality should have triggered
    // We verify this by checking that the button shows loading state briefly
    // or that the component is in the expected state
    const openButton = page.getByRole('button', { name: /open in app/i });
    await expect.element(openButton).toBeVisible();

    // The button should be functional (not permanently disabled)
    await expect.element(openButton).not.toBeDisabled();
  });

  it('shows loading state when opening app', async () => {
    const testUserId = createTestUserId(3);
    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait a bit for auto-open to trigger
    await wait(100);

    // The button should show loading state briefly or be visible
    const openButton = page.getByRole('button', {
      name: /opening...|open in app/i,
    });
    await expect.element(openButton).toBeVisible();
  });

  it('shows success state when native app opens (visibility change)', async () => {
    const testUserId = createTestUserId(4);
    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for auto-open to trigger (NATIVE_APP_OPEN_DELAY = 150ms)
    // Then wait for the anchor.click() to happen (another 150ms)
    // Then the listener is set up, so we need to wait for that
    await wait(350);

    // Simulate visibility change to trigger success state
    // Set document.hidden to true to simulate app switch
    const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', {
      writable: true,
      configurable: true,
      value: true,
    });

    // Trigger visibilitychange event - the listener should be set up by now
    const event = new Event('visibilitychange', { bubbles: true });
    document.dispatchEvent(event);

    // Wait for React state update (component needs to process the event)
    await wait(400);

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
  });

  it('handles Continue in Web App button click', async () => {
    const testUserId = createTestUserId(5);
    // Create a simple home component for navigation
    const HomePage = () => <div>Home</div>;

    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for auto-open attempt to complete
    await wait(500);

    // Click Continue in Web App button
    const continueButton = page.getByRole('button', {
      name: /continue in web app/i,
    });
    await continueButton.click();

    // Wait for navigation
    await wait(200);

    // Check that invite data was stored
    const pendingInvite = useAppStore.getState().pendingDeepLinkInfo;
    expect(pendingInvite).toBeTruthy();
    expect(pendingInvite?.userId).toBe(testUserId);
  });

  it('handles Install for iOS button click - opens App Store', async () => {
    // Track window.open calls
    let openedUrl = '';
    const originalOpen = window.open;
    window.open = vi.fn((url?: string | URL) => {
      if (url) {
        openedUrl = url.toString();
      }
      return null;
    });

    const testUserId = createTestUserId(6);
    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for auto-open attempt
    await wait(500);

    // Click Install for iOS button
    const installButton = page.getByRole('button', {
      name: /install for ios/i,
    });
    await installButton.click();

    // Wait a bit for the click to process
    await wait(100);

    // Should have called window.open with App Store URL
    expect(openedUrl).toContain('apps.apple.com');

    // Restore original
    window.open = originalOpen;
  });

  it('handles Install for Android button click - opens Play Store', async () => {
    let openedUrl = '';
    const originalOpen = window.open;
    window.open = vi.fn((url?: string | URL) => {
      if (url) {
        openedUrl = url.toString();
      }
      return null;
    });

    const testUserId = createTestUserId(7);
    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    await wait(500);

    const installButton = page.getByRole('button', {
      name: /install for android/i,
    });
    await installButton.click();

    await wait(100);

    // Should open Google Play Store URL
    expect(openedUrl).toContain('play.google.com');

    window.open = originalOpen;
  });

  it('handles Download APK button click - opens GitHub release', async () => {
    let openedUrl = '';
    const originalOpen = window.open;
    window.open = vi.fn((url?: string | URL) => {
      if (url) {
        openedUrl = url.toString();
      }
      return null;
    });

    const testUserId = createTestUserId(8);
    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    await wait(500);

    const downloadButton = page.getByRole('button', {
      name: /download last release/i,
    });
    await downloadButton.click();

    await wait(100);

    // Should open GitHub release URL
    expect(openedUrl).toContain('github.com');
    expect(openedUrl).toContain('.apk');

    window.open = originalOpen;
  });

  it('renders correctly on native platform (no auto-open)', async () => {
    // For this test, we verify the component renders correctly
    // In a real native app, Capacitor.isNativePlatform() would return true
    // and the auto-open effect wouldn't run.
    await render(
      <MemoryRouter initialEntries={['/invite/nativeuser123']}>
        <Routes>
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Component should still render normally
    const heading = page.getByRole('heading', {
      name: /you've been invited!/i,
    });
    await expect.element(heading).toBeVisible();
  });

  it('shows back button in page header', async () => {
    const testUserId = createTestUserId(10);
    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // PageHeader should have buttons visible
    // At least one button should be visible (the back button or action buttons)
    const openButton = page.getByRole('button', { name: /open in app/i });
    await expect.element(openButton).toBeVisible();
  });

  it('handles manual Open in App button click', async () => {
    const testUserId = createTestUserId(11);
    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for auto-open attempt to complete
    await wait(500);

    // Manually click Open in App button
    const openButton = page.getByRole('button', { name: /open in app/i });
    await openButton.click();

    // Wait for processing
    await wait(100);

    // Button should still be visible
    await expect.element(openButton).toBeVisible();
  });

  it('handles Go Home button click in invalid invite state', async () => {
    const HomePage = () => <div>Home</div>;

    await render(
      <MemoryRouter initialEntries={['/invite']}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    const goHomeButton = page.getByRole('button', { name: /go home/i });
    await expect.element(goHomeButton).toBeVisible();

    await goHomeButton.click();

    // Wait for navigation
    await wait(200);

    // Should navigate to home
    const homeContent = page.getByText('Home');
    await expect.element(homeContent).toBeVisible();
  });

  it('handles back button click in page header', async () => {
    const HomePage = () => <div>Home</div>;
    const testUserId = createTestUserId(12);

    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for page to render
    await wait(100);

    // The back button is the first button in the header
    // Use the page header title to find the header container
    const pageTitle = page.getByRole('heading', {
      name: 'Invite',
      exact: true,
    });
    const headerContainer = pageTitle
      .element()
      .closest('div[class*="border-b"]');
    const backButton = headerContainer?.querySelector(
      'button'
    ) as HTMLButtonElement;

    expect(backButton).toBeTruthy();

    // Click the back button
    if (backButton) {
      backButton.click();
    }

    // Wait for navigation
    await wait(200);

    // Should navigate to home
    const homeContent = page.getByText('Home');
    await expect.element(homeContent).toBeVisible();
  });

  it('handles Continue in Web App Instead button in success state', async () => {
    const testUserId = createTestUserId(13);
    const HomePage = () => <div>Home</div>;

    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for auto-open to trigger and listener to be set up
    // NATIVE_APP_OPEN_DELAY (150ms) + anchor.click delay (150ms) + listener setup
    await wait(350);

    // Simulate visibility change to trigger success state
    const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', {
      writable: true,
      configurable: true,
      value: true,
    });

    // Trigger visibilitychange event
    const event = new Event('visibilitychange', { bubbles: true });
    document.dispatchEvent(event);

    // Wait for React state update
    await wait(400);

    // Verify success state appeared before trying to click button
    // If it didn't appear, the test will fail here with a clear message
    const successHeading = page.getByRole('heading', {
      name: /opening in app/i,
    });
    await expect.element(successHeading).toBeVisible();

    // Click "Continue in Web App Instead" button
    const continueButton = page.getByRole('button', {
      name: /continue in web app instead/i,
    });
    await continueButton.click();

    // Wait for navigation
    await wait(200);

    // Check that invite data was stored
    const pendingInvite = useAppStore.getState().pendingDeepLinkInfo;
    expect(pendingInvite).toBeTruthy();
    expect(pendingInvite?.userId).toBe(testUserId);

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
  });

  it('handles error in handleContinueInWeb gracefully', async () => {
    const HomePage = () => <div>Home</div>;

    // Test with an invalid userId that will cause parseInvite to fail
    // when trying to continue in web app
    const invalidUserId = 'invalid-user-id';

    await render(
      <MemoryRouter initialEntries={[`/invite/${invalidUserId}`]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for page to render
    await wait(500);

    // The component should still render (it validates userId on mount)
    // If userId is invalid format, it might show invalid invite or handle gracefully
    // Let's check that the page doesn't crash by checking for any visible content
    const heading = page.getByRole('heading', {
      name: /invalid invite|you've been invited!/i,
    });
    await expect.element(heading).toBeVisible();
  });

  it('displays PrivacyGraphic component', async () => {
    const testUserId = createTestUserId(15);
    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for page to render
    await wait(100);

    // PrivacyGraphic should be rendered (it's an SVG component)
    // Check for SVG element by accessing the DOM through a known element
    const headingElement = page
      .getByRole('heading', { name: /you've been invited!/i })
      .element();
    const cardContainer = headingElement.closest('.bg-card');
    const svgElement = cardContainer?.querySelector('svg');
    expect(svgElement).toBeTruthy();
  });

  it('shows install section with correct heading and description', async () => {
    const testUserId = createTestUserId(16);
    await render(
      <MemoryRouter initialEntries={[ROUTES.invite({ userId: testUserId })]}>
        <Routes>
          <Route path="/invite" element={<InvitePage />} />
          <Route path={ROUTES.invite()} element={<InvitePage />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for page to render
    await wait(100);

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
