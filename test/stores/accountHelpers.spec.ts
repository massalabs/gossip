import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateUserKeys = vi.hoisted(() => vi.fn());

vi.mock('@massalabs/gossip-sdk', async () => {
  const actual = await vi.importActual<typeof import('@massalabs/gossip-sdk')>(
    '@massalabs/gossip-sdk'
  );
  return { ...actual, generateUserKeys };
});

import { deriveAccountFromMnemonic } from '../../src/stores/utils/accountHelpers';

describe('account identity extraction cleanup', () => {
  beforeEach(() => {
    generateUserKeys.mockReset();
  });

  it('frees UserKeys when secret wrapper extraction throws', async () => {
    const keysFree = vi.fn();
    generateUserKeys.mockResolvedValue({
      secret_keys: () => {
        throw new Error('secret extraction failed');
      },
      free: keysFree,
    });

    await expect(deriveAccountFromMnemonic('test mnemonic')).rejects.toThrow(
      'secret extraction failed'
    );
    expect(keysFree).toHaveBeenCalledOnce();
  });

  it('frees an extracted secret wrapper when public extraction throws', async () => {
    const keysFree = vi.fn();
    const secretFree = vi.fn();
    generateUserKeys.mockResolvedValue({
      secret_keys: () => ({
        massa_secret_key: new Uint8Array([1]),
        free: secretFree,
      }),
      public_keys: () => {
        throw new Error('public extraction failed');
      },
      free: keysFree,
    });

    await expect(deriveAccountFromMnemonic('test mnemonic')).rejects.toThrow(
      'public extraction failed'
    );
    expect(secretFree).toHaveBeenCalledOnce();
    expect(keysFree).toHaveBeenCalledOnce();
  });

  it('frees every wrapper when secret-byte extraction throws', async () => {
    const keysFree = vi.fn();
    const secretFree = vi.fn();
    const publicFree = vi.fn();
    const secretKeys = {
      free: secretFree,
      get massa_secret_key(): Uint8Array {
        throw new Error('secret bytes failed');
      },
    };
    generateUserKeys.mockResolvedValue({
      secret_keys: () => secretKeys,
      public_keys: () => ({ free: publicFree }),
      free: keysFree,
    });

    await expect(deriveAccountFromMnemonic('test mnemonic')).rejects.toThrow(
      'secret bytes failed'
    );
    expect(secretFree).toHaveBeenCalledOnce();
    expect(publicFree).toHaveBeenCalledOnce();
    expect(keysFree).toHaveBeenCalledOnce();
  });
});
