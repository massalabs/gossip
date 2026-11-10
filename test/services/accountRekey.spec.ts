import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  admit: vi.fn<(password: string, next?: string) => Promise<boolean>>(),
  unlock: vi.fn<(password: string) => Promise<boolean>>(),
  commit: vi.fn<() => Promise<void>>(),
  refresh: vi.fn<() => Promise<void>>(),
  epoch: 'epoch-1',
  storageState: 'locked',
  profile: null as Record<string, unknown> | null,
  saved: [] as Array<Record<string, unknown>>,
  auth: vi.fn(),
  createPasswordSecurity: vi.fn(),
  logout: vi.fn(async () => {}),
  userProfile: null as Record<string, unknown> | null,
}));

function fakeSdk() {
  const note = (name: string) => mocks.calls.push(name);
  return {
    isSecureStorage: true,
    isSessionOpen: true,
    usesSessionBlobNamespace: true,
    get accountGenerationEpoch() {
      return mocks.epoch;
    },
    get storageState() {
      return mocks.storageState;
    },
    secureStorageBeginRekey: async () => note('begin'),
    secureStorageAdmitRekey: async (password: string, next?: string) => {
      note(`admit:${password}${next ? `->${next}` : ''}`);
      return mocks.admit(password, next);
    },
    secureStorageBuildRekeyCandidate: async () => note('build'),
    secureStorageUnlock: async (password: string) => {
      note(`unlock:${password}`);
      const ok = await mocks.unlock(password);
      if (ok) mocks.storageState = 'unlocked';
      return ok;
    },
    secureStorageLock: async () => {
      note('lock');
      mocks.storageState = 'locked';
    },
    secureStorageCommitRekeyCandidate: async () => {
      note('commit');
      await mocks.commit();
    },
    secureStorageAbortRekey: async () => note('abort'),
    refreshAccountGenerationState: async () => {
      await mocks.refresh();
    },
    readSessionBlob: async () => null,
    persistSessionBlob: async () => note('persistSession'),
    profiles: {
      getMostRecent: async () => mocks.profile,
      save: async (profile: Record<string, unknown>) => {
        mocks.saved.push(profile);
        mocks.profile = profile;
      },
    },
  };
}

const sdk = fakeSdk();

vi.mock('../../src/stores/sdkStore', () => ({ getSdk: () => sdk }));
vi.mock('../../src/stores/accountStore', () => ({
  useAccountStore: {
    getState: () => ({ userProfile: mocks.userProfile, logout: mocks.logout }),
  },
}));
vi.mock('../../src/stores/utils/auth', () => ({
  auth: mocks.auth,
  createPasswordSecurity: mocks.createPasswordSecurity,
}));
vi.mock('@massalabs/gossip-sdk', () => ({
  generateUserKeys: vi.fn(),
  SessionModule: vi.fn(),
}));

import {
  RekeyRejectedError,
  rekeyLockedStore,
  startRekey,
} from '../../src/services/accountRekey';
import { useRekeyStore } from '../../src/stores/rekeyStore';

const key = () => ({ free: vi.fn(), __wbg_ptr: 1 });
const profile = (extra: Record<string, unknown> = {}) => ({
  userId: 'gossip1test',
  session: new Uint8Array(0),
  security: {
    encKeySalt: new Uint8Array(16).fill(1),
    mnemonicBackup: {
      encryptedMnemonic: new Uint8Array(32).fill(2),
      createdAt: new Date(0),
      backedUp: true,
    },
    ...extra,
  },
});
const account = (oldPassword: string, finalPassword = oldPassword) => ({
  oldPassword,
  finalPassword,
  clearsPasswordless: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.saved.length = 0;
  mocks.epoch = 'epoch-1';
  mocks.storageState = 'locked';
  mocks.profile = profile();
  mocks.userProfile = profile();
  mocks.admit.mockResolvedValue(true);
  mocks.unlock.mockResolvedValue(true);
  mocks.commit.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.auth.mockImplementation(async () => ({
    mnemonic: 'the mnemonic',
    encryptionKey: key(),
  }));
  mocks.createPasswordSecurity.mockImplementation(async () => ({
    security: {
      encKeySalt: new Uint8Array(16).fill(9),
      mnemonicBackup: {
        encryptedMnemonic: new Uint8Array(32).fill(8),
        createdAt: new Date(),
        backedUp: false,
      },
    },
    encryptionKey: key(),
  }));
  useRekeyStore.getState().setStatus('idle');
});

describe('rekeyLockedStore', () => {
  it('admits every account, rewrites each one the same way, then commits', async () => {
    const result = await rekeyLockedStore(sdk as never, [
      account('alice', 'alice-new'),
      account('bob'),
    ]);

    expect(mocks.calls).toEqual([
      'begin',
      'admit:alice->alice-new',
      'admit:bob',
      'build',
      'unlock:alice-new',
      'lock',
      'unlock:bob',
      'lock',
      'commit',
    ]);
    expect(result.reloadRequired).toBe(false);
    // Both accounts got a fresh inner salt and re-encrypted recovery phrase,
    // whether or not their password changed.
    expect(mocks.saved).toHaveLength(2);
    for (const saved of mocks.saved) {
      const security = saved.security as ReturnType<typeof profile>['security'];
      expect(security.encKeySalt).toEqual(new Uint8Array(16).fill(9));
      expect(security.mnemonicBackup.encryptedMnemonic).toEqual(
        new Uint8Array(32).fill(8)
      );
      // Backup state is preserved, not reset.
      expect(security.mnemonicBackup.backedUp).toBe(true);
      expect(security.mnemonicBackup.createdAt).toEqual(new Date(0));
    }
  });

  it('still admits the remaining accounts after a rejection, then changes nothing', async () => {
    mocks.admit.mockImplementation(async password => password !== 'wrong');

    await expect(
      rekeyLockedStore(sdk as never, [
        account('alice', 'alice-new'),
        account('wrong'),
        account('bob'),
      ])
    ).rejects.toBeInstanceOf(RekeyRejectedError);

    expect(mocks.calls).toEqual([
      'begin',
      'admit:alice->alice-new',
      'admit:wrong',
      'admit:bob',
      'abort',
    ]);
  });

  it('ignores a biometric secret that opens no account', async () => {
    mocks.admit.mockImplementation(async password => password !== 'stale');

    const result = await rekeyLockedStore(
      sdk as never,
      [account('alice')],
      ['stale']
    );

    expect(result.kept.map(kept => kept.oldPassword)).toEqual(['alice']);
    expect(mocks.calls.at(-1)).toBe('commit');
  });

  it('locks and aborts when rewriting an account fails', async () => {
    mocks.auth.mockRejectedValueOnce(new Error('cannot decrypt'));

    await expect(
      rekeyLockedStore(sdk as never, [account('alice', 'alice-new')])
    ).rejects.toThrow('cannot decrypt');

    expect(mocks.calls).toEqual([
      'begin',
      'admit:alice->alice-new',
      'build',
      'unlock:alice-new',
      'lock',
      'abort',
    ]);
    expect(mocks.calls).not.toContain('commit');
  });

  it('removes the passwordless marker only when a typed password replaces the secret', async () => {
    mocks.profile = profile({ passwordless: true });
    await rekeyLockedStore(sdk as never, [
      {
        oldPassword: 'secret',
        finalPassword: 'typed',
        clearsPasswordless: true,
      },
    ]);
    expect(
      (mocks.saved[0].security as Record<string, unknown>).passwordless
    ).toBeUndefined();

    mocks.saved.length = 0;
    mocks.profile = profile({ passwordless: true });
    await rekeyLockedStore(sdk as never, [account('secret')]);
    expect(
      (mocks.saved[0].security as Record<string, unknown>).passwordless
    ).toBe(true);
  });

  it('asks storage which generation is active when the commit answer is lost', async () => {
    mocks.commit.mockRejectedValue(new Error('response lost'));
    mocks.refresh.mockImplementation(async () => {
      mocks.epoch = 'epoch-2';
    });
    const committed = await rekeyLockedStore(sdk as never, [account('alice')]);
    expect(committed.reloadRequired).toBe(true);
    expect(mocks.calls).not.toContain('abort');

    mocks.calls.length = 0;
    mocks.epoch = 'epoch-1';
    mocks.refresh.mockResolvedValue(undefined);
    await expect(
      rekeyLockedStore(sdk as never, [account('alice')])
    ).rejects.toThrow('response lost');
    expect(mocks.calls.at(-1)).toBe('abort');
  });
});

describe('startRekey', () => {
  const biometric = (password: string) => ({
    password,
    replace: vi.fn(async () => {}),
    dispose: vi.fn(),
  });

  it('refuses a wrong current password before logging out', async () => {
    mocks.auth.mockRejectedValueOnce(new Error('Authentication failed'));
    await expect(
      startRekey({
        currentPassword: 'nope',
        newPassword: 'next',
        otherPasswords: [],
        biometric: null,
      })
    ).rejects.toThrow('Authentication failed');
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(useRekeyStore.getState().status).toBe('idle');
  });

  it('logs out, rekeys, and stores the new password behind biometrics', async () => {
    const handle = biometric('current');
    await startRekey({
      currentPassword: 'current',
      newPassword: 'next',
      otherPasswords: ['other', ''],
      biometric: handle,
    });

    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.calls.slice(0, 4)).toEqual([
      'begin',
      'admit:current->next',
      'admit:other',
      'build',
    ]);
    expect(handle.replace).toHaveBeenCalledWith('next');
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(useRekeyStore.getState().status).toBe('success');
  });

  it('keeps the biometric account and rewrites its unchanged secret', async () => {
    const handle = biometric('biometric-secret');
    await startRekey({
      currentPassword: 'current',
      newPassword: 'next',
      otherPasswords: [],
      biometric: handle,
    });

    expect(mocks.calls).toContain('admit:biometric-secret');
    expect(handle.replace).toHaveBeenCalledWith('biometric-secret');
  });

  it('leaves the biometric entry alone when its secret opens no kept account', async () => {
    mocks.admit.mockImplementation(async password => password !== 'stale');
    const handle = biometric('stale');
    await startRekey({
      currentPassword: 'current',
      otherPasswords: [],
      biometric: handle,
    });

    expect(handle.replace).not.toHaveBeenCalled();
    expect(useRekeyStore.getState().status).toBe('success');
  });

  it('reports an error and changes nothing when a password is rejected', async () => {
    mocks.admit.mockImplementation(async password => password !== 'bad');
    const handle = biometric('current');
    await startRekey({
      currentPassword: 'current',
      newPassword: 'next',
      otherPasswords: ['bad'],
      biometric: handle,
    });

    expect(mocks.calls).not.toContain('commit');
    expect(handle.replace).not.toHaveBeenCalled();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(useRekeyStore.getState().status).toBe('error');
  });
});
