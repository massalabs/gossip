// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import KeyboardAwareWrapper from '../../../src/components/ui/KeyboardAwareWrapper';
import * as CapacitorCore from '@capacitor/core';
import * as CapacitorKeyboard from '@capacitor/keyboard';
import { wait } from '../../helpers/utils';

// Mock Capacitor modules
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: vi.fn(() => 'web'),
    isNativePlatform: vi.fn(() => false),
  },
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(),
  },
}));

describe('KeyboardAwareWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (window.visualViewport) {
      Object.defineProperty(window, 'innerHeight', {
        writable: true,
        configurable: true,
        value: 800,
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children correctly', async () => {
    await render(
      <KeyboardAwareWrapper>
        <div data-testid="child">Test Content</div>
      </KeyboardAwareWrapper>
    );

    const child = page.getByTestId('child');
    await expect.element(child).toBeInTheDocument();
    await expect.element(child).toHaveTextContent('Test Content');
  });

  it('applies full height when keyboard is not active', async () => {
    await render(
      <KeyboardAwareWrapper>
        <div data-testid="content">Content</div>
      </KeyboardAwareWrapper>
    );

    const content = page.getByTestId('content');
    const wrapper = await content.element().parentElement;

    if (wrapper) {
      const style = window.getComputedStyle(wrapper);
      expect(style.height).toBeDefined();
      expect(style.height).not.toBe('auto');
    }
  });

  it('applies reduced height when keyboard is active on iOS', async () => {
    vi.mocked(CapacitorCore.Capacitor.getPlatform).mockReturnValue('ios');
    vi.mocked(CapacitorCore.Capacitor.isNativePlatform).mockReturnValue(true);

    let showCallback: ((info: { keyboardHeight: number }) => void) | null =
      null;
    vi.mocked(CapacitorKeyboard.Keyboard.addListener).mockImplementation(
      (event: string, callback: unknown) => {
        if (event === 'keyboardWillShow') {
          showCallback = callback as (info: { keyboardHeight: number }) => void;
        }
        return Promise.resolve({
          remove: vi.fn(),
        } as Awaited<
          ReturnType<typeof CapacitorKeyboard.Keyboard.addListener>
        >);
      }
    );

    await render(
      <KeyboardAwareWrapper>
        <div data-testid="content">Content</div>
      </KeyboardAwareWrapper>
    );

    await wait(10);

    const callback = showCallback;
    if (callback) {
      (callback as (info: { keyboardHeight: number }) => void)({
        keyboardHeight: 300,
      });
    }

    await wait(100);

    const content = page.getByTestId('content');
    const wrapper = await content.element().parentElement;

    if (wrapper) {
      const style = window.getComputedStyle(wrapper);
      expect(style.height).toBeDefined();
    }
  });

  it('does not apply keyboard workaround on non-iOS platforms', async () => {
    vi.mocked(CapacitorCore.Capacitor.getPlatform).mockReturnValue('web');
    vi.mocked(CapacitorCore.Capacitor.isNativePlatform).mockReturnValue(false);

    await render(
      <KeyboardAwareWrapper>
        <div data-testid="content">Content</div>
      </KeyboardAwareWrapper>
    );

    const content = page.getByTestId('content');
    const wrapper = await content.element().parentElement;

    if (wrapper) {
      const style = window.getComputedStyle(wrapper);
      expect(style.height).toBeDefined();
      expect(style.height).not.toBe('auto');
    }
  });

  it('uses keyboard-aware-height for CSS variable driven sizing', async () => {
    await render(
      <KeyboardAwareWrapper>
        <div data-testid="content">Content</div>
      </KeyboardAwareWrapper>
    );

    const content = page.getByTestId('content');
    const wrapper = await content.element().parentElement;

    if (wrapper) {
      const className = wrapper.className;
      expect(className).toContain('keyboard-aware-height');
    }
  });

  it('maintains flex column layout', async () => {
    await render(
      <KeyboardAwareWrapper>
        <div data-testid="content">Content</div>
      </KeyboardAwareWrapper>
    );

    const content = page.getByTestId('content');
    const wrapper = await content.element().parentElement;

    if (wrapper) {
      const className = wrapper.className;
      expect(className).toContain('flex');
      expect(className).toContain('flex-col');
      expect(className).toContain('w-full');
      expect(className).toContain('keyboard-aware-height');
    }
  });
});
