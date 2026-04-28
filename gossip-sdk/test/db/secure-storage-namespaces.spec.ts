import { describe, it, expect } from 'vitest';

import {
  SQL_NAMESPACE,
  SESSION_BLOB_NAMESPACE,
  COVER_TRAFFIC_NAMESPACES,
  SESSION_COUNT,
} from '../../src/db/secure-storage-namespaces.js';

/**
 * Pin the cover-traffic enrollment invariant: every declared namespace
 * must appear in COVER_TRAFFIC_NAMESPACES, otherwise the dummy slots
 * freeze for that namespace and the freeze itself becomes a real-vs-cover
 * distinguisher (PD regression).
 *
 * If you add a new namespace constant, this test forces you to bump
 * the expected count below, which is the explicit prompt to verify
 * the new namespace is enrolled (it is, automatically, as long as
 * the constant is added inside the `NAMESPACES` object literal in
 * `secure-storage-namespaces.ts`).
 */
describe('secure-storage namespaces', () => {
  const declared = [SQL_NAMESPACE, SESSION_BLOB_NAMESPACE];

  it('every declared namespace is enrolled in cover-traffic', () => {
    expect(COVER_TRAFFIC_NAMESPACES.length).toBe(declared.length);
    for (const ns of declared) {
      expect(COVER_TRAFFIC_NAMESPACES).toContain(ns);
    }
  });

  it('namespace IDs are unique', () => {
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('SESSION_COUNT matches the Rust core constant', () => {
    // Sentinel: tracking `SESSION_COUNT` in `wasm/secure-storage/src/
    // constants.rs`. Any change here must be mirrored on the Rust side
    // and vice versa.
    expect(SESSION_COUNT).toBe(3);
  });
});
