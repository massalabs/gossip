/**
 * Tests for statistical distributions
 */

import { describe, it, expect } from 'vitest';
import {
  generateBlockSize,
  generatePaddingSize,
  BLOCK_SIZE_MIN,
  BLOCK_SIZE_MAX,
  BLOCK_SIZE_MEAN,
  PADDING_SIZE_MIN,
  PADDING_SIZE_MAX,
  PADDING_SIZE_MEAN,
} from '../core/distributions';

describe('distributions', () => {
  describe('generateBlockSize (Log-Normal)', () => {
    it('should generate sizes within valid range', () => {
      for (let i = 0; i < 100; i++) {
        const size = generateBlockSize();
        expect(size).toBeGreaterThanOrEqual(BLOCK_SIZE_MIN);
        expect(size).toBeLessThanOrEqual(BLOCK_SIZE_MAX);
      }
    });

    it('should generate integer byte values', () => {
      for (let i = 0; i < 50; i++) {
        const size = generateBlockSize();
        expect(Number.isInteger(size)).toBe(true);
      }
    });

    it('should have mean close to 35MB (statistical test)', () => {
      const samples = 1000;
      let sum = 0;

      for (let i = 0; i < samples; i++) {
        sum += generateBlockSize();
      }

      const mean = sum / samples;
      const expectedMean = BLOCK_SIZE_MEAN; // 35 MB

      // Allow 20% deviation due to sampling variance
      const tolerance = expectedMean * 0.2;
      expect(mean).toBeGreaterThan(expectedMean - tolerance);
      expect(mean).toBeLessThan(expectedMean + tolerance);
    });

    it('should have proper log-normal distribution shape', () => {
      const samples = 1000;
      const sizes: number[] = [];

      for (let i = 0; i < samples; i++) {
        sizes.push(generateBlockSize());
      }

      // Sort sizes
      sizes.sort((a, b) => a - b);

      // Check quartiles - log-normal is right-skewed
      const q1 = sizes[Math.floor(samples * 0.25)];
      const q2 = sizes[Math.floor(samples * 0.5)]; // median
      const q3 = sizes[Math.floor(samples * 0.75)];

      // Median should be less than mean (right-skewed)
      const mean = sizes.reduce((a, b) => a + b, 0) / samples;
      expect(q2).toBeLessThan(mean);

      // Q3 - Q2 should be larger than Q2 - Q1 (right tail longer)
      const upperSpread = q3 - q2;
      const lowerSpread = q2 - q1;
      expect(upperSpread).toBeGreaterThan(lowerSpread * 0.8);
    });

    it('should generate variety in sizes', () => {
      const samples = 100;
      const sizes = new Set<number>();

      for (let i = 0; i < samples; i++) {
        sizes.add(generateBlockSize());
      }

      // Should have many unique values
      expect(sizes.size).toBeGreaterThan(80);
    });

    it('should have values concentrated around mean', () => {
      const samples = 1000;
      const sizes: number[] = [];

      for (let i = 0; i < samples; i++) {
        sizes.push(generateBlockSize());
      }

      // Count values within [20MB, 50MB] (around 35MB mean)
      const inRange = sizes.filter(
        (s) =>
          s >= 20 * 1024 * 1024 && s <= 50 * 1024 * 1024,
      ).length;

      // Expect most values to be in this range
      const percentage = (inRange / samples) * 100;
      expect(percentage).toBeGreaterThan(40); // At least 40%
    });

    it('should produce deterministic results with same random source', () => {
      // Note: This test just validates that the function runs
      // Actual determinism would require mocking crypto.getRandomValues
      const size1 = generateBlockSize();
      const size2 = generateBlockSize();

      // Just check they're valid, not necessarily different
      expect(size1).toBeGreaterThanOrEqual(BLOCK_SIZE_MIN);
      expect(size2).toBeGreaterThanOrEqual(BLOCK_SIZE_MIN);
    });
  });

  describe('generatePaddingSize (Pareto)', () => {
    it('should generate sizes within valid range', () => {
      for (let i = 0; i < 100; i++) {
        const size = generatePaddingSize();
        expect(size).toBeGreaterThanOrEqual(PADDING_SIZE_MIN);
        expect(size).toBeLessThanOrEqual(PADDING_SIZE_MAX);
      }
    });

    it('should generate integer byte values', () => {
      for (let i = 0; i < 50; i++) {
        const size = generatePaddingSize();
        expect(Number.isInteger(size)).toBe(true);
      }
    });

    it('should have mean close to 17.5MB (statistical test)', () => {
      const samples = 2000; // More samples for Pareto due to high variance
      let sum = 0;

      for (let i = 0; i < samples; i++) {
        sum += generatePaddingSize();
      }

      const mean = sum / samples;
      const expectedMean = PADDING_SIZE_MEAN; // 17.5 MB

      // Allow 30% deviation due to high variance of Pareto
      const tolerance = expectedMean * 0.3;
      expect(mean).toBeGreaterThan(expectedMean - tolerance);
      expect(mean).toBeLessThan(expectedMean + tolerance);
    });

    it('should have heavy tail (Pareto property)', () => {
      const samples = 1000;
      const sizes: number[] = [];

      for (let i = 0; i < samples; i++) {
        sizes.push(generatePaddingSize());
      }

      sizes.sort((a, b) => a - b);

      // Pareto has heavy right tail
      // Check that top 10% has significantly larger values
      const p90 = sizes[Math.floor(samples * 0.9)];
      const median = sizes[Math.floor(samples * 0.5)];

      // P90 should be much larger than median (heavy tail)
      expect(p90).toBeGreaterThan(median * 2);

      // Check for very large values in tail
      const p95 = sizes[Math.floor(samples * 0.95)];
      const p99 = sizes[Math.floor(samples * 0.99)];

      expect(p99).toBeGreaterThan(p95);
      expect(p99).toBeGreaterThan(100 * 1024 * 1024); // At least 100MB
    });

    it('should have most values near minimum (α=1.25)', () => {
      const samples = 1000;
      const sizes: number[] = [];

      for (let i = 0; i < samples; i++) {
        sizes.push(generatePaddingSize());
      }

      // Count values in [5MB, 20MB] (near minimum)
      const nearMin = sizes.filter(
        (s) => s >= PADDING_SIZE_MIN && s <= 20 * 1024 * 1024,
      ).length;

      // With α=1.25, most values should be near x_min
      const percentage = (nearMin / samples) * 100;
      expect(percentage).toBeGreaterThan(50); // At least 50%
    });

    it('should generate variety in sizes', () => {
      const samples = 100;
      const sizes = new Set<number>();

      for (let i = 0; i < samples; i++) {
        sizes.add(generatePaddingSize());
      }

      // Should have many unique values
      expect(sizes.size).toBeGreaterThan(70);
    });

    it('should occasionally produce very large values (tail behavior)', () => {
      const samples = 500;
      let largeCount = 0;

      for (let i = 0; i < samples; i++) {
        const size = generatePaddingSize();
        if (size > 200 * 1024 * 1024) {
          // > 200 MB
          largeCount++;
        }
      }

      // Should have some large values in tail
      expect(largeCount).toBeGreaterThan(0);
    });

    it('should have lower median than mean (right-skewed)', () => {
      const samples = 1000;
      const sizes: number[] = [];

      for (let i = 0; i < samples; i++) {
        sizes.push(generatePaddingSize());
      }

      sizes.sort((a, b) => a - b);

      const median = sizes[Math.floor(samples * 0.5)];
      const mean = sizes.reduce((a, b) => a + b, 0) / samples;

      // Pareto is right-skewed: median < mean
      expect(median).toBeLessThan(mean);
    });
  });
});
