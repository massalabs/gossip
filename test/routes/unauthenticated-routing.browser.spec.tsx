// Runs in BROWSER mode (real Chromium via Playwright)
//
// Tests the routing behavior of UnauthenticatedRoutes:
// - Each route resolves to the correct page component
// - Default/unknown routes redirect to /welcome

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { MemoryRouter } from 'react-router-dom';
import { UnauthenticatedRoutes } from '../../src/routes/UnauthenticatedRoutes';

// ---------------------------------------------------------------------------
// Stub page components
// ---------------------------------------------------------------------------

vi.mock('../../src/pages/Login', () => ({
  default: (props: { onCreateNewAccount: () => void }) => (
    <div data-testid="page-login">
      <button data-testid="create-btn" onClick={props.onCreateNewAccount}>
        create
      </button>
    </div>
  ),
}));

vi.mock('../../src/components/account/AccountCreation', () => ({
  default: (props: { onBack: () => void }) => (
    <div data-testid="page-setup">
      <button data-testid="back-btn" onClick={props.onBack}>
        back
      </button>
    </div>
  ),
}));

vi.mock('../../src/pages/InvitePage', () => ({
  InvitePage: () => <div data-testid="page-invite">invite</div>,
}));

// ---------------------------------------------------------------------------
// Mock infrastructure
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

vi.mock('../../src/stores/uiStore', () => ({
  useUiStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        showBottomNav: false,
        bottomNavVisible: false,
        setBottomNavVisible: vi.fn(),
        headerIsScrolled: false,
        setHeaderIsScrolled: vi.fn(),
        headerVisible: false,
        setHeaderVisible: vi.fn(),
      }),
    {
      use: {
        showBottomNav: () => false,
      },
    }
  ),
}));

vi.mock('../../src/stores/keyboardStore', () => ({
  useKeyboardStore: () => false,
}));

vi.mock('../../src/stores/accountStore', () => ({
  useAccountStore: Object.assign(
    () => ({
      hasExistingAccount: vi.fn(() => Promise.resolve(false)),
    }),
    {
      getState: () => ({
        hasExistingAccount: vi.fn(() => Promise.resolve(false)),
      }),
    }
  ),
}));

vi.mock('../../src/stores/appStore', () => ({
  useAppStore: Object.assign(() => ({}), {
    getState: () => ({
      setIsInitialized: vi.fn(),
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const defaultProps = {
  existingAccountInfo: null,
  loginError: null,
  onLoginErrorChange: vi.fn(),
};

function renderAtRoute(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <UnauthenticatedRoutes {...defaultProps} />
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UnauthenticatedRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('route resolution', () => {
    it('renders Login page at /welcome', async () => {
      await renderAtRoute('/welcome');
      await expect.element(page.getByTestId('page-login')).toBeInTheDocument();
    });

    it('renders AccountCreation page at /setup', async () => {
      await renderAtRoute('/setup');
      await expect.element(page.getByTestId('page-setup')).toBeInTheDocument();
    });

    it('renders InvitePage at /invite/:userId', async () => {
      await renderAtRoute('/invite/gossip1abc');
      await expect.element(page.getByTestId('page-invite')).toBeInTheDocument();
    });
  });

  describe('redirects', () => {
    it('redirects / to /welcome', async () => {
      await renderAtRoute('/');
      await expect.element(page.getByTestId('page-login')).toBeInTheDocument();
    });

    it('redirects unknown routes to /welcome', async () => {
      await renderAtRoute('/unknown/route');
      await expect.element(page.getByTestId('page-login')).toBeInTheDocument();
    });
  });

  describe('layout', () => {
    it('wraps routes in MainLayout (main element exists)', async () => {
      await renderAtRoute('/welcome');
      const main = page.getByRole('main');
      await expect.element(main).toBeInTheDocument();
    });

    it('does not show bottom navigation on unauthenticated routes', async () => {
      await renderAtRoute('/welcome');
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      await expect.element(nav).not.toBeInTheDocument();
    });
  });
});
