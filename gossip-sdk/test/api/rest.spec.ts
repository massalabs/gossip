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
});
