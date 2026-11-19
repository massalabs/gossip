import { describe, it, expect, vi, afterEach } from 'vitest';
import { RestMessageProtocol } from '../../src/api/messageProtocol/rest';

describe('RestMessageProtocol', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses mesh-only traffic without touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const rest = new RestMessageProtocol('http://127.0.0.1:1', 1000, 0);
    const message = {
      seeker: new Uint8Array([1]),
      ciphertext: new Uint8Array([2]),
    };
    await expect(rest.sendMessage(message, { meshOnly: true })).rejects.toThrow(
      'mesh-only'
    );
    await expect(
      rest.fetchMessages([message.seeker], { meshOnly: true })
    ).rejects.toThrow('mesh-only');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not repeat a request the server refused for good', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response('{"error":"key_taken"}', { status: 409 }) as never
      );
    const rest = new RestMessageProtocol('http://127.0.0.1:1', 1000, 3);
    await expect(
      rest.sendMessage({
        seeker: new Uint8Array([1]),
        ciphertext: new Uint8Array([2]),
      })
    ).rejects.toThrow('HTTP 409');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('repeats a request that was rate limited or failed on the server', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const status of [429, 503]) {
        const fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockImplementation(async () => new Response('{}', { status }));
        const rest = new RestMessageProtocol('http://127.0.0.1:1', 1000, 3);
        const sent = rest.sendMessage({
          seeker: new Uint8Array([1]),
          ciphertext: new Uint8Array([2]),
        });
        const checked = expect(sent).rejects.toThrow(`HTTP ${status}`);
        await vi.advanceTimersByTimeAsync(10_000);
        await checked;
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        fetchSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
