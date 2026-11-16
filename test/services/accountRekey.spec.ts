import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  admit: vi.fn<(password: string, next?: string) => Promise<boolean>>(),
  unlock: vi.fn<(password: string) => Promise<boolean>>(),
  commit: vi.fn<() => Promise<void>>(),
  refresh: vi.fn<() => Promise<void>>(),
  epoch: 'epoch-1',
  epochAfterCommit: 'epoch-2',
  padding: { admit: 0, unlock: 0 },
  storageState: 'locked',
  profile: null as Record<string, unknown> | null,
  saved: [] as Array<Record<string, unknown>>,
  auth: vi.fn(),
  createPasswordSecurity: vi.fn(),
  logout: vi.fn(async () => {}),
  windows: [] as string[],
  otherWindowsLetGo: true,
  userProfile: null as Record<string, unknown> | null,
}));

// Padding rounds use random 64-hex passwords that open nothing. They are
// kept out of `calls` and counted separately.
const isPadding = (password: string) => /^[0-9a-f]{64}$/u.test(password);

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
      if (isPadding(password)) {
        mocks.padding.admit += 1;
        return false;
      }
      note(`admit:${password}${next ? `->${next}` : ''}`);
      return mocks.admit(password, next);
    },
    secureStorageBuildRekeyCandidate: async () => note('build'),
    secureStorageUnlock: async (password: string) => {
      if (isPadding(password)) {
        mocks.padding.unlock += 1;
        return false;
      }
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
      mocks.epoch = mocks.epochAfterCommit;
    },
    secureStorageAbortRekey: async () => note('abort'),
    refreshAccountGenerationState: async () => {
      await mocks.refresh();
    },
    readSessionBlob: async () => null,
    reencryptSelfMessages: async (userId: string) => {
      note(`notes:${userId}`);
      return { rewritten: 0, unreadable: 0 };
    },
    persistSessionBlob: async () => note('persistSession'),
    queries: {
      privateMigration: {
        carryOver: async (from: string, to: string) => {
          note(`journal:${from}->${to}`);
          return true;
        },
      },
    },
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
vi.mock('../../src/services/rekeyTabs', () => ({
  claimRekey: async () => {
    mocks.windows.push('claim');
    return () => mocks.windows.push('release-claim');
  },
  waitForOtherWindows: async () => {
    if (!mocks.otherWindowsLetGo) throw new Error('timed out');
    mocks.windows.push('others-out');
    return () => mocks.windows.push('release-others');
  },
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
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.saved.length = 0;
  mocks.epoch = 'epoch-1';
  mocks.epochAfterCommit = 'epoch-2';
  mocks.padding = { admit: 0, unlock: 0 };
  mocks.windows.length = 0;
  mocks.otherWindowsLetGo = true;
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
      'notes:gossip1test',
      'lock',
      'unlock:bob',
      'notes:gossip1test',
      'lock',
      'commit',
      // Each kept account is told its login journal is still complete.
      'unlock:alice-new',
      'journal:epoch-1->epoch-2',
      'lock',
      'unlock:bob',
      'journal:epoch-1->epoch-2',
      'lock',
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

  it('does the key work of three accounts however many are entered', async () => {
    const counts = async (passwords: string[]) => {
      mocks.padding = { admit: 0, unlock: 0 };
      mocks.calls.length = 0;
      mocks.createPasswordSecurity.mockClear();
      mocks.auth.mockClear();
      mocks.epoch = 'epoch-1';
      await rekeyLockedStore(
        sdk as never,
        passwords.map(password => account(password))
      );
      const real = (prefix: string) =>
        mocks.calls.filter(call => call.startsWith(prefix)).length;
      return {
        admissions: real('admit:') + mocks.padding.admit,
        unlocks: real('unlock:') + mocks.padding.unlock,
        freshKeys: mocks.createPasswordSecurity.mock.calls.length,
        authentications: mocks.auth.mock.calls.length,
      };
    };

    const one = await counts(['alice']);
    expect(one).toEqual({
      admissions: 3,
      unlocks: 6,
      freshKeys: 3,
      authentications: 6,
    });
    expect(await counts(['alice', 'bob'])).toEqual(one);
    expect(await counts(['alice', 'bob', 'carol'])).toEqual(one);
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

    const result = await rekeyLockedStore(sdk as never, [
      account('alice'),
      { ...account('stale'), bestEffort: true },
    ]);

    expect(result.kept.map(kept => kept.oldPassword)).toEqual(['alice']);
    expect(mocks.calls).toContain('commit');
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
    await rekeyLockedStore(sdk as never, [account('secret', 'typed')]);
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

  it('refuses to start when the open account is not among the entries', async () => {
    mocks.auth.mockRejectedValue(new Error('Authentication failed'));
    await expect(
      startRekey({
        accounts: [{ credential: 'nope', newPassword: 'next' }],
        biometric: null,
      })
    ).rejects.toThrow('The open account was not entered');
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(useRekeyStore.getState().status).toBe('idle');
  });

  it('logs out, rekeys, and stores the new password behind biometrics', async () => {
    const handle = biometric('current');
    await startRekey({
      accounts: [
        { credential: 'current', newPassword: 'next' },
        { credential: 'other' },
        { credential: '' },
      ],
      biometric: handle,
    });

    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.windows).toEqual([
      'claim',
      'others-out',
      'release-others',
      'release-claim',
    ]);
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

  it('changes several passwords in one operation, the open account kept', async () => {
    // Only 'current' opens the profile of the account that is logged in.
    mocks.auth.mockImplementation(async (candidate, password) => {
      if (candidate === mocks.userProfile && password !== 'current') {
        throw new Error('Authentication failed');
      }
      return { mnemonic: 'the mnemonic', encryptionKey: key() };
    });
    await startRekey({
      accounts: [
        { credential: 'hidden', newPassword: 'next-hidden' },
        { credential: 'current' },
      ],
      biometric: null,
    });

    expect(mocks.calls.slice(0, 4)).toEqual([
      'begin',
      'admit:hidden->next-hidden',
      'admit:current',
      'build',
    ]);
    expect(mocks.calls).toContain('commit');
  });

  it('touches nothing when another window does not log out', async () => {
    mocks.otherWindowsLetGo = false;
    const handle = biometric('current');
    await startRekey({
      accounts: [{ credential: 'current', newPassword: 'next' }],
      biometric: handle,
    });

    expect(mocks.calls).toEqual([]);
    expect(mocks.windows).toEqual(['claim', 'release-claim']);
    expect(handle.replace).not.toHaveBeenCalled();
    expect(useRekeyStore.getState().status).toBe('error');
  });

  it('keeps the biometric account and rewrites its unchanged secret', async () => {
    const handle = biometric('biometric-secret');
    await startRekey({
      accounts: [{ credential: 'current', newPassword: 'next' }],
      biometric: handle,
    });

    expect(mocks.calls).toContain('admit:biometric-secret');
    expect(handle.replace).toHaveBeenCalledWith('biometric-secret');
  });

  it('sets a password on another biometric account and stores it', async () => {
    const handle = biometric('biometric-secret');
    await startRekey({
      accounts: [
        { credential: 'current' },
        { credential: 'biometric-secret', newPassword: 'typed' },
      ],
      biometric: handle,
    });

    expect(mocks.calls).toContain('admit:biometric-secret->typed');
    expect(handle.replace).toHaveBeenCalledWith('typed');
  });

  it('leaves the biometric entry alone when its secret opens no kept account', async () => {
    mocks.admit.mockImplementation(async password => password !== 'stale');
    const handle = biometric('stale');
    await startRekey({
      accounts: [{ credential: 'current' }, { credential: 'stale' }],
      biometric: handle,
    });

    expect(handle.replace).not.toHaveBeenCalled();
    expect(useRekeyStore.getState().status).toBe('success');
  });

  it('reports an error and changes nothing when a password is rejected', async () => {
    mocks.admit.mockImplementation(async password => password !== 'bad');
    const handle = biometric('current');
    await startRekey({
      accounts: [
        { credential: 'current', newPassword: 'next' },
        { credential: 'bad' },
      ],
      biometric: handle,
    });

    expect(mocks.calls).not.toContain('commit');
    expect(handle.replace).not.toHaveBeenCalled();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(useRekeyStore.getState().status).toBe('error');
  });
});
