import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  auditDebugLogsSetting,
  auditDistConsole,
  auditNativeLogs,
  auditPatches,
  auditSourceConsole,
  formatViolations,
} from '../../scripts/audit-logging.mjs';

const rules = (violations: { rule: string }[]) => violations.map(v => v.rule);

describe('logging audit: console', () => {
  it('flags every console method and the dynamic forms in app source', () => {
    const violations = auditSourceConsole([
      {
        path: 'src/a.ts',
        text: [
          'console.table(rows);',
          'console.trace();',
          'console?.dir(x);',
          "console['log'](x);",
          'console?.[level](x);',
        ].join('\n'),
      },
    ]);
    expect(violations.map(v => v.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it('leaves the logger boundary alone', () => {
    expect(
      auditSourceConsole([
        { path: 'src/utils/logger.ts', text: 'console.debug(x)' },
      ])
    ).toEqual([]);
  });

  it('accepts the one known i18next instance in the bundle, nothing else', () => {
    const i18next =
      'error(ae){this.output("error",ae)},output(ae,oe){console?.[ae]?.apply?.(console,oe)}};';
    expect(auditDistConsole([{ path: 'dist/a.js', text: i18next }])).toEqual(
      []
    );
    expect(
      auditDistConsole([
        { path: 'dist/a.js', text: `${i18next}console[t](secret)` },
      ])
    ).toHaveLength(1);
  });
});

describe('logging audit: native logs', () => {
  it('flags Kotlin and Java log calls outside DebugLog', () => {
    const violations = auditNativeLogs([
      {
        path: 'android/app/src/main/java/net/massa/gossip/A.kt',
        text: [
          'Log.d(TAG, "x")',
          'DebugLog.d(TAG, "x")',
          '// Log.d(TAG, "in a comment")',
          'val s = "Log.d( in a string"',
          'e.printStackTrace()',
          'println("x")',
        ].join('\n'),
      },
      {
        path: 'android/app/src/main/java/net/massa/gossip/B.java',
        text: 'System.out.println("x");',
      },
    ]);
    expect(violations.map(v => `${v.file.split('/').pop()}:${v.line}`)).toEqual(
      ['A.kt:1', 'A.kt:6', 'A.kt:5', 'B.java:1']
    );
  });

  it('accepts the DebugLog helper itself', () => {
    expect(
      auditNativeLogs([
        {
          path: 'android/app/src/main/java/net/massa/gossip/DebugLog.kt',
          text: 'if (BuildConfig.DEBUG) Log.d(tag, msg)',
        },
      ])
    ).toEqual([]);
  });

  it('flags Swift logs outside #if DEBUG, and the #else branch', () => {
    const violations = auditNativeLogs([
      {
        path: 'ios/App/App/A.swift',
        text: [
          'NSLog("a")', // 1
          '#if DEBUG',
          'os_log("b", log: log, type: .error)',
          'private let logger = Logger(subsystem: "s", category: "c")',
          '#else',
          'print("c")', // 6
          '#endif',
          'CAPLog.print("d")', // 8
        ].join('\n'),
      },
    ]);
    expect(violations.map(v => v.line)).toEqual([1, 6, 8]);
  });

  it("passes the app's own native code", () => {
    const files = execFileSync(
      'git',
      ['ls-files', 'android/app/src/main', 'ios/App'],
      { encoding: 'utf8' }
    )
      .split('\n')
      .filter(path => /\.(kt|java|swift)$/.test(path))
      .map(path => ({ path, text: readFileSync(path, 'utf8') }));
    expect(files.length).toBeGreaterThan(20);
    expect(auditNativeLogs(files)).toEqual([]);
  });
});

describe('logging audit: VITE_DEBUG_LOGS', () => {
  it('refuses debug logs in a production build', () => {
    const violations = auditDebugLogsSetting([
      { source: 'environment', value: 'true' },
    ]);
    expect(rules(violations)).toEqual([
      'VITE_DEBUG_LOGS=true in a production build',
    ]);
    expect(formatViolations(violations)).toContain('unset VITE_DEBUG_LOGS');
  });

  it('accepts it unset or false', () => {
    expect(
      auditDebugLogsSetting([{ source: 'environment', value: 'false' }])
    ).toEqual([]);
    expect(auditDebugLogsSetting([])).toEqual([]);
  });
});

describe('logging audit: patches', () => {
  const header = [
    'diff --git a/node_modules/x/Handler.swift b/node_modules/x/Handler.swift',
    '--- a/node_modules/x/Handler.swift',
    '+++ b/node_modules/x/Handler.swift',
    '@@ -1,4 +1,10 @@',
  ];

  it('flags a trust change with no debug guard in its hunk', () => {
    const violations = auditPatches([
      {
        path: 'patches/x.patch',
        text: [
          ...header,
          '     func challenge() {',
          '+        completionHandler(.useCredential, URLCredential(trust: serverTrust))',
          '-        completionHandler(.rejectProtectionSpace, nil)',
          '+        completionHandler(.performDefaultHandling, nil)',
          '     }',
        ].join('\n'),
      },
    ]);
    expect(violations).toHaveLength(1);
    const message = formatViolations(violations);
    expect(message).toContain('patches/x.patch');
    expect(message).toContain('man in the middle');
    expect(message).toContain('STOP and ask the project owner');
  });

  it('accepts the same change inside #if DEBUG', () => {
    expect(
      auditPatches([
        {
          path: 'patches/x.patch',
          text: [
            ...header,
            '     func challenge() {',
            '+        #if DEBUG',
            '+        completionHandler(.useCredential, URLCredential(trust: serverTrust))',
            '+        #endif',
            '     }',
          ].join('\n'),
        },
      ])
    ).toEqual([]);
  });

  it('passes the patches of the repository', () => {
    const files = execFileSync('git', ['ls-files', 'patches'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(path => path.endsWith('.patch'))
      .map(path => ({ path, text: readFileSync(path, 'utf8') }));
    expect(files.length).toBeGreaterThan(0);
    expect(auditPatches(files)).toEqual([]);
  });
});
