/**
 * E2E browser test: real GossipSdk against the live api.usegossip.com,
 * backed by the new sqlite-wasm-rs secure storage path.
 *
 * Validates that the full SDK stack (auth, profile, DB queries, persistence)
 * works through the encrypted VFS:
 *
 *   1. Create an account, open a session
 *   2. Verify the account is registered server-side (fetchPublicKeyByUserId)
 *   3. Insert + read data via Drizzle ORM through the SDK
 *   4. Close the session, reopen with the same password, verify the
 *      account state is intact
 *
 * Network: requires `https://api.usegossip.com` to be reachable.
 *
 * Default-skipped: only runs when `VITE_E2E_LIVE=1` is set (typically on
 * a staging/nightly CI lane, not on every PR run). Running against live
 * prod creates junk accounts on every invocation and is a flake source on
 * outages/rate-limits. Point to a staging server once one exists.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GossipSdk, generateMnemonic } from '@massalabs/gossip-sdk';
import { SECURE_STORAGE_IDB_NAME } from '@massalabs/gossip-sdk/db/secure-storage-namespaces';

import secureStorageWasmUrlRaw from '@massalabs/gossip-sdk/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';

const secureStorageWasmUrl = new URL(
  secureStorageWasmUrlRaw,
  window.location.href
).href;

const PASSWORD = 'e2e-test-password';
// Note: when passed via init({ protocolBaseUrl }), the URL is used as-is —
// no `/api` suffix is appended (that's only the default fallback path).
const API_URL = 'https://api.usegossip.com/api';

function storageConfig() {
  return {
    type: 'secureStorage' as const,
    domain: 'gossip-e2e',
    secureStorageWasmUrl,
  };
}

async function clearIdb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(SECURE_STORAGE_IDB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    // Don't reject on blocked — workers from a previous run may still be
    // tearing down. Wait for the actual deletion event instead.
    req.onblocked = () => undefined;
  });
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 60_000,
  intervalMs = 1_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs} ms`);
}

// Gate on VITE_E2E_LIVE so PR-lane CI doesn't hit production every run.
// Set the env var on the staging/nightly lane to actually run this suite.
const E2E_LIVE = import.meta.env.VITE_E2E_LIVE === '1';

describe.skipIf(!E2E_LIVE)(
  'secure storage E2E (live api.usegossip.com)',
  () => {
    beforeAll(async () => {
      await clearIdb();
    });

    afterAll(async () => {
      // Best-effort cleanup; lingering workers may delay the IDB delete.
      try {
        await Promise.race([
          clearIdb(),
          new Promise(r => setTimeout(r, 5_000)),
        ]);
      } catch {
        /* ignore */
      }
    });

    it('init + register + persist account against live API', async () => {
      // ── Phase 1: cold start, allocate, register account ─────────────
      const mnemonic = generateMnemonic();
      let userId: string;

      {
        const sdk = new GossipSdk();
        await sdk.init({
          protocolBaseUrl: API_URL,
          storage: storageConfig(),
        });
        expect(sdk.storageState).toBe(`empty`);

        await sdk.secureStorageCreate(0, PASSWORD);

        await sdk.openSession({ mnemonic });
        expect(sdk.userId).toBeTruthy();
        userId = sdk.userId;

        // Talk to the live API: poll until our public key shows up server-side
        // (openSession publishes it asynchronously).
        const pubKey = await pollUntil(async () => {
          try {
            return await sdk.auth.fetchPublicKeyByUserId(userId);
          } catch {
            return null;
          }
        }, 30_000);
        expect(pubKey).toBeTruthy();

        // Write a contact through the SDK to exercise the full Drizzle ORM
        // path against the new sqlite-wasm-rs encrypted VFS.
        const result = await sdk.contacts.add(userId, 'self', pubKey);
        expect(result.success).toBe(true);

        const contact = await sdk.contacts.get(userId);
        expect(contact).toBeTruthy();
        expect(contact?.name).toBe('self');

        await sdk.flush?.();
        await sdk.closeSession();
      }

      // ── Phase 2: simulate cold reopen — new SDK instance, unlock ────
      {
        const sdk = new GossipSdk();
        await sdk.init({
          protocolBaseUrl: API_URL,
          storage: storageConfig(),
        });
        expect(sdk.storageState).toBe(`locked`);

        const ok = await sdk.secureStorageUnlock(PASSWORD);
        expect(ok).toBe(true);

        await sdk.openSession({ mnemonic });
        expect(sdk.userId).toBe(userId);

        // The contact we wrote in phase 1 should still be there (loaded from
        // encrypted IDB blocks via the new sqlite-wasm-rs path).
        const contact = await sdk.contacts.get(userId);
        expect(contact).toBeTruthy();
        expect(contact?.name).toBe('self');

        await sdk.closeSession();
      }
    }, 180_000);
  }
);
