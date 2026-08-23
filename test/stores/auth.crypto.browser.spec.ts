import { describe, expect, it, vi } from 'vitest';
import {
  EncryptionKey,
  generateMnemonic,
  SessionModule,
  UserKeys,
  UserPublicKeys,
  UserSecretKeys,
} from '@massalabs/gossip-sdk';
import {
  auth,
  createPasswordSecurity,
  preparePasswordAccount,
  wipePreparedPasswordAccount,
} from '../../src/stores/utils/auth';
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

  it('preflights an encrypted session entirely in RAM and wipes it', async () => {
    const mnemonic = await generateMnemonic();
    const password = 'RAM preflight password 2026!';

    const userKeysFree = vi.spyOn(UserKeys.prototype, 'free');
    const publicKeysFree = vi.spyOn(UserPublicKeys.prototype, 'free');
    const secretKeysFree = vi.spyOn(UserSecretKeys.prototype, 'free');
    const sessionDispose = vi.spyOn(SessionModule.prototype, 'dispose');

    const prepared = await preparePasswordAccount(mnemonic, password);

    expect(userKeysFree).toHaveBeenCalledTimes(2);
    expect(publicKeysFree).toHaveBeenCalledTimes(2);
    expect(secretKeysFree).toHaveBeenCalledTimes(2);
    expect(sessionDispose).toHaveBeenCalledTimes(2);
    expect(new TextDecoder().decode(prepared.mnemonicBytes)).toBe(mnemonic);
    expect(prepared.encryptedSession.byteLength).toBeGreaterThan(0);
    const authenticated = await auth(buildProfile(prepared.security), password);
    expect(authenticated.mnemonic).toBe(mnemonic);
    authenticated.encryptionKey.free();

    wipePreparedPasswordAccount(prepared);
    expect(prepared.mnemonicBytes.every(byte => byte === 0)).toBe(true);
    expect(prepared.encryptedSession.every(byte => byte === 0)).toBe(true);
    expect(prepared.security.encKeySalt.every(byte => byte === 0)).toBe(true);
    expect(
      prepared.security.mnemonicBackup.encryptedMnemonic.every(
        byte => byte === 0
      )
    ).toBe(true);

    userKeysFree.mockRestore();
    publicKeysFree.mockRestore();
    secretKeysFree.mockRestore();
    sessionDispose.mockRestore();
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
