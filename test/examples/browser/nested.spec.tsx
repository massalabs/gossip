import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import Button from '../../../src/components/ui/Button';

describe('Button (nested browser folder)', () => {
  it('works in nested path test/examples/browser/', async () => {
    await render(<Button>Nested Test</Button>);

    const button = page.getByRole('button', { name: /nested test/i });
    await expect.element(button).toBeInTheDocument();
  });
});
