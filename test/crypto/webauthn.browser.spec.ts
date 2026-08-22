import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateEncryptionKeyFromSeed: vi.fn(async () => ({
    __wbg_ptr: 1,
    free: vi.fn(),
  })),
}));

vi.mock('@massalabs/gossip-sdk', async () => {
  const actual = await vi.importActual<typeof import('@massalabs/gossip-sdk')>(
    '@massalabs/gossip-sdk'
  );
  return {
    ...actual,
    generateEncryptionKeyFromSeed: mocks.generateEncryptionKeyFromSeed,
  };
});

import { createWebAuthnCredential } from '../../src/crypto/webauthn';

describe('WebAuthn biometric credential creation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends anonymous generic user metadata to the browser', async () => {
    const prfOutput = new Uint8Array(32).fill(7).buffer;
    const credential = {
      rawId: new Uint8Array([1, 2, 3]).buffer,
      getClientExtensionResults: () => ({
        prf: { enabled: true, results: { first: prfOutput } },
      }),
    } as unknown as PublicKeyCredential;
    const createSpy = vi
      .spyOn(navigator.credentials, 'create')
      .mockResolvedValue(credential);
    vi.spyOn(
      PublicKeyCredential,
      'isUserVerifyingPlatformAuthenticatorAvailable'
    ).mockResolvedValue(true);
    const prfSalt = new Uint8Array(32).fill(9);

    await createWebAuthnCredential(prfSalt);

    const options = createSpy.mock.calls[0][0] as CredentialCreationOptions;
    const publicKey = options.publicKey;
    expect(publicKey).toBeDefined();
    expect(publicKey?.rp).toEqual({
      name: 'Gossip',
      id: window.location.hostname,
    });
    expect(publicKey?.user.name).toBe('Gossip biometric login');
    expect(publicKey?.user.displayName).toBe('Gossip biometric login');
    expect(new Uint8Array(publicKey?.user.id as ArrayBuffer)).toHaveLength(32);
    expect(publicKey?.authenticatorSelection).toEqual(
      expect.objectContaining({
        authenticatorAttachment: 'platform',
        userVerification: 'required',
      })
    );
    expect(publicKey?.extensions?.prf?.eval?.first).toBe(prfSalt);

    const serializedLabels = JSON.stringify({
      rp: publicKey?.rp,
      name: publicKey?.user.name,
      displayName: publicKey?.user.displayName,
    });
    expect(serializedLabels).not.toContain('alice');
    expect(serializedLabels).not.toContain('gossip1');
    expect(serializedLabels).not.toContain('slot');
  });
});
