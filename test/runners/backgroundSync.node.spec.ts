import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const runnerSource = readFileSync(
  resolve(__dirname, '../../public/runners/background-sync.js'),
  'utf8'
);

type Handler = (
  resolve: () => void,
  reject: (error: unknown) => void,
  args: unknown
) => Promise<void>;

/** Loads the runner script in a fresh context with an in-memory KV store. */
function loadRunner(kvValues: Record<string, string>) {
  const store = new Map(Object.entries(kvValues));
  const handlers = new Map<string, Handler>();
  const fetch = vi.fn<(url: string, init?: unknown) => Promise<unknown>>(
    async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '[]',
    })
  );
  const CapacitorKV = {
    get: async (key: string) => {
      const value = store.get(key);
      return value === undefined ? undefined : { value };
    },
    set: async (key: string, value: string) => {
      if (value.startsWith('release:')) {
        if (store.get(key) === value.slice('release:'.length)) {
          store.delete(key);
        }
        return;
      }
      store.set(key, value);
    },
    remove: async (key: string) => {
      store.delete(key);
    },
  };
  runInNewContext(runnerSource, {
    addEventListener: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    CapacitorKV,
    fetch,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Promise,
    String,
    Set,
  });
  const handler = handlers.get('backgroundSync');
  if (!handler) throw new Error('backgroundSync handler not registered');
  return {
    fetch,
    run: () =>
      new Promise<void>((done, fail) => {
        void handler(done, fail, {});
      }),
  };
}

const seekers = JSON.stringify(['c2Vla2VyLTE=']);

describe('background sync runner', () => {
  it('sends no request when no API URL is stored', async () => {
    const runner = loadRunner({ 'gossip-active-seekers': seekers });

    await runner.run();

    expect(runner.fetch).not.toHaveBeenCalled();
  });

  it('fetches from the stored API URL', async () => {
    const runner = loadRunner({
      'gossip-active-seekers': seekers,
      'gossip-api-base-url': 'https://api.example.test/v2/',
    });

    await runner.run();

    expect(runner.fetch).toHaveBeenCalledTimes(1);
    expect(runner.fetch.mock.calls[0]?.[0]).toBe(
      'https://api.example.test/v2/messages/fetch'
    );
  });
});
