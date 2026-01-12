/**
 * Tests for AddressingBlob
 */

import { describe, it, expect } from 'vitest';
import {
  createAddressingBlob,
  ADDRESSING_BLOB_SIZE,
  SLOT_COUNT,
  SLOT_SIZE,
} from '../core/AddressingBlob';

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
});
