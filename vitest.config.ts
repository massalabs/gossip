import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dedicated Vitest config file for VSCode plugin compatibility
// The VSCode Vitest plugin specifically looks for vitest.config.* files
// This ensures the setup file with fake-indexeddb is properly loaded
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Use absolute path to ensure VSCode extension can find it
    // The extension resolves paths relative to the config file location
    setupFiles: [resolve(__dirname, 'test/setup.ts')],
    include: ['test/**/*.{test,spec}.{js,ts,jsx,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData',
        'gossip-sdk/src/assets/generated/wasm/**',
      ],
    },
  },
});
