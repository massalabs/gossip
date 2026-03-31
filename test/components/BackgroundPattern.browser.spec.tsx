// Runs in BROWSER mode (real Chromium via Playwright)
// Tests that the discussion background pattern CSS class produces correct styles
// by injecting the relevant CSS rules and verifying computed output.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

// We inject the raw CSS into the document since global CSS isn't auto-loaded
// in browser tests (they only get CSS through component imports).
let styleEl: HTMLStyleElement;

beforeAll(() => {
  styleEl = document.createElement('style');
  // Mirror the rules from src/styles/utilities.css (lines 266-293)
  styleEl.textContent = `
    .bg-discussion-pattern {
      position: relative;
      background-color: var(--card);
      isolation: isolate;
    }
    .bg-discussion-pattern::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      min-height: 100vh;
      min-height: 100dvh;
      z-index: -1;
      /* Test uses url('bg-discussion-light.svg') / url('bg-discussion-dark.svg');
         real source uses url('../assets/backgrounds/bg-discussion-light.svg') etc.
         Paths differ because Vite resolves them at build time. */
      background-image: url('bg-discussion-light.svg');
      background-repeat: repeat;
      background-size: 120px 120px;
      opacity: 0.5;
      pointer-events: none;
    }
    :is(.dark *).bg-discussion-pattern::before {
      background-image: url('bg-discussion-dark.svg');
    }
  `;
  document.head.appendChild(styleEl);
});

afterAll(() => {
  styleEl.remove();
  document.documentElement.classList.remove('dark');
});

describe('BackgroundPattern — .bg-discussion-pattern', () => {
  it('applies position: relative and isolation: isolate', async () => {
    render(<div data-testid="pattern" className="bg-discussion-pattern" />);

    const el = page.getByTestId('pattern').element() as HTMLElement;
    const style = getComputedStyle(el);
    expect(style.position).toBe('relative');
    expect(style.isolation).toBe('isolate');
  });

  it('::before has background-repeat: repeat and pointer-events: none', async () => {
    render(
      <div
        data-testid="pattern"
        className="bg-discussion-pattern"
        style={{ width: '200px', height: '200px' }}
      />
    );

    const el = page.getByTestId('pattern').element() as HTMLElement;
    const beforeStyle = getComputedStyle(el, '::before');
    expect(beforeStyle.backgroundRepeat).toBe('repeat');
    expect(beforeStyle.pointerEvents).toBe('none');
    expect(beforeStyle.position).toBe('absolute');
  });

  it('::before has background-size: 120px 120px', async () => {
    render(
      <div
        data-testid="pattern"
        className="bg-discussion-pattern"
        style={{ width: '200px', height: '200px' }}
      />
    );

    const el = page.getByTestId('pattern').element() as HTMLElement;
    const beforeStyle = getComputedStyle(el, '::before');
    expect(beforeStyle.backgroundSize).toBe('120px 120px');
  });

  it('::before has opacity: 0.5', async () => {
    render(
      <div
        data-testid="pattern"
        className="bg-discussion-pattern"
        style={{ width: '200px', height: '200px' }}
      />
    );

    const el = page.getByTestId('pattern').element() as HTMLElement;
    const beforeStyle = getComputedStyle(el, '::before');
    expect(beforeStyle.opacity).toBe('0.5');
  });

  it('light mode uses bg-discussion-light.svg', async () => {
    document.documentElement.classList.remove('dark');

    render(
      <div
        data-testid="pattern"
        className="bg-discussion-pattern"
        style={{ width: '200px', height: '200px' }}
      />
    );

    const el = page.getByTestId('pattern').element() as HTMLElement;
    const beforeStyle = getComputedStyle(el, '::before');
    expect(beforeStyle.backgroundImage).toContain('bg-discussion-light');
  });

  it('dark mode uses bg-discussion-dark.svg', async () => {
    document.documentElement.classList.add('dark');

    render(
      <div
        data-testid="pattern"
        className="bg-discussion-pattern"
        style={{ width: '200px', height: '200px' }}
      />
    );

    const el = page.getByTestId('pattern').element() as HTMLElement;
    const beforeStyle = getComputedStyle(el, '::before');
    expect(beforeStyle.backgroundImage).toContain('bg-discussion-dark');

    document.documentElement.classList.remove('dark');
  });
});
