import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import Button from '../../../../src/components/ui/Button';

describe('E2E Integration (nested browser folder)', () => {
  it('works in test/integration/browser/', async () => {
    await render(<Button variant="primary">E2E Test</Button>);

    const button = page.getByRole('button', { name: /e2e test/i });
    await expect.element(button).toBeInTheDocument();
    await expect.element(button).toHaveClass('bg-primary');
  });
});
