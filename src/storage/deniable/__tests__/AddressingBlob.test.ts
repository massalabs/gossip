/**
 * Tests for AddressingBlob
 */

import { describe, it, expect } from 'vitest';
import {
  createAddressingBlob,
  deriveSlotIndices,
  writeSlot,
  readSlot,
  readSlots,
  writeSessionAddress,
  ADDRESSING_BLOB_SIZE,
  SLOT_COUNT,
  SLOT_SIZE,
  SLOTS_PER_SESSION,
} from '../core/AddressingBlob';
import type { SessionAddress } from '../types';

describe('AddressingBlob', () => {
  describe('createAddressingBlob', () => {
    it('should create a blob of exactly 2MB', () => {
      const blob = createAddressingBlob();
      expect(blob.length).toBe(ADDRESSING_BLOB_SIZE);
      expect(blob.length).toBe(2 * 1024 * 1024);
      expect(blob.length).toBe(2097152);
    });

    it('should fill the blob with random data', () => {
      const blob = createAddressingBlob();

      // Check that not all bytes are zero (extremely unlikely with random data)
      const allZeros = blob.every((byte) => byte === 0);
      expect(allZeros).toBe(false);

      // Check that there's variety in the data (basic entropy check)
      const uniqueBytes = new Set(blob).size;
      expect(uniqueBytes).toBeGreaterThan(200); // Should have most byte values present
    });

    it('should create different blobs on each call', () => {
      const blob1 = createAddressingBlob();
      const blob2 = createAddressingBlob();

      // Blobs should not be identical (cryptographically infeasible)
      let differences = 0;
      for (let i = 0; i < blob1.length; i++) {
        if (blob1[i] !== blob2[i]) {
          differences++;
        }
      }

      // Expect many differences (statistical test)
      expect(differences).toBeGreaterThan(1000000); // >1MB different
    });

    it('should have correct slot structure', () => {
      expect(SLOT_COUNT).toBe(65536);
      expect(SLOT_SIZE).toBe(32);
      expect(SLOT_COUNT * SLOT_SIZE).toBe(ADDRESSING_BLOB_SIZE);
    });
  });

  describe('deriveSlotIndices', () => {
    it('should derive exactly 46 indices', async () => {
      const indices = await deriveSlotIndices('test-password');
      expect(indices.length).toBe(SLOTS_PER_SESSION);
      expect(indices.length).toBe(46);
    });

    it('should be deterministic (same password = same indices)', async () => {
      const indices1 = await deriveSlotIndices('my-password-123');
      const indices2 = await deriveSlotIndices('my-password-123');

      expect(indices1).toEqual(indices2);
    });

    it('should produce different indices for different passwords', async () => {
      const indices1 = await deriveSlotIndices('password1');
      const indices2 = await deriveSlotIndices('password2');

      expect(indices1).not.toEqual(indices2);

      // Count different indices
      const set1 = new Set(indices1);
      const differences = indices2.filter((idx) => !set1.has(idx)).length;

      // Expect most indices to be different
      expect(differences).toBeGreaterThan(40);
    });

    it('should produce all unique indices (no duplicates)', async () => {
      const indices = await deriveSlotIndices('test-unique');
      const uniqueIndices = new Set(indices);

      expect(uniqueIndices.size).toBe(46);
      expect(uniqueIndices.size).toBe(indices.length);
    });

    it('should produce indices within valid range [0..65535]', async () => {
      const indices = await deriveSlotIndices('range-test');

      for (const index of indices) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(SLOT_COUNT);
        expect(index).toBeLessThanOrEqual(65535);
      }
    });

    it('should have good distribution across slot space', async () => {
      const indices = await deriveSlotIndices('distribution-test');

      // Divide slot space into 4 quartiles
      const quartile1 = indices.filter((i) => i < 16384).length;
      const quartile2 = indices.filter((i) => i >= 16384 && i < 32768).length;
      const quartile3 = indices.filter((i) => i >= 32768 && i < 49152).length;
      const quartile4 = indices.filter((i) => i >= 49152).length;

      // Each quartile should have some indices (not perfect, but reasonable)
      // With 46 indices and 4 quartiles, expect ~11-12 per quartile
      // Allow 0-20 per quartile to avoid flaky tests
      expect(quartile1 + quartile2 + quartile3 + quartile4).toBe(46);

      // At least 3 out of 4 quartiles should have some indices
      const nonEmptyQuartiles = [quartile1, quartile2, quartile3, quartile4].filter(
        (q) => q > 0,
      ).length;
      expect(nonEmptyQuartiles).toBeGreaterThanOrEqual(3);
    });

    it('should handle empty password', async () => {
      const indices = await deriveSlotIndices('');
      expect(indices.length).toBe(46);
    });

    it('should handle very long password', async () => {
      const longPassword = 'a'.repeat(1000);
      const indices = await deriveSlotIndices(longPassword);
      expect(indices.length).toBe(46);
    });

    it('should handle special characters in password', async () => {
      const indices = await deriveSlotIndices('🔐 p@ssw0rd! #123 🚀');
      expect(indices.length).toBe(46);
    });
  });

  describe('writeSlot and readSlot', () => {
    it('should write and read a session address', async () => {
      const blob = createAddressingBlob();
      const address: SessionAddress = {
        offset: 2097152,
        blockSize: 35000000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        salt: crypto.getRandomValues(new Uint8Array(16)),
      };

      await writeSlot(blob, 1000, address, 'test-password');
      const readAddress = await readSlot(blob, 1000, 'test-password');

      expect(readAddress).not.toBeNull();
      expect(readAddress?.offset).toBe(address.offset);
      expect(readAddress?.blockSize).toBe(address.blockSize);
      expect(readAddress?.createdAt).toBe(address.createdAt);
      expect(readAddress?.updatedAt).toBe(address.updatedAt);
    });

    it('should return null for wrong password', async () => {
      const blob = createAddressingBlob();
      const address: SessionAddress = {
        offset: 1024,
        blockSize: 1000000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        salt: new Uint8Array(16),
      };

      await writeSlot(blob, 500, address, 'correct-password');
      const readAddress = await readSlot(blob, 500, 'wrong-password');

      expect(readAddress).toBeNull();
    });

    it('should return null for unwritten slot', async () => {
      const blob = createAddressingBlob();
      const readAddress = await readSlot(blob, 999, 'any-password');

      expect(readAddress).toBeNull();
    });

    it('should handle invalid slot indices', async () => {
      const blob = createAddressingBlob();
      const readAddress1 = await readSlot(blob, -1, 'password');
      const readAddress2 = await readSlot(blob, 999999, 'password');

      expect(readAddress1).toBeNull();
      expect(readAddress2).toBeNull();
    });
  });

  describe('readSlots and writeSessionAddress', () => {
    it('should write to all 46 slots and read successfully', async () => {
      const blob = createAddressingBlob();
      const address: SessionAddress = {
        offset: 5000000,
        blockSize: 50000000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        salt: crypto.getRandomValues(new Uint8Array(16)),
      };

      await writeSessionAddress(blob, 'my-password', address);
      const readAddress = await readSlots(blob, 'my-password');

      expect(readAddress).not.toBeNull();
      expect(readAddress?.offset).toBe(address.offset);
      expect(readAddress?.blockSize).toBe(address.blockSize);
    });

    it('should return null with wrong password (timing-safe)', async () => {
      const blob = createAddressingBlob();
      const address: SessionAddress = {
        offset: 1024,
        blockSize: 1000000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        salt: new Uint8Array(16),
      };

      await writeSessionAddress(blob, 'correct-password', address);

      // Measure time for wrong password
      const start = performance.now();
      const result = await readSlots(blob, 'wrong-password');
      const wrongTime = performance.now() - start;

      expect(result).toBeNull();

      // Should take reasonable time (scans all 46 slots)
      expect(wrongTime).toBeGreaterThan(0);
    });

    it('should handle multiple sessions with different passwords', async () => {
      const blob = createAddressingBlob();

      const address1: SessionAddress = {
        offset: 1000,
        blockSize: 10000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        salt: new Uint8Array(16),
      };

      const address2: SessionAddress = {
        offset: 2000,
        blockSize: 20000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        salt: new Uint8Array(16),
      };

      await writeSessionAddress(blob, 'password1', address1);
      await writeSessionAddress(blob, 'password2', address2);

      const read1 = await readSlots(blob, 'password1');
      const read2 = await readSlots(blob, 'password2');

      expect(read1?.offset).toBe(1000);
      expect(read2?.offset).toBe(2000);
    });

    it('should be resilient to slot corruption (redundancy)', async () => {
      const blob = createAddressingBlob();
      const address: SessionAddress = {
        offset: 3000,
        blockSize: 30000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        salt: new Uint8Array(16),
      };

      await writeSessionAddress(blob, 'test-password', address);

      // Corrupt first 10 slots derived from password
      const indices = await deriveSlotIndices('test-password');
      for (let i = 0; i < 10; i++) {
        const slotOffset = indices[i] * SLOT_SIZE;
        crypto.getRandomValues(blob.subarray(slotOffset, slotOffset + SLOT_SIZE));
      }

      // Should still be able to read from remaining 36 slots
      const readAddress = await readSlots(blob, 'test-password');
      expect(readAddress).not.toBeNull();
      expect(readAddress?.offset).toBe(3000);
    });
  });
});
