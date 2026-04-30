/**
 * Regression guard for the "detached ArrayBuffer after Comlink.transfer"
 * class of bugs.
 *
 * Background: SQL bind params on the secure-storage WASM-worker path
 * used to be marked transferable via `Comlink.transfer(params, ...)` for
 * a perf win. That move detaches the source ArrayBuffers as soon as the
 * worker call dispatches, and any code that *also* keeps references to
 * those Uint8Arrays (Drizzle's error wrapping, the `SEEKERS_UPDATED`
 * event listener, etc.) blows up the next time it tries to read them
 * with cryptic "Cannot perform values on a detached or out-of-bounds
 * ArrayBuffer". The fix landed in a previous commit dropped the
 * transfer; this test makes sure nobody re-introduces it inside the
 * SQL execution path.
 *
 * Strategy: static source scan. Read `gossip-sdk/src/db/sqlite.ts`,
 * count `Comlink.transfer(...)` call sites, allow only those tagged
 * with the `ALLOWED-TRANSFER` rationale comment that the matching
 * ESLint rule (no-restricted-syntax) requires.
 *
 * If a future refactor adds a new `Comlink.transfer` somewhere, this
 * test fails along with the lint — two layers, both cheap.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQLITE_TS = resolve(__dirname, '../../src/db/sqlite.ts');

describe('Comlink.transfer regression guard', () => {
  it('every `Comlink.transfer` in sqlite.ts has an `ALLOWED-TRANSFER` justification', () => {
    const source = readFileSync(SQLITE_TS, 'utf8');
    const lines = source.split('\n');

    const transferLines = lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => /\bComlink\.transfer\s*\(/.test(line));

    for (const { line, idx } of transferLines) {
      // Look at the previous non-empty source line for the ESLint
      // disable + ALLOWED-TRANSFER tag. The rule's justification
      // comment may sit on the same line as the call too (formatter-
      // dependent), so check both.
      const prevLine = idx > 0 ? lines[idx - 1] : '';
      const onSameLine = line.includes('ALLOWED-TRANSFER');
      const onPrevLine = prevLine.includes('ALLOWED-TRANSFER');

      expect(
        onSameLine || onPrevLine,
        `Comlink.transfer at sqlite.ts:${idx + 1} is missing the ` +
          `ALLOWED-TRANSFER comment. Either drop the transfer (preferred — ` +
          `Comlink's default structured-clone is correct for SQL params) ` +
          `or add the eslint-disable comment with a one-line rationale ` +
          `confirming the caller does NOT reuse the buffer afterwards.\n` +
          `Offending line: ${line.trim()}`
      ).toBe(true);
    }
  });

  it('SQL bind params are NOT routed through Comlink.transfer', () => {
    // Tighter check: scan the secureProxy.exec branch specifically.
    // If anyone wires `params` (or a derivative) into Comlink.transfer
    // in this file again, fail loudly.
    const source = readFileSync(SQLITE_TS, 'utf8');

    // Find the `secureProxy.exec(...)` call and inspect its arguments.
    // The expected shape is `secureProxy.exec(sql, params, wasInTxn)`
    // with `params` passed directly (no transfer wrapper).
    const execCall = source.match(
      /secureProxy\.exec\s*\(\s*([^)]+)\)/s
    );
    expect(
      execCall,
      'Could not locate secureProxy.exec(...) call in sqlite.ts. ' +
        'Has the SQL exec path been renamed? Update this test.'
    ).not.toBeNull();

    const args = execCall![1];
    expect(
      /Comlink\.transfer/.test(args),
      'secureProxy.exec(...) argument list contains Comlink.transfer. ' +
        'SQL bind params must NOT be transferred — Drizzle keeps ' +
        'references to them after the call (error wrapping) and the ' +
        'detached buffers crash on the next access. Pass params by ' +
        'structured-clone instead (the Comlink default).'
    ).toBe(false);
  });
});
