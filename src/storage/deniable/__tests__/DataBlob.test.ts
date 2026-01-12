/**
 * Tests for DataBlob
 */

import { describe, it, expect } from 'vitest';
import {
  createDataBlock,
  generatePadding,
  assembleDataBlob,
  parseDataBlob,
  appendBlock,
} from '../core/DataBlob';

describe('DataBlob', () => {
  describe('createDataBlock', () => {
    it('should create an encrypted block', async () => {
      const data = new TextEncoder().encode('Hello, World!');
      const block = await createDataBlock(data, 'test-password');

      expect(block.size).toBeGreaterThan(20); // header + nonce + ciphertext
      expect(block.nonce.length).toBe(16);
      expect(block.ciphertext.length).toBeGreaterThan(0);
    });

    it('should create different blocks for different data', async () => {
      const data1 = new TextEncoder().encode('data1');
      const data2 = new TextEncoder().encode('data2');

      const block1 = await createDataBlock(data1, 'password');
      const block2 = await createDataBlock(data2, 'password');

      expect(block1.ciphertext).not.toEqual(block2.ciphertext);
    });

    it('should use fresh nonces', async () => {
      const data = new TextEncoder().encode('same data');
      const block1 = await createDataBlock(data, 'password');
      const block2 = await createDataBlock(data, 'password');

      // Even with same data and password, nonces should differ
      expect(block1.nonce).not.toEqual(block2.nonce);
    });
  });

  describe('generatePadding', () => {
    it('should generate padding of exact size', () => {
      const size = 1024;
      const padding = generatePadding(size);

      expect(padding.length).toBe(size);
    });

    it('should generate random padding', () => {
      const padding1 = generatePadding(1024);
      const padding2 = generatePadding(1024);

      // Should be different
      let differences = 0;
      for (let i = 0; i < padding1.length; i++) {
        if (padding1[i] !== padding2[i]) differences++;
      }

      expect(differences).toBeGreaterThan(500); // Most bytes should differ
    });

    it('should handle large padding sizes', () => {
      const size = 10 * 1024 * 1024; // 10 MB
      const padding = generatePadding(size);

      expect(padding.length).toBe(size);
    });
  });

  describe('assembleDataBlob', () => {
    it('should assemble blob from single block', async () => {
      const data = new TextEncoder().encode('test data');
      const block = await createDataBlock(data, 'password');

      const blob = assembleDataBlob([block]);

      expect(blob.length).toBeGreaterThan(block.size); // padding + block
    });

    it('should assemble blob from multiple blocks', async () => {
      const block1 = await createDataBlock(new TextEncoder().encode('data1'), 'pass1');
      const block2 = await createDataBlock(new TextEncoder().encode('data2'), 'pass2');

      const blob = assembleDataBlob([block1, block2]);

      // Should contain both blocks plus padding
      expect(blob.length).toBeGreaterThan(block1.size + block2.size);
    });

    it('should handle empty blocks array', () => {
      const blob = assembleDataBlob([]);

      // Should return padding only
      expect(blob.length).toBeGreaterThan(0);
    });

    it('should create blobs with variety in sizes', async () => {
      const block = await createDataBlock(new TextEncoder().encode('test'), 'pass');

      const blob1 = assembleDataBlob([block]);
      const blob2 = assembleDataBlob([block]);

      // Blobs should differ in size due to random padding
      expect(blob1.length).not.toBe(blob2.length);
    });
  });

  describe('parseDataBlob and round-trip', () => {
    it('should round-trip encrypt and decrypt', async () => {
      const originalData = new TextEncoder().encode('Secret Message!');
      const password = 'my-password';

      // Create block
      const block = await createDataBlock(originalData, password);

      // Assemble blob
      const blob = assembleDataBlob([block]);

      // Find block offset (skip padding at start)
      // For this test, we know padding comes first, so scan for block
      let blockOffset = -1;
      for (let i = 0; i < blob.length - 4; i++) {
        const view = new DataView(blob.buffer, i, 4);
        const size = view.getUint32(0, false);

        // Block size should be reasonable
        if (size === block.size && size > 20 && size < 1000000) {
          blockOffset = i;
          break;
        }
      }

      expect(blockOffset).toBeGreaterThanOrEqual(0);

      // Parse block
      const decryptedData = await parseDataBlob(blob, blockOffset, password);

      expect(decryptedData).not.toBeNull();
      expect(new TextDecoder().decode(decryptedData!)).toBe('Secret Message!');
    });

    it('should return null for wrong password', async () => {
      const data = new TextEncoder().encode('secret');
      const block = await createDataBlock(data, 'correct-password');
      const blob = assembleDataBlob([block]);

      // Find block offset
      let blockOffset = 0;
      for (let i = 0; i < blob.length - 4; i++) {
        const view = new DataView(blob.buffer, i, 4);
        const size = view.getUint32(0, false);
        if (size === block.size && size > 20 && size < 1000000) {
          blockOffset = i;
          break;
        }
      }

      const result = await parseDataBlob(blob, blockOffset, 'wrong-password');
      expect(result).toBeNull();
    });

    it('should return null for invalid offset', async () => {
      const data = new TextEncoder().encode('test');
      const block = await createDataBlock(data, 'password');
      const blob = assembleDataBlob([block]);

      const result = await parseDataBlob(blob, 999999, 'password');
      expect(result).toBeNull();
    });

    it('should handle multiple blocks with different passwords', async () => {
      const data1 = new TextEncoder().encode('session1');
      const data2 = new TextEncoder().encode('session2');

      const block1 = await createDataBlock(data1, 'password1');
      const block2 = await createDataBlock(data2, 'password2');

      const blob = assembleDataBlob([block1, block2]);

      // Find both blocks
      const blockOffsets: number[] = [];
      for (let i = 0; i < blob.length - 4; i++) {
        const view = new DataView(blob.buffer, i, 4);
        const size = view.getUint32(0, false);

        if ((size === block1.size || size === block2.size) && size > 20 && size < 1000000) {
          blockOffsets.push(i);
        }
      }

      expect(blockOffsets.length).toBeGreaterThanOrEqual(2);

      // Decrypt first block with password1
      const decrypted1 = await parseDataBlob(blob, blockOffsets[0], 'password1');
      // Decrypt second block with password2
      const decrypted2 = await parseDataBlob(blob, blockOffsets[1], 'password2');

      expect(decrypted1).not.toBeNull();
      expect(decrypted2).not.toBeNull();
    });
  });

  describe('appendBlock', () => {
    it('should append block to existing blob', async () => {
      const block1 = await createDataBlock(new TextEncoder().encode('first'), 'pass1');
      const blob1 = assembleDataBlob([block1]);

      const block2 = await createDataBlock(new TextEncoder().encode('second'), 'pass2');
      const blob2 = appendBlock(blob1, block2);

      expect(blob2.length).toBeGreaterThan(blob1.length);
      expect(blob2.length).toBeGreaterThan(blob1.length + block2.size);
    });

    it('should preserve existing data', async () => {
      const block1 = await createDataBlock(new TextEncoder().encode('preserved'), 'pass');
      const blob1 = assembleDataBlob([block1]);

      const block2 = await createDataBlock(new TextEncoder().encode('new'), 'pass');
      const blob2 = appendBlock(blob1, block2);

      // Original blob should be at start of new blob
      const preserved = blob2.slice(0, blob1.length);
      expect(preserved).toEqual(blob1);
    });
  });

  describe('statistical properties', () => {
    it('should have padding sizes following Pareto-like distribution', async () => {
      const block = await createDataBlock(new TextEncoder().encode('test'), 'pass');

      const blobSizes: number[] = [];
      for (let i = 0; i < 50; i++) {
        const blob = assembleDataBlob([block]);
        blobSizes.push(blob.length - block.size); // padding size
      }

      // Check for variety (not all same size)
      const uniqueSizes = new Set(blobSizes).size;
      expect(uniqueSizes).toBeGreaterThan(30);

      // Most should be relatively small, some large (Pareto)
      blobSizes.sort((a, b) => a - b);
      const median = blobSizes[Math.floor(blobSizes.length / 2)];
      const p90 = blobSizes[Math.floor(blobSizes.length * 0.9)];

      expect(p90).toBeGreaterThan(median * 1.5); // Heavy tail
    });
  });
});
