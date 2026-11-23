import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script without types
import { auditFullDebug } from '../../scripts/audit-full-debug.mjs';

describe('audit-full-debug', () => {
  it('passes a normal bundle (the store key debug-logs-v1 is not the upload path)', () => {
    expect(
      auditFullDebug([{ path: 'dist/a.js', text: 'k="debug-logs-v1";f="gossip-debug-logs-x.txt"' }])
    ).toEqual([]);
  });
  it('finds the upload path and the plugin', () => {
    const found = auditFullDebug([
      { path: 'dist/b.js', text: '`${o}/debug-logs`;registerPlugin("DebugLogFile")' },
    ]);
    expect(found.map((v: { marker: string }) => v.marker)).toEqual(['/debug-logs', 'DebugLogFile']);
  });
});
