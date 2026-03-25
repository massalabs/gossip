import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { playwright } from '@vitest/browser-playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Dedicated Vitest config file for VSCode plugin compatibility
// The VSCode Vitest plugin specifically looks for vitest.config.* files
// This ensures the setup file with SQLite initialization is properly loaded
export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@massalabs/gossip-sdk': resolve(__dirname, 'gossip-sdk/src'),
      react: resolve(__dirname, 'node_modules/react'),
      'react-dom': resolve(__dirname, 'node_modules/react-dom'),
    },
  },
  test: {
    globals: true,

    // Use "projects" for multiple test environments
    projects: [
      // Project 1: Browser mode for component tests
      {
        extends: true,
        optimizeDeps: {
          include: [
            'react',
            'react/jsx-dev-runtime',
            'react-dom',
            'react-dom/client',
            'vitest-browser-react',
          ],
        },
        test: {
          name: 'browser',
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
          setupFiles: [resolve(__dirname, 'test/setup.browser.ts')],
          include: [
            'test/**/*.browser.{test,spec}.{ts,tsx}',
            'test/**/browser/**/*.{test,spec}.{ts,tsx}',
          ],
        },
      },

      // Project 2: jsdom for unit tests (DOM simulation - faster)
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          setupFiles: [resolve(__dirname, 'test/setup.ts')],
          include: [
            'test/**/*.jsdom.{test,spec}.{ts,tsx}',
            'test/**/jsdom/**/*.{test,spec}.{ts,tsx}',
          ],
        },
      },

      // Project 3: Node environment for pure logic tests (no DOM)
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'test/**/*.node.{test,spec}.{ts,tsx}',
            'test/**/node/**/*.{test,spec}.{ts,tsx}',
          ],
        },
      },

      // Project 4: Default jsdom for tests without suffix (catch-all)
      {
        test: {
          name: 'unit',
          environment: 'jsdom',
          setupFiles: [resolve(__dirname, 'test/setup.ts')],
          include: ['test/**/*.{test,spec}.{ts,tsx}'],
          exclude: [
            'test/**/*.browser.*',
            'test/**/*.jsdom.*',
            'test/**/*.node.*',
            'test/**/browser/**',
            'test/**/jsdom/**',
            'test/**/node/**',
          ],
        },
      },
    ],

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
