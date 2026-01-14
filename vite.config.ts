import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { ViteImageOptimizer } from 'vite-plugin-image-optimizer';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import mkcert from 'vite-plugin-mkcert';
import { playwright } from '@vitest/browser-playwright';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    mkcert(), // ← Enables HTTPS locally
    nodePolyfills({
      // Whether to polyfill `node:` protocol imports.
      protocolImports: true,
    }),
    ViteImageOptimizer({
      // SVG optimization with SVGO
      svg: {
        multipass: true,
        plugins: [
          {
            name: 'preset-default',
            params: {
              overrides: {
                // Keep viewBox for responsive SVGs (important for your logo)
                removeViewBox: false,
                // Remove width/height attributes for better scalability
                removeDimensions: true,
                // Keep important attributes
                removeUselessStrokeAndFill: false,
                // Optimize paths but keep them readable
                convertPathData: {
                  floatPrecision: 2,
                },
              },
            },
          },
          // Sort attributes for better compression
          'sortAttrs',
        ],
      },
      // Process images from public directory and assets
      test: /\.(svg|png|jpg|jpeg|webp)$/,
      // Include files from both public and src directories
      include: ['**/*.svg', '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.webp'],
      // Exclude already optimized files
      exclude: ['**/*.min.*'],
      // Enable verbose logging
      logStats: true,
    }),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,

      pwaAssets: {
        disabled: false,
        config: true,
      },

      manifest: {
        name: 'Gossip',
        short_name: 'Gossip',
        description: 'Private messaging app',
        theme_color: '#0d9488',
        background_color: '#f8f9fa',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/favicon/apple-touch-icon.png',
            sizes: '180x180',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/favicon/web-app-manifest-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/favicon/web-app-manifest-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/favicon/favicon-96x96.png',
            sizes: '96x96',
            type: 'image/png',
            purpose: 'any',
          },
        ],
        categories: ['social', 'communication'],
      },

      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // 4MB (increased for crypto polyfills and QR scanner dependencies)
      },

      devOptions: {
        enabled: true, // Enable service workers in dev mode for testing
        navigateFallback: 'index.html',
        suppressWarnings: true,
        type: 'module',
      },
    }),
  ],
  assetsInclude: ['**/*.wasm'],
  server: {
    fs: {
      allow: ['..'],
    },
  },
  build: {
    target: 'esnext',
  },
  test: {
    globals: true,

    // Use "projects" for multiple test environments (replaces deprecated workspace)
    projects: [
      // Project 1: Browser mode for component tests
      {
        test: {
          name: 'browser',
          browser: {
            enabled: true,
            provider: playwright({
              launch: {
                // Enable video recording (kept on failure for debugging)
                video: 'retain-on-failure',
                // Enable trace for interactive debugging
                trace: 'retain-on-failure',
                // Capture screenshots on failure
                screenshot: 'only-on-failure',
              },
            }),
            headless: true,
            instances: [
              { browser: 'chromium' },
              // { browser: 'webkit' },
              // { browser: 'firefox' },
            ],
          },
          setupFiles: ['./test/setup.browser.ts'],

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
          setupFiles: ['./test/setup.ts'],
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
          // Support both patterns anywhere:
          // - test/**/*.node.{test,spec}.{ts,tsx} (suffix pattern - anywhere)
          // - test/**/node/**/*.{test,spec}.{ts,tsx} (folder pattern - anywhere)
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
          setupFiles: ['./test/setup.ts'],
          // Catch all test files that don't match specific patterns
          include: ['test/**/*.{test,spec}.{ts,tsx}'],
          exclude: [
            // Exclude suffix patterns
            'test/**/*.browser.*',
            'test/**/*.jsdom.*',
            'test/**/*.node.*',
            // Exclude folder patterns (anywhere in path)
            'test/**/browser/**',
            'test/**/jsdom/**',
            'test/**/node/**',
          ],
        },
      },
    ],

    // Global coverage settings (shared by all projects)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData',
        'src/assets/generated/wasm/**',
      ],
    },
    // Output directory for test artifacts (screenshots, videos, traces)
    outputFile: {
      // Playwright artifacts are saved to test-results/ by default
    },
  },
});
