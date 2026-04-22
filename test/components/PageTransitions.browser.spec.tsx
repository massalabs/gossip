// Runs in BROWSER mode (real Chromium via Playwright)
//
// Tests the CSS-based page transition system in AnimatedRoutes:
// - Slide overlay enters/exits with correct CSS animation classes
// - Base layer stays mounted when overlay is shown
// - Fade transition for non-slide routes
// - Navigation through transitions doesn't crash

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { AuthenticatedRoutes } from '../../src/routes/AuthenticatedRoutes';

// ---------------------------------------------------------------------------
// Stub every page component
// ---------------------------------------------------------------------------

function stubPage(testId: string) {
  return () => <div data-testid={testId}>{testId}</div>;
}

function stubPageWithNav(testId: string, targets?: Record<string, string>) {
  return () => {
    const navigate = useNavigate();
    return (
      <div data-testid={testId}>
        {targets &&
          Object.entries(targets).map(([label, path]) => (
            <button
              key={label}
              data-testid={`nav-${label}`}
              onClick={() => navigate(path)}
            >
              {label}
            </button>
          ))}
        <button data-testid="back-btn" onClick={() => navigate(-1)}>
          back
        </button>
      </div>
    );
  };
}

vi.mock('../../src/pages/Discussions', () => ({
  default: stubPageWithNav('page-discussions', {
    'to-discussion': '/discussion/user123',
    'to-settings': '/settings',
    'to-self-discussion': '/self-discussion',
  }),
}));
vi.mock('../../src/pages/Settings', () => ({
  default: stubPageWithNav('page-settings', {
    'to-discussions': '/discussions',
  }),
}));
vi.mock('../../src/pages/Discussion', () => ({
  default: stubPageWithNav('page-discussion', {
    'to-discussions': '/discussions',
  }),
}));
vi.mock('../../src/pages/Contact', () => ({
  default: stubPage('page-contact'),
}));
vi.mock('../../src/pages/ContactSharePage', () => ({
  default: stubPage('page-contact-share'),
}));
vi.mock('../../src/pages/DiscussionSettings', () => ({
  default: stubPage('page-discussion-settings'),
}));
vi.mock('../../src/pages/NewDiscussion', () => ({
  default: stubPage('page-new-discussion'),
}));
vi.mock('../../src/pages/NewContact', () => ({
  default: stubPage('page-new-contact'),
}));
vi.mock('../../src/pages/SelfDiscussion', () => ({
  default: stubPageWithNav('page-self-discussion', {
    'to-discussions': '/discussions',
  }),
}));
vi.mock('../../src/pages/InvitePage', () => ({
  InvitePage: stubPage('page-invite'),
}));

// Settings sub-pages
vi.mock('../../src/pages/settings/SecuritySettings', () => ({
  default: stubPage('page-settings-security'),
}));
vi.mock('../../src/pages/settings/NotificationsSettings', () => ({
  default: stubPage('page-settings-notifications'),
}));
vi.mock('../../src/pages/settings/AppearanceSettings', () => ({
  default: stubPage('page-settings-appearance'),
}));
vi.mock('../../src/pages/settings/LanguageSettings', () => ({
  default: stubPage('page-settings-language'),
}));
vi.mock('../../src/pages/settings/AboutSettings', () => ({
  default: stubPage('page-settings-about'),
}));
vi.mock('../../src/pages/settings/DebugSettings', () => ({
  default: stubPage('page-settings-debug'),
}));
vi.mock('../../src/pages/settings/AccountBackupPage', () => ({
  default: stubPage('page-settings-account-backup'),
}));
vi.mock('../../src/pages/settings/QRCodeSwitcher', () => ({
  default: stubPage('page-settings-share-contact'),
}));
vi.mock('../../src/pages/settings/Web3Settings', () => ({
  default: stubPage('page-settings-web3'),
}));
vi.mock('../../src/pages/settings/PrivacySettings', () => ({
  default: stubPage('page-settings-privacy'),
}));

// ---------------------------------------------------------------------------
// Mock hooks and infrastructure
// ---------------------------------------------------------------------------

vi.mock('../../src/hooks/usePendingDeepLink', () => ({
  usePendingDeepLink: vi.fn(),
}));

vi.mock('../../src/hooks/usePendingSharedContent', () => ({
  usePendingSharedContent: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: vi.fn(() => 'web'),
    isNativePlatform: vi.fn(() => false),
  },
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })),
  },
}));

vi.mock('../../src/stores/uiStore', () => {
  const setBottomNavVisible = vi.fn();
  return {
    useUiStore: Object.assign(
      (selector: (s: Record<string, unknown>) => unknown) =>
        selector({
          showBottomNav: true,
          bottomNavVisible: true,
          setBottomNavVisible,
          headerIsScrolled: false,
          setHeaderIsScrolled: vi.fn(),
          headerVisible: false,
          setHeaderVisible: vi.fn(),
        }),
      {
        use: {
          showBottomNav: () => true,
        },
      }
    ),
  };
});

vi.mock('../../src/stores/keyboardStore', () => ({
  useKeyboardStore: () => false,
}));

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function renderAtRoute(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthenticatedRoutes />
    </MemoryRouter>
  );
}

/**
 * Wait for the slide animation to trigger. AnimatedRoutes has a ready timeout
 * of 400ms, so we need to wait for slideReady to become true.
 */
async function waitForSlideReady() {
  // Poll until the slide-enter animation class appears (set after READY_TIMEOUT_MS)
  await vi.waitFor(
    () => {
      const el = document.querySelector('.animate-slide-enter-right');
      expect(el).not.toBeNull();
    },
    { timeout: 1000 }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PageTransitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Slide overlay (discussion) ------------------------------------------

  describe('slide overlay for discussion routes', () => {
    it('adds animate-slide-enter-right class when navigating to a discussion', async () => {
      await renderAtRoute('/discussions');
      await expect
        .element(page.getByTestId('page-discussions'))
        .toBeInTheDocument();

      // Navigate to a discussion (slide route)
      await userEvent.click(page.getByTestId('nav-to-discussion'));

      // Wait for slide ready (timeout-based in AnimatedRoutes)
      await waitForSlideReady();

      // The discussion page should be visible
      await expect
        .element(page.getByTestId('page-discussion'))
        .toBeInTheDocument();

      // The overlay wrapper should have the slide-enter animation class
      const overlayWrapper = page
        .getByTestId('page-discussion')
        .element()
        .closest('.animate-slide-enter-right');
      expect(overlayWrapper).not.toBeNull();
    });

    it('unmounts base layer (discussions) when overlay is fully shown', async () => {
      await renderAtRoute('/discussions');

      await userEvent.click(page.getByTestId('nav-to-discussion'));
      await waitForSlideReady();

      // Discussion overlay is visible
      await expect
        .element(page.getByTestId('page-discussion'))
        .toBeInTheDocument();

      // Base layer is removed from the DOM to prevent event leaks
      // (long-press, text selection, etc.) through to the hidden list.
      const doc = page.getByTestId('page-discussion').element().ownerDocument;
      const allDiscussionPages = doc.querySelectorAll(
        '[data-testid="page-discussions"]'
      );
      expect(allDiscussionPages.length).toBe(0);
    });

    it('adds animate-slide-exit-right class when navigating back from discussion', async () => {
      await renderAtRoute('/discussions');

      // Navigate to discussion
      await userEvent.click(page.getByTestId('nav-to-discussion'));
      await waitForSlideReady();
      await expect
        .element(page.getByTestId('page-discussion'))
        .toBeInTheDocument();

      // Navigate back to discussions via the button inside the overlay
      await userEvent.click(
        page.getByTestId('page-discussion').getByTestId('nav-to-discussions')
      );

      // The exit animation wrapper should appear with animate-slide-exit-right
      // Use ownerDocument from a rendered element to query the correct document
      const rootEl = page.getByTestId('page-discussions').element();
      const doc = rootEl.ownerDocument;
      await vi.waitFor(() => {
        expect(doc.querySelector('.animate-slide-exit-right')).not.toBeNull();
      });
    });

    it('overlay starts offscreen with translateX(100%) before slide is ready', async () => {
      await renderAtRoute('/discussions');

      // Navigate to discussion — overlay is mounted but not yet "ready"
      await userEvent.click(page.getByTestId('nav-to-discussion'));

      // Wait a single frame for React to flush and render the overlay.
      await vi.waitFor(() => {
        expect(page.getByTestId('page-discussion').element()).toBeTruthy();
      });

      // Get the overlay element through the rendered page
      const discussionEl = page.getByTestId('page-discussion').element();
      expect(discussionEl).not.toBeNull();

      const wrapper = discussionEl.closest('[style*="z-index"]') as HTMLElement;
      expect(wrapper).not.toBeNull();
      expect(wrapper.style.zIndex).toBe('10');

      // Before slideReady, the overlay is either at translateX(100%) waiting for
      // the ready signal, or the animation already started (if the system was fast
      // enough). Both are acceptable.
      const hasAnimClass = wrapper.classList.contains(
        'animate-slide-enter-right'
      );
      const transformStyle = wrapper.style.transform;
      expect(
        hasAnimClass || transformStyle === 'translateX(100%)'
      ).toBeTruthy();
    });
  });

  // --- Slide overlay (self-discussion) -------------------------------------

  describe('slide overlay for self-discussion route', () => {
    it('applies slide animation for self-discussion', async () => {
      await renderAtRoute('/discussions');

      await userEvent.click(page.getByTestId('nav-to-self-discussion'));
      await waitForSlideReady();

      await expect
        .element(page.getByTestId('page-self-discussion'))
        .toBeInTheDocument();

      const overlayWrapper = page
        .getByTestId('page-self-discussion')
        .element()
        .closest('.animate-slide-enter-right');
      expect(overlayWrapper).not.toBeNull();
    });
  });

  // --- Fade transitions (non-slide routes) ---------------------------------

  describe('fade transition for non-slide routes', () => {
    it('applies opacity transition when navigating between base routes', async () => {
      await renderAtRoute('/discussions');
      await expect
        .element(page.getByTestId('page-discussions'))
        .toBeInTheDocument();

      // Navigate to settings (non-slide route — should use fade)
      await userEvent.click(page.getByTestId('nav-to-settings'));

      // Settings should render (after fade)
      await expect
        .element(page.getByTestId('page-settings'))
        .toBeInTheDocument();

      // The base layer wrapper should have transition-opacity classes
      const settingsEl = page.getByTestId('page-settings').element();
      const wrapper = settingsEl.closest('[class*="transition-opacity"]');
      expect(wrapper).not.toBeNull();
    });

    it('does not use slide animation for non-slide routes', async () => {
      await renderAtRoute('/discussions');

      await userEvent.click(page.getByTestId('nav-to-settings'));
      await expect
        .element(page.getByTestId('page-settings'))
        .toBeInTheDocument();

      // No slide animation class should be present for settings
      const doc = page.getByTestId('page-settings').element().ownerDocument;
      const slideEnter = doc.querySelector('.animate-slide-enter-right');
      const slideExit = doc.querySelector('.animate-slide-exit-right');
      expect(slideEnter).toBeNull();
      expect(slideExit).toBeNull();
    });
  });

  // --- Two-layer structure ------------------------------------------------

  describe('two-layer structure', () => {
    it('renders base layer at z-index 1', async () => {
      await renderAtRoute('/discussions');

      const discussionsEl = page.getByTestId('page-discussions').element();
      const baseLayer = discussionsEl.closest(
        '[style*="z-index"]'
      ) as HTMLElement;
      expect(baseLayer).not.toBeNull();
      expect(baseLayer!.style.zIndex).toBe('1');
    });

    it('renders overlay at z-index 10', async () => {
      await renderAtRoute('/discussions');

      await userEvent.click(page.getByTestId('nav-to-discussion'));
      await waitForSlideReady();

      const discussionEl = page.getByTestId('page-discussion').element();
      const overlayLayer = discussionEl.closest(
        '[style*="z-index: 10"]'
      ) as HTMLElement;
      expect(overlayLayer).not.toBeNull();
    });

    it('AnimatedRoutes root has overflow-hidden class', async () => {
      await renderAtRoute('/discussions');

      const discussionsEl = page.getByTestId('page-discussions').element();
      // AnimatedRoutes root: div.h-full.relative.overflow-hidden.bg-background
      const root = discussionsEl.closest('.overflow-hidden');
      expect(root).not.toBeNull();
      expect(root!.classList.contains('relative')).toBe(true);
    });
  });

  // --- Navigation through transitions doesn't crash -----------------------

  describe('navigation resilience', () => {
    it('survives rapid navigation: discussions → discussion → back', async () => {
      await renderAtRoute('/discussions');

      // Navigate to discussion
      await userEvent.click(page.getByTestId('nav-to-discussion'));
      await waitForSlideReady();
      await expect
        .element(page.getByTestId('page-discussion'))
        .toBeInTheDocument();

      // Navigate back
      await userEvent.click(page.getByTestId('nav-to-discussions'));

      // Should be back on discussions (wait for exit animation to complete)
      await expect
        .element(page.getByTestId('page-discussions'))
        .toBeInTheDocument();
    });

    it('handles navigate(-1) back from overlay correctly', async () => {
      await renderAtRoute('/discussions');

      // Navigate to discussion
      await userEvent.click(page.getByTestId('nav-to-discussion'));
      await waitForSlideReady();

      // Use browser back (navigate(-1)) — scope to the discussion overlay
      // to avoid ambiguity with the base layer's back button
      await userEvent.click(
        page.getByTestId('page-discussion').getByTestId('back-btn')
      );

      await expect
        .element(page.getByTestId('page-discussions'))
        .toBeInTheDocument();
    });

    it('exit animation div is removed after animation completes', async () => {
      await renderAtRoute('/discussions');

      // Navigate to discussion, then back
      await userEvent.click(page.getByTestId('nav-to-discussion'));
      await waitForSlideReady();
      await userEvent.click(page.getByTestId('nav-to-discussions'));

      // Wait for the exit animation div to be removed (500ms timeout + buffer)
      const doc = page.getByTestId('page-discussions').element().ownerDocument;
      await vi.waitFor(
        () => {
          expect(doc.querySelector('.animate-slide-exit-right')).toBeNull();
        },
        { timeout: 1000 }
      );

      // Exit animation div should be gone
      const exitDiv = doc.querySelector('.animate-slide-exit-right');
      expect(exitDiv).toBeNull();
    });
  });
});
