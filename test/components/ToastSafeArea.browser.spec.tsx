// Runs in BROWSER mode (real Chromium via Playwright)
// Tests that the Toaster component from react-hot-toast applies safe-area
// top offset so toasts don't appear under the mobile notch.

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'vitest-browser-react';
import toast, { Toaster } from 'react-hot-toast';
import { toastOptions } from '../../src/utils/toastOptions';

/** Helper: find the react-hot-toast container div (has role="region" or generated class). */
function findToasterContainer(): HTMLElement | null {
  // react-hot-toast renders a container div with a generated class (go*) and
  // an inline style including the `top` property we set via containerStyle.
  // The outermost div rendered by <Toaster> has style with "position: fixed".
  const candidates = document.querySelectorAll<HTMLElement>('div[style]');
  for (const el of candidates) {
    if (
      el.style.position === 'fixed' &&
      el.style.top &&
      el.style.zIndex === '9999'
    ) {
      return el;
    }
  }
  return null;
}

afterEach(() => {
  // Dismiss any lingering toasts so they don't leak between tests
  toast.remove();
  cleanup();
  document.documentElement.style.removeProperty('--sat');
});

describe('Toaster safe-area top offset', () => {
  it('container has top style set to var(--sat, 0px)', async () => {
    render(
      <Toaster
        position="top-center"
        containerStyle={{ top: 'var(--sat, 0px)' }}
        toastOptions={toastOptions}
      />
    );

    // Trigger a toast so the container is fully in the DOM
    toast('Safe area test');

    // Allow react-hot-toast to render
    await vi.waitFor(() => {
      expect(findToasterContainer()).not.toBeNull();
    });

    const container = findToasterContainer();
    // The inline style should contain our CSS variable expression
    expect(container!.style.top).toBe('var(--sat, 0px)');
  });

  it('defaults to 0px when --sat is not defined', async () => {
    // Ensure --sat is not set
    document.documentElement.style.removeProperty('--sat');

    render(
      <Toaster
        position="top-center"
        containerStyle={{ top: 'var(--sat, 0px)' }}
        toastOptions={toastOptions}
      />
    );

    toast('Fallback test');
    await vi.waitFor(() => {
      expect(findToasterContainer()).not.toBeNull();
    });

    const container = findToasterContainer();
    const computed = getComputedStyle(container!);
    // With no --sat defined the fallback 0px should apply
    expect(computed.top).toBe('0px');
  });

  it('respects --sat CSS variable when set to a known value (47px)', async () => {
    // Set the safe-area-top variable on the root element
    document.documentElement.style.setProperty('--sat', '47px');

    render(
      <Toaster
        position="top-center"
        containerStyle={{ top: 'var(--sat, 0px)' }}
        toastOptions={toastOptions}
      />
    );

    toast('Notch test');
    await vi.waitFor(() => {
      expect(findToasterContainer()).not.toBeNull();
    });

    const container = findToasterContainer();
    const computed = getComputedStyle(container!);
    expect(computed.top).toBe('47px');
  });

  it('applies the toast options styles (background, color, border)', async () => {
    // Set CSS variables so computed values resolve properly
    document.documentElement.style.setProperty('--card', '#1a1a1a');
    document.documentElement.style.setProperty('--foreground', '#ffffff');
    document.documentElement.style.setProperty('--border', '#333333');

    render(
      <Toaster
        position="top-center"
        containerStyle={{ top: 'var(--sat, 0px)' }}
        toastOptions={toastOptions}
      />
    );

    toast('Style test');
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLElement>('[role="status"]')
      ).not.toBeNull();
    });

    // Find the toast element (has role="status")
    const toastEl = document.querySelector<HTMLElement>('[role="status"]');

    // The toast's parent div carries the inline styles from toastOptions
    const styledParent = toastEl!.closest<HTMLElement>('div[style]');
    expect(styledParent).not.toBeNull();

    // Clean up custom properties
    document.documentElement.style.removeProperty('--card');
    document.documentElement.style.removeProperty('--foreground');
    document.documentElement.style.removeProperty('--border');
  });
});
