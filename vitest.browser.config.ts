import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { playwright } from '@vitest/browser-playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  resolve: {
    alias: {
      '@massalabs/gossip-sdk': resolve(__dirname, 'gossip-sdk/src'),
    },
  },
  test: {
    globals: true,
    setupFiles: [resolve(__dirname, 'test/setup.shared.ts')],
    include: ['test/**/*.browser.spec.{js,ts,jsx,tsx}'],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
