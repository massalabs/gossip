import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());
const state = vi.hoisted(() => ({
  isInitialized: false,
  secureAccountCreationAllowed: true,
  setSecureAccountCreationAllowed: vi.fn((value: boolean) => {
    state.secureAccountCreationAllowed = value;
  }),
}));

vi.mock('../../src/stores/appStore', () => ({
  useAppStore: { getState: () => state },
}));

import {
  claimOnboardingStorageMode,
  consumeOnboardingCreationAuthority,
  createOnboardingPortableImportAuthorization,
  isOnboardingStorageCreationAuthorized,
  reconcilePortableImportAuthority,
  restoreOnboardingCreationAuthorityAfterRollback,
} from '../../src/services/portableImportAuthorization';

function persist(isInitialized: boolean, allowed: boolean): void {
  storage.set(
    'app-store',
    JSON.stringify({
      state: {
        isInitialized,
        secureAccountCreationAllowed: allowed,
      },
      version: 1,
    })
  );
}

describe('onboarding portable import authorization', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    storage.clear();
    persist(false, true);
    state.isInitialized = false;
    state.secureAccountCreationAllowed = true;
    vi.clearAllMocks();
  });

  it('removes source-specific recovery traces after any generation commits', async () => {
    storage.set('gossip:portable-import-authority-consumed-v1', 'consumed');
    storage.set('gossip:onboarding-creation-committed-v1', '{"owner":"old"}');
    storage.set('gossip:onboarding-storage-mode-v1', '{"mode":"import"}');
    storage.set(
      'gossip:portable-import-private-migration-epoch-v1',
      '0123456789abcdef0123456789abcdef'
    );

    await reconcilePortableImportAuthority('committed', 'locked');

    expect(state.setSecureAccountCreationAllowed).toHaveBeenCalledWith(false);
    expect(
      [...storage.keys()].filter(key =>
        /portable-import|onboarding-(?:creation|storage-mode)/u.test(key)
      )
    ).toEqual([]);
  });

  it('reads current durable authority instead of a stale tab cache', async () => {
    const authorization = createOnboardingPortableImportAuthorization();
    await authorization.claim();
    expect(authorization.isAuthorized()).toBe(true);
    persist(true, true);
    expect(authorization.isAuthorized()).toBe(false);
    persist(false, false);
    expect(authorization.isAuthorized()).toBe(false);
    await authorization.release();
  });

  it('durably revokes replacement authority before physical installation', async () => {
    const authorization = createOnboardingPortableImportAuthorization();
    await authorization.claim();
    authorization.prepareCommit();
    expect(state.setSecureAccountCreationAllowed).toHaveBeenCalledWith(false);
    expect(
      JSON.parse(storage.get('app-store')!).state.secureAccountCreationAllowed
    ).toBe(false);
    expect(authorization.isAuthorized()).toBe(false);
    // A stale tab can rewrite the old Zustand blob, but cannot elevate the
    // dedicated monotonic consumption record.
    persist(false, true);
    expect(authorization.isAuthorized()).toBe(false);
    await authorization.release();
  });

  it('serializes create and import mode claims across contexts', async () => {
    const creation = await claimOnboardingStorageMode('create');
    let importAcquired = false;
    const importing = claimOnboardingStorageMode('import').then(lease => {
      importAcquired = true;
      return lease;
    });
    await Promise.resolve();
    expect(importAcquired).toBe(false);
    await creation.release();
    const importLease = await importing;
    expect(importAcquired).toBe(true);
    await importLease.release();
  });

  it('keeps completed creation authority revoked after stale store writes', async () => {
    const creation = await claimOnboardingStorageMode('create');
    const owner = consumeOnboardingCreationAuthority(creation);
    await creation.release();
    state.secureAccountCreationAllowed = false;
    persist(false, true);
    restoreOnboardingCreationAuthorityAfterRollback(owner);
    expect(state.secureAccountCreationAllowed).toBe(false);
    expect(isOnboardingStorageCreationAuthorized()).toBe(false);
  });

  it('cannot consume creation authority without an owned create mode', () => {
    expect(() => consumeOnboardingCreationAuthority()).toThrow(
      'not currently authorized'
    );
  });

  it('cannot prepare a commit without current durable authority', () => {
    persist(false, false);
    expect(() =>
      createOnboardingPortableImportAuthorization().prepareCommit()
    ).toThrow('not currently authorized');
  });
});
