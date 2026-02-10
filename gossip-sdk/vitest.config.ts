import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [resolve(__dirname, 'test/setup.ts')],
    include: ['test/**/*.{test,spec}.{js,ts}', 'test/**/*.e2e.{js,ts}'],
    // Isolate each file so sdk-lifecycle.spec.ts mocks don't leak into other files
    isolate: true,
    // Run tests sequentially to avoid database conflicts
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'test/', '**/*.d.ts', '**/*.config.*'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
