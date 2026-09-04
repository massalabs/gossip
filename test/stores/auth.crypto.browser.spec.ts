import { describe, expect, it, vi } from 'vitest';
import {
  encodeUserId,
  EncryptionKey,
  generateMnemonic,
  generateNonce,
  SessionModule,
  UserKeys,
  UserPublicKeys,
  UserSecretKeys,
} from '@massalabs/gossip-sdk';
import {
  auth,
  createPasswordSecurity,
  deriveProfileEncryptionKeyV1,
  encryptMnemonicV1,
  preparePasswordAccount,
  wipePreparedPasswordAccount,
} from '../../src/stores/utils/auth';
import { userProfile } from '../helpers/factories/userProfile';
import { deriveAccountFromMnemonic } from '../../src/stores/utils/accountHelpers';
import { PROFILE_SECURITY_V1_FIXTURE } from '../fixtures/profileSecurityV1';

function buildProfile(
  security: Awaited<ReturnType<typeof createPasswordSecurity>>['security']
) {
  const profile = userProfile().build();
  profile.security = security;
  return profile;
}

describe('profile password encryption integration', () => {
  it('preserves the frozen profile encryption and identity vector', async () => {
    await generateNonce();
    const { mnemonic } = PROFILE_SECURITY_V1_FIXTURE;
    const profile = userProfile().build();
    profile.security.encKeySalt = Uint8Array.from(
      PROFILE_SECURITY_V1_FIXTURE.encryptionKeySaltHex
        .match(/.{2}/g)!
        .map(byte => Number.parseInt(byte, 16))
    );
    const { encryptedMnemonicHex } = PROFILE_SECURITY_V1_FIXTURE;
    profile.security.mnemonicBackup.encryptedMnemonic = Uint8Array.from(
      encryptedMnemonicHex
        .match(/.{2}/g)!
        .map(byte => Number.parseInt(byte, 16))
    );
    const writerKey = await deriveProfileEncryptionKeyV1(
      PROFILE_SECURITY_V1_FIXTURE.password,
      profile.security.encKeySalt
    );
    const emitted = await encryptMnemonicV1(
      mnemonic,
      writerKey,
      profile.security.encKeySalt
    );
    expect(
      Array.from(emitted, byte => byte.toString(16).padStart(2, '0')).join('')
    ).toBe(encryptedMnemonicHex);
    emitted.fill(0);
    writerKey.free();

    const authenticated = await auth(
      profile,
      PROFILE_SECURITY_V1_FIXTURE.password
    );
    expect(authenticated.mnemonic).toBe(mnemonic);
    const derived = await deriveAccountFromMnemonic(
      authenticated.mnemonic,
      profile.security.identityDerivationVersion
    );
    expect(encodeUserId(derived.userIdBytes)).toBe(
      PROFILE_SECURITY_V1_FIXTURE.userId
    );
    expect(derived.evmAddress).toBe(PROFILE_SECURITY_V1_FIXTURE.evmAddress);
    expect(derived.massaAddress).toBe(PROFILE_SECURITY_V1_FIXTURE.massaAddress);

    derived.account.privateKey.toBytes().fill(0);
    authenticated.encryptionKey.free();
  });

  it('keeps a generated account signing key after transient derivation cleanup', async () => {
    const mnemonic = await generateMnemonic();
    const message = crypto.getRandomValues(new Uint8Array(32));
    const { account } = await deriveAccountFromMnemonic(mnemonic);

    try {
      const signature = await account.sign(message);
      await expect(account.verify(message, signature)).resolves.toBe(true);
    } finally {
      message.fill(0);
      account.privateKey.toBytes().fill(0);
    }
  });

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

  it('restores the deterministic identity with fresh backed-up security', async () => {
    const prepared = await preparePasswordAccount(
      PROFILE_SECURITY_V1_FIXTURE.mnemonic,
      'fresh-destination-password',
      true
    );

    try {
      expect(prepared.security.mnemonicBackup.backedUp).toBe(true);
      expect(prepared.security.encKeySalt).not.toEqual(
        Uint8Array.from(
          PROFILE_SECURITY_V1_FIXTURE.encryptionKeySaltHex
            .match(/.{2}/g)!
            .map(byte => Number.parseInt(byte, 16))
        )
      );
      const authenticated = await auth(
        buildProfile(prepared.security),
        'fresh-destination-password'
      );
      const derived = await deriveAccountFromMnemonic(authenticated.mnemonic);
      expect(encodeUserId(derived.userIdBytes)).toBe(
        PROFILE_SECURITY_V1_FIXTURE.userId
      );
      expect(derived.evmAddress).toBe(PROFILE_SECURITY_V1_FIXTURE.evmAddress);
      expect(derived.massaAddress).toBe(
        PROFILE_SECURITY_V1_FIXTURE.massaAddress
      );
      derived.account.privateKey.toBytes().fill(0);
      authenticated.encryptionKey.free();
    } finally {
      wipePreparedPasswordAccount(prepared);
    }
  });

  it('rejects unsupported security versions before password derivation', async () => {
    const mnemonic = await generateMnemonic();
    const created = await createPasswordSecurity(mnemonic, 'correct-password');
    const profile = buildProfile(created.security);
    const security = profile.security as unknown as Record<string, unknown>;
    const deriveSpy = vi.spyOn(EncryptionKey, 'from_seed');

    for (const field of [
      'formatVersion',
      'passwordKdfVersion',
      'mnemonicEncryptionVersion',
      'identityDerivationVersion',
    ]) {
      security[field] = 2;
      await expect(auth(profile, 'correct-password')).rejects.toThrow(
        'Unsupported account security format'
      );
      security[field] = 1;
    }
    const originalSalt = profile.security.encKeySalt;
    (profile.security as unknown as Record<string, unknown>).encKeySalt =
      '1234567890123456';
    await expect(auth(profile, 'correct-password')).rejects.toThrow(
      'Account is missing encryption key salt'
    );
    profile.security.encKeySalt = originalSalt;
    expect(deriveSpy).not.toHaveBeenCalled();
    deriveSpy.mockRestore();
    created.encryptionKey.free();
  });

  it('rejects malformed mnemonic envelopes before password derivation', async () => {
    const mnemonic = await generateMnemonic();
    const created = await createPasswordSecurity(mnemonic, 'correct-password');
    const profile = buildProfile(created.security);
    const security = profile.security as unknown as Record<string, unknown>;
    const originalMnemonicBackup = security.mnemonicBackup;
    const deriveSpy = vi.spyOn(EncryptionKey, 'from_seed');

    for (const malformed of [undefined, null, 'invalid', {}]) {
      security.mnemonicBackup = malformed;
      await expect(auth(profile, 'correct-password')).rejects.toThrow(
        'Account has an invalid encrypted mnemonic'
      );
    }

    security.mnemonicBackup = originalMnemonicBackup;
    expect(deriveSpy).not.toHaveBeenCalled();
    deriveSpy.mockRestore();
    created.encryptionKey.free();
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
