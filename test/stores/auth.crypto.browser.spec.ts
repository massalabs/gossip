import { describe, expect, it, vi } from 'vitest';
import { EncryptionKey, generateMnemonic } from '@massalabs/gossip-sdk';
import { auth, createPasswordSecurity } from '../../src/stores/utils/auth';
import { userProfile } from '../helpers/factories/userProfile';

function buildProfile(
  security: Awaited<ReturnType<typeof createPasswordSecurity>>['security']
) {
  const profile = userProfile().build();
  profile.security = security;
  return profile;
}

describe('profile password encryption integration', () => {
  it('round-trips account creation security through login and backup authentication', async () => {
    const mnemonic = await generateMnemonic();
    const password = 'real profile password 2026!';
    const created = await createPasswordSecurity(mnemonic, password);
    const profile = buildProfile(created.security);

    expect(created.security.authMethod).toBe('password');
    expect(created.security.mnemonicBackup.encryptedMnemonic).not.toEqual(
      new TextEncoder().encode(mnemonic)
    );

    const authenticated = await auth(profile, password);
    expect(authenticated.mnemonic).toBe(mnemonic);

    created.encryptionKey.free();
    authenticated.encryptionKey.free();
  });

  it('rejects missing and wrong passwords and frees a failed derived key', async () => {
    const mnemonic = await generateMnemonic();
    const created = await createPasswordSecurity(mnemonic, 'correct-password');
    const profile = buildProfile(created.security);
    const freeSpy = vi.spyOn(EncryptionKey.prototype, 'free');

    await expect(auth(profile)).rejects.toThrow(
      'Password is required for authentication'
    );
    expect(freeSpy).not.toHaveBeenCalled();

    await expect(auth(profile, 'wrong-password')).rejects.toThrow(
      'Authentication failed'
    );
    expect(freeSpy).toHaveBeenCalledTimes(1);

    freeSpy.mockRestore();
    created.encryptionKey.free();
  });
});
