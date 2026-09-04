import { describe, expect, it, vi } from 'vitest';
import {
  UserKeys,
  UserPublicKeys,
  UserSecretKeys,
} from '../../src/wasm/bindings';
import { SessionModule } from '../../src/wasm/session';

describe('SessionModule construction cleanup', () => {
  it('frees partially extracted identity wrappers when construction throws', () => {
    const publicFree = vi.fn();
    const secretFree = vi.fn();
    const publicKeys = {
      derive_id: () => {
        throw new Error('derive failed');
      },
      free: publicFree,
    } as unknown as UserPublicKeys;
    const secretKeys = {
      free: secretFree,
    } as unknown as UserSecretKeys;
    const userKeys = {
      public_keys: () => publicKeys,
      secret_keys: () => secretKeys,
    } as unknown as UserKeys;

    expect(() => new SessionModule(userKeys)).toThrow('derive failed');
    expect(publicFree).toHaveBeenCalledOnce();
    expect(secretFree).toHaveBeenCalledOnce();
  });
});
