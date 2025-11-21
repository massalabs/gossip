import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { ViteImageOptimizer } from 'vite-plugin-image-optimizer';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import mkcert from 'vite-plugin-mkcert';

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
      injectRegister: 'auto',

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
            purpose: 'any maskable',
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
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // 3MB (increased from default 2MB for crypto polyfills)
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
});
