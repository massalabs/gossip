// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import ThreeDotMenu, {
  MenuItem,
} from '../../../src/components/ui/ThreeDotMenu';

function renderMenu(items?: MenuItem[], triggerLabel?: string) {
  const defaultItems: MenuItem[] = items ?? [
    { label: 'Share Contact', onClick: vi.fn() },
    { label: 'Settings', onClick: vi.fn() },
  ];
  return {
    ...render(
      <ThreeDotMenu items={defaultItems} triggerLabel={triggerLabel} />
    ),
    items: defaultItems,
  };
}

describe('ThreeDotMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the trigger button', async () => {
    renderMenu();

    const trigger = page.getByRole('button', { name: 'More options' });
    await expect.element(trigger).toBeInTheDocument();
    await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect.element(trigger).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('opens menu on click and shows items', async () => {
    renderMenu();

    const trigger = page.getByRole('button', { name: 'More options' });
    await userEvent.click(trigger);

    await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');

    const menu = page.getByRole('menu');
    await expect.element(menu).toBeInTheDocument();

    const shareItem = page.getByRole('menuitem', { name: 'Share Contact' });
    const settingsItem = page.getByRole('menuitem', { name: 'Settings' });
    await expect.element(shareItem).toBeInTheDocument();
    await expect.element(settingsItem).toBeInTheDocument();
  });

  it('calls onClick and closes menu when an item is clicked', async () => {
    const { items } = renderMenu();

    // Open menu
    await userEvent.click(page.getByRole('button', { name: 'More options' }));

    // Click an item
    await userEvent.click(
      page.getByRole('menuitem', { name: 'Share Contact' })
    );

    expect(items[0].onClick).toHaveBeenCalledOnce();

    // Menu should be closed
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
  });

  it('closes menu on Escape key', async () => {
    renderMenu();

    await userEvent.click(page.getByRole('button', { name: 'More options' }));
    await expect.element(page.getByRole('menu')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
  });

  it('closes menu on click outside', async () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <ThreeDotMenu items={[{ label: 'Item', onClick: vi.fn() }]} />
      </div>
    );

    await userEvent.click(page.getByRole('button', { name: 'More options' }));
    await expect.element(page.getByRole('menu')).toBeInTheDocument();

    await userEvent.click(page.getByTestId('outside'));
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
  });

  it('renders icons when provided', async () => {
    const items: MenuItem[] = [
      {
        label: 'With Icon',
        icon: <span data-testid="test-icon">IC</span>,
        onClick: vi.fn(),
      },
    ];
    renderMenu(items);

    await userEvent.click(page.getByRole('button', { name: 'More options' }));

    const icon = page.getByTestId('test-icon');
    await expect.element(icon).toBeInTheDocument();
  });

  it('applies danger styling to danger items', async () => {
    const items: MenuItem[] = [
      { label: 'Delete', onClick: vi.fn(), danger: true },
    ];
    renderMenu(items);

    await userEvent.click(page.getByRole('button', { name: 'More options' }));

    const dangerItem = page.getByRole('menuitem', { name: 'Delete' });
    await expect.element(dangerItem).toHaveClass('text-destructive');
  });

  it('uses custom trigger label', async () => {
    renderMenu(undefined, 'Open actions');

    const trigger = page.getByRole('button', { name: 'Open actions' });
    await expect.element(trigger).toBeInTheDocument();
  });

  it('toggles menu open and closed on trigger click', async () => {
    renderMenu();

    const trigger = page.getByRole('button', { name: 'More options' });

    await userEvent.click(trigger);
    await expect.element(page.getByRole('menu')).toBeInTheDocument();

    await userEvent.click(trigger);
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
  });
});
