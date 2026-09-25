import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type ConfigEnv } from 'vite';
import viteConfig from '../../vite.config';

const dev: ConfigEnv = { command: 'serve', mode: 'development' };

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['HTTP web dev', 'http://localhost:40001', dev, '', true],
  ['HTTPS web dev', 'https://api.usegossip.com', dev, '', false],
  ['unset API', '', dev, '', false],
  [
    'native live reload',
    'http://localhost:40001',
    dev,
    'https://192.168.1.2:5173',
    false,
  ],
  ['preview', 'http://localhost:40001', { ...dev, isPreview: true }, '', false],
  [
    'build in development mode',
    'http://localhost:40001',
    { ...dev, command: 'build' },
    '',
    false,
  ],
] as const)(
  '%s keeps HTTPS and scopes the proxy to web dev',
  (_name, apiUrl, env, nativeUrl, proxied) => {
    vi.stubEnv('VITE_GOSSIP_API_URL', apiUrl);
    vi.stubEnv('DEV_SERVER_URL', nativeUrl);
    const config = viteConfig(env);

    expect(config.plugins).toContainEqual(
      expect.objectContaining({ name: 'vite:plugin:mkcert' })
    );
    expect(config.define?.['import.meta.env.VITE_GOSSIP_API_URL']).toBe(
      proxied ? JSON.stringify('/__gossip_api') : undefined
    );
    expect(Boolean(config.server?.proxy)).toBe(proxied);
    expect(config.preview?.proxy).toBeUndefined();
  }
);

it('forwards API paths, query strings and POST bodies to the HTTP backend', async () => {
  const backend = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString(),
      })
    );
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let root: string | undefined;
  try {
    root = await mkdtemp(join(tmpdir(), 'vite-proxy-test-'));
    const address = backend.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing backend port');
    vi.stubEnv('VITE_GOSSIP_API_URL', `http://127.0.0.1:${address.port}/node/`);
    vi.stubEnv('DEV_SERVER_URL', '');
    const config = viteConfig(dev);
    const browserApiUrl = JSON.parse(
      config.define!['import.meta.env.VITE_GOSSIP_API_URL']
    );

    // Exercise Vite's actual proxy without installing certificates in the test runner.
    server = await createServer({
      configFile: false,
      root,
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, proxy: config.server?.proxy },
    });
    await server.listen();
    const origin = server.resolvedUrls!.local[0];
    const response = await fetch(
      `${origin}${browserApiUrl.slice(1)}/api/auth?test=1`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"test":true}',
      }
    );
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({
      method: 'POST',
      url: '/node/api/auth?test=1',
      body: '{"test":true}',
    });
  } finally {
    try {
      await server?.close();
      await new Promise<void>((resolve, reject) =>
        backend.close(error => (error ? reject(error) : resolve()))
      );
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
  }
});
