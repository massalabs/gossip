// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { useLongPress } from '../../src/hooks/useLongPress';

function TestComponent({
  onLongPress,
  delay,
  threshold,
  disabled,
}: {
  onLongPress: () => void;
  delay?: number;
  threshold?: number;
  disabled?: boolean;
}) {
  const handlers = useLongPress({ onLongPress, delay, threshold, disabled });
  return (
    <div
      data-testid="target"
      {...handlers}
      style={{ width: 200, height: 200 }}
    />
  );
}

describe('useLongPress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('triggers after delay without moving', async () => {
    const onLongPress = vi.fn();
    render(<TestComponent onLongPress={onLongPress} delay={100} />);

    const target = page.getByTestId('target');
    const el = target.element() as HTMLElement;

    // Simulate touch start
    el.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [
          new Touch({ identifier: 0, target: el, clientX: 50, clientY: 50 }),
        ],
      })
    );

    // Wait for delay to pass
    await new Promise(r => setTimeout(r, 150));

    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it('cancels if touch moves beyond threshold', async () => {
    const onLongPress = vi.fn();
    render(
      <TestComponent onLongPress={onLongPress} delay={100} threshold={10} />
    );

    const target = page.getByTestId('target');
    const el = target.element() as HTMLElement;

    el.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [
          new Touch({ identifier: 0, target: el, clientX: 50, clientY: 50 }),
        ],
      })
    );

    // Move beyond threshold
    el.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        touches: [
          new Touch({ identifier: 0, target: el, clientX: 70, clientY: 50 }),
        ],
      })
    );

    await new Promise(r => setTimeout(r, 150));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels if touch ends before delay', async () => {
    const onLongPress = vi.fn();
    render(<TestComponent onLongPress={onLongPress} delay={200} />);

    const target = page.getByTestId('target');
    const el = target.element() as HTMLElement;

    el.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [
          new Touch({ identifier: 0, target: el, clientX: 50, clientY: 50 }),
        ],
      })
    );

    el.dispatchEvent(
      new TouchEvent('touchend', {
        bubbles: true,
        changedTouches: [
          new Touch({ identifier: 0, target: el, clientX: 50, clientY: 50 }),
        ],
      })
    );

    await new Promise(r => setTimeout(r, 250));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('triggers on right-click and prevents default', async () => {
    const onLongPress = vi.fn();
    render(<TestComponent onLongPress={onLongPress} />);

    const target = page.getByTestId('target');
    const el = target.element() as HTMLElement;

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    const defaultPrevented = !el.dispatchEvent(event);

    expect(onLongPress).toHaveBeenCalledOnce();
    expect(defaultPrevented).toBe(true);
  });

  it('does nothing when disabled', async () => {
    const onLongPress = vi.fn();
    render(<TestComponent onLongPress={onLongPress} delay={100} disabled />);

    const target = page.getByTestId('target');
    const el = target.element() as HTMLElement;

    // Touch
    el.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [
          new Touch({ identifier: 0, target: el, clientX: 50, clientY: 50 }),
        ],
      })
    );
    await new Promise(r => setTimeout(r, 150));
    expect(onLongPress).not.toHaveBeenCalled();

    // Right-click
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
