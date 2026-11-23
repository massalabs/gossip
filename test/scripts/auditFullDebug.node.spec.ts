import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script without types
import {
  auditFullDebug,
  auditFullDebugWasm,
} from '../../scripts/audit-full-debug.mjs';

describe('audit-full-debug', () => {
  it('passes a normal bundle (the store key debug-logs-v1 is not the upload path)', () => {
    expect(
      auditFullDebug([
        {
          path: 'dist/a.js',
          text: 'k="debug-logs-v1";f="gossip-debug-logs-x.txt"',
        },
      ])
    ).toEqual([]);
  });
  it('finds the upload path and the plugin', () => {
    const found = auditFullDebug([
      {
        path: 'dist/b.js',
        text: '`${o}/debug-logs`;registerPlugin("DebugLogFile")',
      },
    ]);
    expect(found.map((v: { marker: string }) => v.marker)).toEqual([
      '/debug-logs',
      'DebugLogFile',
    ]);
  });
  it('finds the engine debug events in a wasm module', () => {
    const debug = new TextEncoder().encode(
      '\0asm\u0001engine.event.in\0engine.retrieval.ask\0'
    );
    const normal = new TextEncoder().encode('\0asm\u0001engine.open\0');
    expect(
      auditFullDebugWasm([
        { path: 'dist/a.wasm', bytes: debug },
        { path: 'dist/b.wasm', bytes: normal },
      ]).map((v: { path: string; marker: string }) => `${v.path} ${v.marker}`)
    ).toEqual([
      'dist/a.wasm engine.event.in',
      'dist/a.wasm engine.retrieval.ask',
    ]);
  });
});
