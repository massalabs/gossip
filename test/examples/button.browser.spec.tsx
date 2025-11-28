// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import Button from '../../src/components/ui/Button';

describe('Button Component', () => {
  it('renders with children text', async () => {
    await render(<Button>Click me</Button>);

    // Use page API for querying and expect.element for assertions
    const button = page.getByRole('button', { name: /click me/i });
    await expect.element(button).toBeInTheDocument();
    await expect.element(button).toHaveTextContent('Click me');
  });

  it('handles click interactions', async () => {
    let clicked = false;
    const handleClick = () => {
      clicked = true;
    };

    await render(<Button onClick={handleClick}>Click me</Button>);

    // Use page API for interactions
    const button = page.getByRole('button', { name: /click me/i });
    await button.click();

    // Verify the click handler was called
    expect(clicked).toBe(true);
  });

  it('disables button when disabled prop is true', async () => {
    await render(<Button disabled>Disabled Button</Button>);

    const button = page.getByRole('button', { name: /disabled button/i });
    await expect.element(button).toBeDisabled();
  });

  it('shows loading spinner when loading prop is true', async () => {
    await render(<Button loading>Loading Button</Button>);

    // Check for loading spinner (div with animate-spin class)
    const spinner = page
      .getByRole('button')
      .element()
      .querySelector('.animate-spin');
    expect(spinner).toBeTruthy();
  });

  it('applies correct variant classes', async () => {
    const { unmount } = await render(
      <Button variant="primary">Primary</Button>
    );

    const primaryButton = page.getByRole('button', { name: /primary/i });
    await expect.element(primaryButton).toHaveClass('bg-primary');

    // Test secondary variant
    unmount();
    await render(<Button variant="secondary">Secondary</Button>);

    const secondaryButton = page.getByRole('button', { name: /secondary/i });
    await expect.element(secondaryButton).toHaveClass('bg-secondary');
  });

  it('applies correct size classes', async () => {
    await render(<Button size="sm">Small Button</Button>);

    const button = page.getByRole('button', { name: /small button/i });
    await expect.element(button).toHaveClass('px-3');
    await expect.element(button).toHaveClass('py-2');
  });

  it('applies fullWidth class when fullWidth prop is true', async () => {
    await render(<Button fullWidth>Full Width</Button>);

    const button = page.getByRole('button', { name: /full width/i });
    await expect.element(button).toHaveClass('w-full');
  });

  it('uses correct button type attribute', async () => {
    const { unmount } = await render(<Button type="submit">Submit</Button>);

    const submitButton = page.getByRole('button', { name: /submit/i });
    await expect.element(submitButton).toHaveAttribute('type', 'submit');

    unmount();

    await render(<Button>Default</Button>);
    const defaultButton = page.getByRole('button', { name: /default/i });
    await expect.element(defaultButton).toHaveAttribute('type', 'button');
  });
});
