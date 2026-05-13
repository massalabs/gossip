import path from 'path';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig, type Plugin } from 'vite';
import { transformSync } from 'esbuild';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { ViteImageOptimizer } from 'vite-plugin-image-optimizer';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import mkcert from 'vite-plugin-mkcert';
// @ts-expect-error — vite-plugin-cross-origin-isolation has no .d.ts
import crossOriginIsolation from 'vite-plugin-cross-origin-isolation';

const consoleCallPattern =
  /(?:[A-Za-z_$][\w$]*\.)?console\.(?:log|debug|info|warn|error)\s*\(/g;

function stripConsoleCalls(source: string): string {
  let output = '';
  let cursor = 0;

  for (const match of source.matchAll(consoleCallPattern)) {
    // RegExp match indices are present for matchAll results, but TS types them
    // as optional in some lib versions.
    if (match.index === undefined) continue;

    const start = match.index;
    let index = start + match[0].length;
    let depth = 1;
    let quote: string | null = null;

    while (index < source.length && depth > 0) {
      const char = source[index];
      const prev = source[index - 1];

      if (quote) {
        if (char === quote && prev !== '\\') quote = null;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
      }

      index++;
    }

    output += source.slice(cursor, start);
    output += 'void 0';
    cursor = index;
  }

  output += source.slice(cursor);
  return output;
}

function stripReleaseConsolePlugin(): Plugin {
  const strip = (code: string): string => {
    const transformed = transformSync(code, {
      loader: 'js',
      target: 'esnext',
      format: 'esm',
      drop: ['console', 'debugger'],
      minify: true,
    }).code;

    return stripConsoleCalls(transformed);
  };

  return {
    name: 'strip-release-console',
    apply: 'build',
    renderChunk(code) {
      return {
        code: strip(code),
        map: null,
      };
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') {
          item.code = strip(item.code);
        } else if (
          item.fileName.endsWith('.js') &&
          typeof item.source === 'string'
        ) {
          item.source = strip(item.source);
        }
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    stripReleaseConsolePlugin(),
    react(),
    tailwindcss(),
    mkcert(), // ← Enables HTTPS locally
    crossOriginIsolation(), // ← Sets COOP/COEP for SharedArrayBuffer (rayon WASM)
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
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024, // 6MB (crypto polyfills, QR scanner, WASM)
      },

      devOptions: {
        enabled: true, // Enable service workers in dev mode for testing
        navigateFallback: 'index.html',
        suppressWarnings: true,
        type: 'module',
      },
    }),
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@massalabs/gossip-sdk': path.resolve(__dirname, 'gossip-sdk/src'),
    },
  },
  assetsInclude: ['**/*.wasm'],
  server: {
    fs: {
      allow: ['..'],
    },
    // Required for SharedArrayBuffer (used by wasm-bindgen-rayon to spawn
    // rayon thread pool from Web Workers). Without these headers, the
    // browser refuses to instantiate the WASM module with shared memory.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'esnext',
  },
  worker: {
    format: 'es',
  },
});
