import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateNonce: vi.fn(),
}));

vi.mock('@massalabs/gossip-sdk', async () => {
  const actual = await vi.importActual<typeof import('@massalabs/gossip-sdk')>(
    '@massalabs/gossip-sdk'
  );
  return {
    ...actual,
    generateNonce: mocks.generateNonce,
  };
});

import { preparePasswordAccount } from '../../src/stores/utils/auth';

describe('password account preflight failure cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wipes mutable mnemonic bytes when password security creation fails', async () => {
    const mnemonic = 'abandon '.repeat(23) + 'about';
    const originalEncode = TextEncoder.prototype.encode;
    let mnemonicBytes: Uint8Array | undefined;
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
      input?: string
    ) {
      const encoded = originalEncode.call(this, input);
      if (input === mnemonic) mnemonicBytes = encoded;
      return encoded;
    });
    mocks.generateNonce.mockRejectedValue(new Error('nonce failed'));

    await expect(
      preparePasswordAccount(mnemonic, 'account-password')
    ).rejects.toThrow('nonce failed');

    expect(mnemonicBytes).toBeDefined();
    expect(mnemonicBytes?.every(byte => byte === 0)).toBe(true);
  });
});
