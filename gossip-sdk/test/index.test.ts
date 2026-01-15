/**
 * Basic SDK tests
 *
 * Verifies that the SDK module loads correctly and exports are available.
 */

import { describe, it, expect } from 'vitest';
import { SDK_VERSION } from '../src/index';

describe('Gossip SDK', () => {
  it('should export SDK_VERSION', () => {
    expect(SDK_VERSION).toBe('0.0.1');
  });

  it('should have IndexedDB available (via fake-indexeddb)', () => {
    expect(typeof indexedDB).toBe('object');
    expect(typeof IDBKeyRange).toBe('function');
  });
});
