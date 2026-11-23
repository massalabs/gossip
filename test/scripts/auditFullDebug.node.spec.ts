import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script without types
import { auditFullDebug, markersFor } from '../../scripts/audit-full-debug.mjs';

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
  it('finds the encryption of the debug logs and the built-in key', () => {
    const key =
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEzO6DCrZshIuSJZtrPLwMo1GyT4I9wjeNwu+xFkT5hCewuDGpHS55r+csLbBYg3X17Xt21umN8KcICmU4rOxWvg==';
    const found = auditFullDebug(
      [
        {
          path: 'dist/c.js',
          text: `i=new TextEncoder().encode("gossip-debug-logs v1");k="${key}"`,
        },
      ],
      markersFor({ VITE_DEBUG_LOGS_PUBLIC_KEY: key })
    );
    expect(found.map((v: { marker: string }) => v.marker)).toEqual([
      'gossip-debug-logs v1',
      key,
    ]);
  });
});
