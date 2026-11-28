import { describe, expect, it } from 'vitest';
import { auditPaths, formatViolations } from '../../scripts/audit-paths.mjs';

const bytes = (text: string) => Buffer.from(`\0asm${text}\0`, 'latin1');

describe('developer-path check', () => {
  it('passes files whose paths were remapped', () => {
    expect(
      auditPaths([
        {
          path: 'a.wasm',
          bytes: bytes(
            '/cargo/registry/src/x/lib.rs\0~/x\0/gossip/wasm\0HOME:"/home/web_user"'
          ),
        },
      ])
    ).toEqual([]);
  });

  it('fails on a home directory of Linux, macOS or Windows', () => {
    const violations = auditPaths([
      { path: 'a.wasm', bytes: bytes('/home/alice/.cargo/registry/x.rs') },
      { path: 'b.js', bytes: bytes('"/Users/bob/src/app.ts"') },
      { path: 'c.wasm', bytes: bytes('C:\\Users\\carol\\x.rs') },
    ]);

    expect(violations.map(v => v.path)).toEqual(['a.wasm', 'b.js', 'c.wasm']);
    const message = formatViolations(violations);
    expect(message).toContain('/home/alice/.cargo/registry/x.rs');
    expect(message).toContain('privacy-first');
    expect(message).toContain('user name');
    expect(message).toContain('--remap-path-prefix');
    expect(message).toContain('STOP and ask the project owner');
  });
});
