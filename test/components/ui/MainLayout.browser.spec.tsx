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
});
