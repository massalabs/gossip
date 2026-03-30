// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { MemoryRouter } from 'react-router-dom';
import BottomNavigation from '../../../src/components/ui/BottomNavigation';

// Mock Capacitor (used by keyboardStore)
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

// Mock the uiStore to avoid Zustand React resolution issues in browser tests
vi.mock('../../../src/stores/uiStore', () => {
  const setBottomNavVisible = vi.fn();
  return {
    useUiStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        bottomNavVisible: true,
        setBottomNavVisible,
        headerIsScrolled: false,
        setHeaderIsScrolled: vi.fn(),
        headerVisible: false,
        setHeaderVisible: vi.fn(),
      }),
  };
});

function renderWithRouter(initialEntry = '/discussions') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <BottomNavigation />
    </MemoryRouter>
  );
}

describe('BottomNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders two navigation buttons (Discussions and Settings)', async () => {
    await renderWithRouter();

    const discussionsBtn = page.getByTitle('Discussions');
    const settingsBtn = page.getByTitle('Settings');

    await expect.element(discussionsBtn).toBeInTheDocument();
    await expect.element(settingsBtn).toBeInTheDocument();
  });

  it('highlights Discussions tab when on /discussions route', async () => {
    await renderWithRouter('/discussions');

    const discussionsBtn = page.getByTitle('Discussions');
    // Active tab gets scale-[1.02] class
    await expect.element(discussionsBtn).toHaveClass('scale-[1.02]');
  });

  it('highlights Settings tab when on /settings route', async () => {
    await renderWithRouter('/settings');

    const settingsBtn = page.getByTitle('Settings');
    await expect.element(settingsBtn).toHaveClass('scale-[1.02]');
  });

  it('does not highlight inactive tab', async () => {
    await renderWithRouter('/discussions');

    const settingsBtn = page.getByTitle('Settings');
    // Inactive tab should not have the active scale class
    await expect.element(settingsBtn).not.toHaveClass('scale-[1.02]');
  });
});
