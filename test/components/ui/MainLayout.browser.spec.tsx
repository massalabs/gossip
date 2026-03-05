// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { MemoryRouter } from 'react-router-dom';
import MainLayout from '../../../src/components/ui/MainLayout';

// Mock Capacitor (used by useKeyboardVisible)
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

// Mock the uiStore
vi.mock('../../../src/stores/uiStore', () => {
  return {
    useUiStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        bottomNavVisible: true,
        setBottomNavVisible: vi.fn(),
        headerIsScrolled: false,
        setHeaderIsScrolled: vi.fn(),
        headerVisible: false,
        setHeaderVisible: vi.fn(),
      }),
  };
});

function renderWithRouter(
  children: React.ReactNode,
  initialEntry = '/discussions'
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <MainLayout>{children}</MainLayout>
    </MemoryRouter>
  );
}

describe('MainLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children', async () => {
    await renderWithRouter(<div data-testid="child">Hello</div>);

    const child = page.getByTestId('child');
    await expect.element(child).toBeInTheDocument();
    await expect.element(child).toHaveTextContent('Hello');
  });

  it('shows bottom navigation on /discussions route', async () => {
    await renderWithRouter(<div>Content</div>, '/discussions');

    const discussionsBtn = page.getByTitle('Discussions');
    const settingsBtn = page.getByTitle('Settings');
    await expect.element(discussionsBtn).toBeInTheDocument();
    await expect.element(settingsBtn).toBeInTheDocument();
  });

  it('shows bottom navigation on /settings route', async () => {
    await renderWithRouter(<div>Content</div>, '/settings');

    const settingsBtn = page.getByTitle('Settings');
    await expect.element(settingsBtn).toBeInTheDocument();
  });

  it('hides bottom navigation on other routes', async () => {
    await renderWithRouter(<div>Content</div>, '/discussion/user123');

    const discussionsBtn = page.getByTitle('Discussions');
    await expect.element(discussionsBtn).not.toBeInTheDocument();
  });
});
