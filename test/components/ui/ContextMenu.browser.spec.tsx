// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import ContextMenu, {
  ContextMenuItem,
} from '../../../src/components/ui/ContextMenu';

function renderMenu(
  items?: ContextMenuItem[],
  { isOpen = true }: { isOpen?: boolean } = {}
) {
  const defaultItems: ContextMenuItem[] = items ?? [
    { label: 'Reply', onClick: vi.fn() },
    { label: 'Forward', onClick: vi.fn() },
    { label: 'Copy', onClick: vi.fn() },
  ];
  const onClose = vi.fn();
  const result = render(
    <ContextMenu items={defaultItems} isOpen={isOpen} onClose={onClose} />
  );
  return { ...result, items: defaultItems, onClose };
}

describe('ContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders items with correct roles', async () => {
    renderMenu();

    const menu = page.getByRole('menu');
    await expect.element(menu).toBeInTheDocument();

    const reply = page.getByRole('menuitem', { name: 'Reply' });
    const forward = page.getByRole('menuitem', { name: 'Forward' });
    const copy = page.getByRole('menuitem', { name: 'Copy' });
    await expect.element(reply).toBeInTheDocument();
    await expect.element(forward).toBeInTheDocument();
    await expect.element(copy).toBeInTheDocument();
  });

  it('calls onClick and closes when item is clicked', async () => {
    const { items, onClose } = renderMenu();

    await userEvent.click(page.getByRole('menuitem', { name: 'Reply' }));

    expect(items[0].onClick).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape key', async () => {
    const { onClose } = renderMenu();

    await expect.element(page.getByRole('menu')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on backdrop click', async () => {
    const { onClose } = renderMenu();

    const backdrop = page.getByTestId('context-menu-backdrop');
    (backdrop.element() as HTMLElement).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not steal focus on open', async () => {
    renderMenu();

    await new Promise(r => setTimeout(r, 50));

    await expect.element(page.getByRole('menu')).toBeInTheDocument();
    // No menu item should be focused — focus stays on the previous element
    const active = document.activeElement;
    expect(active?.getAttribute('role')).not.toBe('menuitem');
  });

  it('navigates items with arrow keys via data-focused', async () => {
    renderMenu();

    await new Promise(r => setTimeout(r, 50));

    const items = document.querySelectorAll('[role="menuitem"]');

    // First ArrowDown highlights the first item
    await userEvent.keyboard('{ArrowDown}');
    expect(items[0].getAttribute('data-focused')).toBe('true');

    await userEvent.keyboard('{ArrowDown}');
    expect(items[1].getAttribute('data-focused')).toBe('true');
    expect(items[0].hasAttribute('data-focused')).toBe(false);

    await userEvent.keyboard('{ArrowDown}');
    expect(items[2].getAttribute('data-focused')).toBe('true');

    await userEvent.keyboard('{ArrowUp}');
    expect(items[1].getAttribute('data-focused')).toBe('true');

    // Wrap around from top
    await userEvent.keyboard('{ArrowUp}');
    expect(items[0].getAttribute('data-focused')).toBe('true');

    await userEvent.keyboard('{ArrowUp}');
    expect(items[2].getAttribute('data-focused')).toBe('true');
  });

  it('activates highlighted item with Enter', async () => {
    const { items, onClose } = renderMenu();

    await new Promise(r => setTimeout(r, 50));

    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');

    expect(items[0].onClick).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('applies danger styling', async () => {
    renderMenu([{ label: 'Delete', onClick: vi.fn(), danger: true }]);

    const item = page.getByRole('menuitem', { name: 'Delete' });
    await expect.element(item).toHaveClass('text-destructive');
  });

  it('renders nothing when closed', async () => {
    renderMenu(undefined, { isOpen: false });

    await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
  });

  it('renders icons when provided', async () => {
    renderMenu([
      {
        label: 'With Icon',
        icon: <span data-testid="test-icon">IC</span>,
        onClick: vi.fn(),
      },
    ]);

    await userEvent.keyboard('{Escape}'); // clear any focus trap
    const icon = page.getByTestId('test-icon');
    await expect.element(icon).toBeInTheDocument();
  });
});
