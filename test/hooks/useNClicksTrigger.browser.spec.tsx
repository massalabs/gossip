// Runs in BROWSER mode (real Chromium via Playwright)
// Tests the useNClicksTrigger hook used for debug menu toggle (7 taps on avatar).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { useNClicksTrigger } from '../../src/hooks/useNClicksTrigger';

// ---------- Test harness ----------

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

// ---------- Tests ----------

describe('useNClicksTrigger', () => {
  let callback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callback = vi.fn();
  });

  it('triggers callback after reaching the required click count', async () => {
    render(<Harness clickNumber={3} callback={callback} />);

    const btn = page.getByTestId('ping-btn');
    await btn.click();
    await btn.click();
    expect(callback).not.toHaveBeenCalled();

    await btn.click();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('does NOT trigger with fewer clicks', async () => {
    render(<Harness clickNumber={5} callback={callback} />);

    const btn = page.getByTestId('ping-btn');
    await btn.click();
    await btn.click();
    await btn.click();

    expect(callback).not.toHaveBeenCalled();
  });

  it('resets counter after timeout elapses', async () => {
    render(<Harness clickNumber={3} callback={callback} pingTimeout={200} />);

    const btn = page.getByTestId('ping-btn');
    await btn.click();
    await btn.click();

    // Wait for timeout to reset counter
    await new Promise(r => setTimeout(r, 300));

    // These 2 clicks should NOT trigger (counter was reset, need 3 total)
    await btn.click();
    await btn.click();
    expect(callback).not.toHaveBeenCalled();

    // Third click in the new sequence triggers
    await btn.click();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('resets counter after successful trigger and allows re-trigger', async () => {
    render(<Harness clickNumber={2} callback={callback} />);

    const btn = page.getByTestId('ping-btn');

    // First trigger
    await btn.click();
    await btn.click();
    expect(callback).toHaveBeenCalledTimes(1);

    // Second trigger (counter was reset to 0 after first)
    await btn.click();
    await btn.click();
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('works with single-click requirement', async () => {
    render(<Harness clickNumber={1} callback={callback} />);

    const btn = page.getByTestId('ping-btn');
    await btn.click();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('works with Settings page config (7 taps, 2s timeout)', async () => {
    render(<Harness clickNumber={7} callback={callback} pingTimeout={2000} />);

    const btn = page.getByTestId('ping-btn');
    for (let i = 0; i < 6; i++) {
      await btn.click();
    }
    expect(callback).not.toHaveBeenCalled();

    await btn.click();
    expect(callback).toHaveBeenCalledOnce();
  });
});
