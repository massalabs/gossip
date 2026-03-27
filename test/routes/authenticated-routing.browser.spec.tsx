// Runs in BROWSER mode (real Chromium via Playwright)
//
// Tests the routing behavior of AuthenticatedRoutes:
// - Each route resolves to the correct page component
// - Default/unknown routes redirect to /discussions
// - Navigation between routes works
//
// All page components are mocked as lightweight stubs to isolate routing logic.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { AuthenticatedRoutes } from '../../src/routes/AuthenticatedRoutes';

// ---------------------------------------------------------------------------
// Stub every page component — renders a div with data-testid="page-<name>"
// ---------------------------------------------------------------------------

function stubPage(testId: string) {
  return () => <div data-testid={testId}>{testId}</div>;
}

// A stub that also exposes a navigate button for testing navigation flows
function stubPageWithNav(testId: string, navigateTo?: string) {
  return () => {
    const navigate = useNavigate();
    return (
      <div data-testid={testId}>
        {navigateTo && (
          <button data-testid="nav-btn" onClick={() => navigate(navigateTo)}>
            navigate
          </button>
        )}
        <button data-testid="back-btn" onClick={() => navigate(-1)}>
          back
        </button>
      </div>
    );
  };
}

vi.mock('../../src/pages/Discussions', () => ({
  default: stubPageWithNav('page-discussions', '/settings'),
}));
vi.mock('../../src/pages/Settings', () => ({
  default: stubPageWithNav('page-settings', '/discussions'),
}));
vi.mock('../../src/pages/Discussion', () => ({
  default: stubPageWithNav('page-discussion'),
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
  default: stubPage('page-self-discussion'),
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
// Mock hooks used by AuthenticatedRoutes
// ---------------------------------------------------------------------------

vi.mock('../../src/hooks/usePendingDeepLink', () => ({
  usePendingDeepLink: vi.fn(),
}));

vi.mock('../../src/hooks/usePendingSharedContent', () => ({
  usePendingSharedContent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock infrastructure (Capacitor, stores used by MainLayout/BottomNavigation)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthenticatedRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Route resolution ---------------------------------------------------

  describe('route resolution', () => {
    it('renders Discussions page at /discussions', async () => {
      await renderAtRoute('/discussions');
      await expect
        .element(page.getByTestId('page-discussions'))
        .toBeInTheDocument();
    });

    it('renders Settings page at /settings', async () => {
      await renderAtRoute('/settings');
      await expect
        .element(page.getByTestId('page-settings'))
        .toBeInTheDocument();
    });

    it('renders Discussion page at /discussion/:userId', async () => {
      await renderAtRoute('/discussion/user123');
      await expect
        .element(page.getByTestId('page-discussion'))
        .toBeInTheDocument();
    });

    it('renders Contact page at /contact/:userId', async () => {
      await renderAtRoute('/contact/user123');
      await expect
        .element(page.getByTestId('page-contact'))
        .toBeInTheDocument();
    });

    it('renders ContactShare page at /contact/:userId/share', async () => {
      await renderAtRoute('/contact/user123/share');
      await expect
        .element(page.getByTestId('page-contact-share'))
        .toBeInTheDocument();
    });

    it('renders DiscussionSettings at /discussion/:id/settings', async () => {
      await renderAtRoute('/discussion/disc123/settings');
      await expect
        .element(page.getByTestId('page-discussion-settings'))
        .toBeInTheDocument();
    });

    it('renders NewDiscussion page at /new-discussion', async () => {
      await renderAtRoute('/new-discussion');
      await expect
        .element(page.getByTestId('page-new-discussion'))
        .toBeInTheDocument();
    });

    it('renders NewContact page at /new-contact', async () => {
      await renderAtRoute('/new-contact');
      await expect
        .element(page.getByTestId('page-new-contact'))
        .toBeInTheDocument();
    });

    it('renders SelfDiscussion page at /self-discussion', async () => {
      await renderAtRoute('/self-discussion');
      await expect
        .element(page.getByTestId('page-self-discussion'))
        .toBeInTheDocument();
    });

    it('renders InvitePage at /invite/:userId', async () => {
      await renderAtRoute('/invite/gossip1abc');
      await expect.element(page.getByTestId('page-invite')).toBeInTheDocument();
    });
  });

  // --- Settings sub-pages -------------------------------------------------

  describe('settings sub-pages', () => {
    const subPages = [
      { path: '/settings/security', testId: 'page-settings-security' },
      {
        path: '/settings/notifications',
        testId: 'page-settings-notifications',
      },
      { path: '/settings/appearance', testId: 'page-settings-appearance' },
      { path: '/settings/language', testId: 'page-settings-language' },
      { path: '/settings/about', testId: 'page-settings-about' },
      { path: '/settings/debug', testId: 'page-settings-debug' },
      {
        path: '/settings/account-backup',
        testId: 'page-settings-account-backup',
      },
      {
        path: '/settings/share-contact',
        testId: 'page-settings-share-contact',
      },
      { path: '/settings/web3', testId: 'page-settings-web3' },
      { path: '/settings/privacy', testId: 'page-settings-privacy' },
    ];

    subPages.forEach(({ path, testId }) => {
      it(`renders ${testId} at ${path}`, async () => {
        await renderAtRoute(path);
        await expect.element(page.getByTestId(testId)).toBeInTheDocument();
      });
    });
  });

  // --- Redirects ----------------------------------------------------------

  describe('redirects', () => {
    it('redirects / to /discussions', async () => {
      await renderAtRoute('/');
      await expect
        .element(page.getByTestId('page-discussions'))
        .toBeInTheDocument();
    });

    it('redirects unknown routes to /discussions', async () => {
      await renderAtRoute('/some/unknown/route');
      await expect
        .element(page.getByTestId('page-discussions'))
        .toBeInTheDocument();
    });
  });

  // --- Navigation flows ---------------------------------------------------

  describe('navigation', () => {
    it('navigates from discussions to settings', async () => {
      await renderAtRoute('/discussions');
      await expect
        .element(page.getByTestId('page-discussions'))
        .toBeInTheDocument();

      await userEvent.click(page.getByTestId('nav-btn'));
      await expect
        .element(page.getByTestId('page-settings'))
        .toBeInTheDocument();
    });

    it('navigates from settings to discussions', async () => {
      await renderAtRoute('/settings');
      await expect
        .element(page.getByTestId('page-settings'))
        .toBeInTheDocument();

      await userEvent.click(page.getByTestId('nav-btn'));
      await expect
        .element(page.getByTestId('page-discussions'))
        .toBeInTheDocument();
    });

    it('navigate(-1) goes back to previous route', async () => {
      await renderAtRoute('/discussions');
      await expect
        .element(page.getByTestId('page-discussions'))
        .toBeInTheDocument();

      // Navigate forward to settings
      await userEvent.click(page.getByTestId('nav-btn'));
      // Wait for discussions to exit before settings enters (mode="wait")
      await expect
        .element(page.getByTestId('page-discussions'))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByTestId('page-settings'))
        .toBeInTheDocument();

      // Go back
      await userEvent.click(page.getByTestId('back-btn'));
      await expect
        .element(page.getByTestId('page-settings'))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByTestId('page-discussions'))
        .toBeInTheDocument();
    });
  });

  // --- MainLayout integration ---------------------------------------------

  describe('layout', () => {
    it('wraps routes in MainLayout (main element exists)', async () => {
      await renderAtRoute('/discussions');
      const main = page.getByRole('main');
      await expect.element(main).toBeInTheDocument();
    });

    it('shows bottom navigation on /discussions', async () => {
      await renderAtRoute('/discussions');
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      await expect.element(nav).toBeInTheDocument();
    });

    it('shows bottom navigation on /settings', async () => {
      await renderAtRoute('/settings');
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      await expect.element(nav).toBeInTheDocument();
    });

    it('hides bottom navigation on /discussion/:userId', async () => {
      await renderAtRoute('/discussion/user123');
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      await expect.element(nav).not.toBeInTheDocument();
    });

    it('hides bottom navigation on settings sub-pages', async () => {
      await renderAtRoute('/settings/security');
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      await expect.element(nav).not.toBeInTheDocument();
    });
  });
});
