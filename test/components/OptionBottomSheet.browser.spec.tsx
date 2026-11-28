// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';

// The app's styles: the layout under test is made of its classes.
import '../../src/index.css';
import OptionBottomSheet from '../../src/components/ui/OptionBottomSheet';
import { MESSAGE_TIMER_OPTIONS } from '../../src/constants/messageTimer';

/** The longest list a sheet shows: every message timer, with a label each. */
const OPTIONS = MESSAGE_TIMER_OPTIONS.map(ms => ({
  label: `timer ${ms}`,
  value: ms,
}));

/** Longer than the sheet's slide in. */
const SLIDE_MS = 500;

/** Whether `el` lies wholly inside the window. */
function onScreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return (
    r.top >= 0 &&
    r.left >= 0 &&
    r.bottom <= innerHeight &&
    r.right <= innerWidth
  );
}

describe('OptionBottomSheet on a phone-sized screen', () => {
  beforeEach(async () => {
    await page.viewport(360, 640);
  });

  afterEach(async () => {
    await page.viewport(414, 896);
  });

  function sheet(selectedValue: number, onSelect = vi.fn()) {
    return render(
      <OptionBottomSheet
        isOpen
        title="Message timer"
        description="Messages disappear after"
        options={OPTIONS}
        selectedValue={selectedValue}
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );
  }

  it('keeps its title on screen, and every choice can be scrolled to and chosen', async () => {
    expect(OPTIONS.length).toBeGreaterThan(15);
    const onSelect = vi.fn();
    const screen = await sheet(OPTIONS[OPTIONS.length - 1].value, onSelect);
    await new Promise(r => setTimeout(r, SLIDE_MS));
    await expect.element(screen.getByText('Message timer')).toBeVisible();
    expect(onScreen(screen.getByText('Message timer').element())).toBe(true);

    for (const o of OPTIONS) {
      const button = screen
        .getByRole('button', { name: o.label, exact: true })
        .element();
      button.scrollIntoView({ block: 'nearest' });
      expect(onScreen(button), o.label).toBe(true);
      await userEvent.click(button);
      expect(onSelect).toHaveBeenLastCalledWith(o.value);
    }
    // The title stays where it was while the list scrolls.
    expect(onScreen(screen.getByText('Message timer').element())).toBe(true);
  });

  it('shows the current choice when it opens, at the end of the list or at its start', async () => {
    for (const selected of [
      OPTIONS[OPTIONS.length - 1].value,
      OPTIONS[0].value,
    ]) {
      const screen = await sheet(selected);
      const label = OPTIONS.find(o => o.value === selected)!.label;
      // Once the sheet has slid in.
      await new Promise(r => setTimeout(r, SLIDE_MS));
      expect(
        onScreen(
          screen.getByRole('button', { name: label, exact: true }).element()
        ),
        label
      ).toBe(true);
      screen.unmount();
    }
  });
});
