/**
 * Statistical distributions for block and padding sizes
 *
 * This module implements the statistical distributions used to generate
 * realistic-looking block and padding sizes that provide plausible deniability.
 *
 * - Log-Normal distribution for block sizes (2-256 MB, mean 35 MB)
 * - Pareto distribution for padding sizes (5-600 MB, mean 17.5 MB, α=1.25)
 *
 * @module core/distributions
 */

/**
 * Constants for block size distribution (Log-Normal)
 */
export const BLOCK_SIZE_MIN = 2 * 1024 * 1024; // 2 MB
export const BLOCK_SIZE_MAX = 256 * 1024 * 1024; // 256 MB
export const BLOCK_SIZE_MEAN = 35 * 1024 * 1024; // 35 MB

/**
 * Constants for padding size distribution (Pareto)
 */
export const PADDING_SIZE_MIN = 5 * 1024 * 1024; // 5 MB (x_min)
export const PADDING_SIZE_MAX = 600 * 1024 * 1024; // 600 MB
export const PADDING_SIZE_MEAN = 17.5 * 1024 * 1024; // 17.5 MB
export const PADDING_ALPHA = 1.25; // Pareto shape parameter

/**
 * Generates a random value from a Log-Normal distribution
 *
 * Log-Normal distribution is used for block sizes to create realistic
 * data size patterns. Most blocks will be around 35MB, with a long tail
 * allowing for larger blocks up to 256MB.
 *
 * The Log-Normal distribution is characterized by:
 * - μ (mu): mean of the underlying normal distribution
 * - σ (sigma): standard deviation of the underlying normal distribution
 *
 * If Y ~ LogNormal(μ, σ), then ln(Y) ~ Normal(μ, σ)
 *
 * @returns Block size in bytes [2MB..256MB]
 *
 * @example
 * ```typescript
 * const size = generateBlockSize();
 * console.log(`Block size: ${(size / 1024 / 1024).toFixed(2)} MB`);
 * ```
 */
export function generateBlockSize(): number {
  // Target: mean = 35 MB, range = [2MB, 256MB]

  // For Log-Normal distribution:
  // E[X] = exp(μ + σ²/2)
  // We want E[X] = 35MB

  // Using μ = ln(35MB) and σ calibrated to fit the range
  const targetMean = BLOCK_SIZE_MEAN;
  const minSize = BLOCK_SIZE_MIN;
  const maxSize = BLOCK_SIZE_MAX;

  // Calculate μ and σ to achieve target mean and spread
  // μ = ln(mean) - σ²/2
  // σ chosen to give good spread in [2MB, 256MB]
  const sigma = 0.9; // Calibrated for desired spread
  const mu = Math.log(targetMean) - (sigma * sigma) / 2;

  // Generate value from Log-Normal distribution
  let size: number;
  let attempts = 0;
  const maxAttempts = 100;

  do {
    // Box-Muller transform to generate normal random variable
    const u1 = crypto.getRandomValues(new Uint32Array(1))[0] / 0xffffffff;
    const u2 = crypto.getRandomValues(new Uint32Array(1))[0] / 0xffffffff;

    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    // Transform to log-normal
    size = Math.exp(mu + sigma * z);

    attempts++;
  } while ((size < minSize || size > maxSize) && attempts < maxAttempts);

  // Clamp to valid range
  return Math.floor(Math.max(minSize, Math.min(maxSize, size)));
}

/**
 * Generates a random value from a Pareto distribution
 *
 * Pareto distribution is used for padding sizes to create a heavy-tailed
 * distribution. This means most padding will be small (around 5-20MB),
 * but there's a significant probability of much larger padding (up to 600MB).
 *
 * The heavy tail is crucial for plausible deniability: it allows hiding
 * large data blocks within what appears to be random padding.
 *
 * The Pareto distribution is characterized by:
 * - x_min: minimum value (5 MB)
 * - α (alpha): shape parameter (1.25) - controls tail heaviness
 *
 * PDF: f(x) = α·x_min^α / x^(α+1) for x ≥ x_min
 * CDF: F(x) = 1 - (x_min/x)^α
 *
 * @returns Padding size in bytes [5MB..600MB]
 *
 * @example
 * ```typescript
 * const size = generatePaddingSize();
 * console.log(`Padding size: ${(size / 1024 / 1024).toFixed(2)} MB`);
 * ```
 */
export function generatePaddingSize(): number {
  const xMin = PADDING_SIZE_MIN; // 5 MB
  const alpha = PADDING_ALPHA; // 1.25
  const maxSize = PADDING_SIZE_MAX; // 600 MB

  // Inverse transform sampling for Pareto distribution
  // If U ~ Uniform(0,1), then X = x_min / U^(1/α) ~ Pareto(x_min, α)

  let size: number;
  let attempts = 0;
  const maxAttempts = 100;

  do {
    // Generate uniform random value in (0, 1]
    // Avoid exactly 0 to prevent division by zero
    const u = crypto.getRandomValues(new Uint32Array(1))[0] / 0xffffffff;
    const uniformValue = Math.max(u, 1e-10);

    // Inverse CDF: X = x_min / U^(1/α)
    size = xMin / Math.pow(uniformValue, 1 / alpha);

    attempts++;
  } while (size > maxSize && attempts < maxAttempts);

  // Clamp to valid range
  return Math.floor(Math.max(xMin, Math.min(maxSize, size)));
}
