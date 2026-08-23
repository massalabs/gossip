import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECURE_STORAGE_IDB_NAME } from '@massalabs/gossip-sdk/db/secure-storage-namespaces';
import secureStorageWasmUrlRaw from '@massalabs/gossip-sdk/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';

const secureStorageWasmUrl = new URL(
  secureStorageWasmUrlRaw,
  window.location.href
).href;
const harnessUrl = new URL(
  '../support/freshAccountRelaunchHarness.tsx',
  import.meta.url
).href;

type HarnessModule = typeof import('../support/freshAccountRelaunchHarness');

async function deleteSecureStorage(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SECURE_STORAGE_IDB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('secure-storage IndexedDB deletion was blocked'));
  });
}

async function withFreshPage<T>(
  run: (harness: HarnessModule) => Promise<T>
): Promise<T> {
  const frame = document.createElement('iframe');
  frame.srcdoc = `<script type="module">
    window.__vitest_browser_runner__ = parent.__vitest_browser_runner__;
    window.__vitest_mocker__ = parent.__vitest_mocker__;
    import(${JSON.stringify(harnessUrl)})
      .then(module => { window.freshAccountHarness = module; })
      .catch(error => {
        window.freshAccountHarnessError = String(error?.stack ?? error);
      });
  </script>`;
  document.body.append(frame);
  try {
    await vi.waitFor(() => {
      const context = frame.contentWindow as Window & {
        freshAccountHarness?: HarnessModule;
        freshAccountHarnessError?: string;
      };
      if (context.freshAccountHarnessError) {
        throw new Error(context.freshAccountHarnessError);
      }
      expect(context.freshAccountHarness).toBeTruthy();
    }, 30_000);
    return await run(
      (
        frame.contentWindow as Window & {
          freshAccountHarness: HarnessModule;
        }
      ).freshAccountHarness
    );
  } finally {
    frame.remove();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

describe('secure account reload with fresh application modules', () => {
  beforeEach(async () => {
    localStorage.clear();
    await deleteSecureStorage();
  }, 60_000);

  afterEach(async () => {
    await deleteSecureStorage();
    localStorage.clear();
  }, 60_000);

  it('routes a rolled-back install to onboarding and consumes its grant', async () => {
    const domain = 'fresh-page-rollback-integration';
    const passwords: [string, string] = [
      'fresh-alice-password',
      'fresh-decoy-password',
    ];
    const prepared = await withFreshPage(harness =>
      harness.prepareRolledBackAccounts({
        domain,
        secureStorageWasmUrl,
        passwords,
      })
    );
    expect(prepared.rollbackComplete).toBe(true);
    expect(prepared.passwordsRejected).toBe(true);

    const relaunched = await withFreshPage(harness =>
      harness.runFreshAccountRelaunchScenario({
        domain,
        secureStorageWasmUrl,
        persistedAppStore: prepared.persistedAppStore,
        rejectedPasswords: passwords,
        replacementPassword: 'fresh-replacement-password',
      })
    );
    expect(relaunched).toEqual({
      routedToOnboarding: true,
      grantRehydrated: true,
      rejectedPasswordsStayedRejected: true,
      replacementUsername: 'replacement',
      replacementReopened: true,
      stableUserId: true,
    });
  }, 180_000);
});
