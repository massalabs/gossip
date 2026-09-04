import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ZXING_WASM_VERSION } from 'barcode-detector';

/**
 * WebQRScanner serves the ZXing wasm from our own bundle instead of the
 * jsDelivr CDN, so the binary we ship must be the one barcode-detector's JS
 * glue expects. barcode-detector pins zxing-wasm exactly; a bump of
 * @yudiel/react-qr-scanner can move that pin, and a mismatched binary only
 * fails at scan time. Keep the two versions locked together here.
 */
describe('zxing-wasm pin', () => {
  it('matches the version barcode-detector was built against', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf8')
    ) as { dependencies: Record<string, string> };

    expect(pkg.dependencies['zxing-wasm']).toBe(ZXING_WASM_VERSION);
  });
});
