// Tests the useNClicksTrigger hook used for debug menu toggle (7 taps on avatar).
// Runs in jsdom (unit project) — no browser runner needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useNClicksTrigger } from '../../src/hooks/useNClicksTrigger';

function Harness({
  clickNumber,
  callback,
  pingTimeout,
}: {
  clickNumber: number;
  callback: () => void;
  pingTimeout?: number;
}) {
  const { ping } = useNClicksTrigger({ clickNumber, callback, pingTimeout });
  return (
    <button data-testid="ping-btn" onClick={ping}>
      tap
    </button>
  );
}

function renderHarness(
  props: React.ComponentProps<typeof Harness>,
  container: HTMLDivElement
) {
  act(() => {
    createRoot(container).render(<Harness {...props} />);
  });
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="ping-btn"]'
  )!;
}

function click(btn: HTMLButtonElement) {
  act(() => {
    btn.click();
  });
}

describe('useNClicksTrigger', () => {
  let container: HTMLDivElement;
  let callback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callback = vi.fn();
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('triggers callback after reaching the required click count', () => {
    const btn = renderHarness({ clickNumber: 3, callback }, container);

    click(btn);
    click(btn);
    expect(callback).not.toHaveBeenCalled();

    click(btn);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('does NOT trigger with fewer clicks', () => {
    const btn = renderHarness({ clickNumber: 5, callback }, container);

    click(btn);
    click(btn);
    click(btn);

    expect(callback).not.toHaveBeenCalled();
  });

  it('resets counter after timeout elapses', () => {
    const btn = renderHarness(
      { clickNumber: 3, callback, pingTimeout: 200 },
      container
    );

    click(btn);
    click(btn);

    // Wait for timeout to reset counter
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // These 2 clicks should NOT trigger (counter was reset, need 3 total)
    click(btn);
    click(btn);
    expect(callback).not.toHaveBeenCalled();

    // Third click in the new sequence triggers
    click(btn);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('resets counter after successful trigger and allows re-trigger', () => {
    const btn = renderHarness({ clickNumber: 2, callback }, container);

    // First trigger
    click(btn);
    click(btn);
    expect(callback).toHaveBeenCalledTimes(1);

    // Second trigger (counter was reset to 0 after first)
    click(btn);
    click(btn);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('works with single-click requirement', () => {
    const btn = renderHarness({ clickNumber: 1, callback }, container);

    click(btn);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('works with Settings page config (7 taps, 2s timeout)', () => {
    const btn = renderHarness(
      { clickNumber: 7, callback, pingTimeout: 2000 },
      container
    );

    for (let i = 0; i < 6; i++) {
      click(btn);
    }
    expect(callback).not.toHaveBeenCalled();

    click(btn);
    expect(callback).toHaveBeenCalledOnce();
  });
});
