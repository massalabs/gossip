import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const LOCALES_DIR = join(__dirname, '../../src/i18n/locales');
const REFERENCE_LOCALE = 'en';

/**
 * Recursively extract all dot-path keys from a nested JSON object.
 * e.g. { a: { b: "x", c: "y" }, d: "z" } => ["a.b", "a.c", "d"]
 */
function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys.sort();
}

/**
 * Load all namespaces for a given locale and return a map of namespace => flat key set.
 */
function loadLocale(locale: string): Record<string, Set<string>> {
  const localeDir = join(LOCALES_DIR, locale);
  const files = readdirSync(localeDir).filter(f => f.endsWith('.json'));
  const result: Record<string, Set<string>> = {};

  for (const file of files) {
    const namespace = file.replace('.json', '');
    const content = JSON.parse(
      readFileSync(join(localeDir, file), 'utf-8')
    ) as Record<string, unknown>;
    result[namespace] = new Set(flattenKeys(content));
  }

  return result;
}

// Discover locales dynamically from the filesystem
const locales = readdirSync(LOCALES_DIR).filter(entry => {
  return statSync(join(LOCALES_DIR, entry)).isDirectory();
});

const allLocaleData: Record<string, Record<string, Set<string>>> = {};
for (const locale of locales) {
  allLocaleData[locale] = loadLocale(locale);
}

// Collect the union of all namespaces across all locales
const allNamespaces = new Set<string>();
for (const localeData of Object.values(allLocaleData)) {
  for (const ns of Object.keys(localeData)) {
    allNamespaces.add(ns);
  }
}

describe('i18n translation key completeness', () => {
  // For each namespace, build the union of all keys across all locales.
  // Then check each locale against that union.
  for (const namespace of [...allNamespaces].sort()) {
    describe(`namespace: ${namespace}`, () => {
      // Build union of all keys for this namespace
      const unionKeys = new Set<string>();
      for (const locale of locales) {
        const keys = allLocaleData[locale]?.[namespace];
        if (keys) {
          for (const k of keys) unionKeys.add(k);
        }
      }

      for (const locale of locales) {
        it(`"${locale}" has all keys for [${namespace}]`, () => {
          const localeKeys = allLocaleData[locale]?.[namespace] ?? new Set();
          const missing = [...unionKeys].filter(k => !localeKeys.has(k));

          if (missing.length > 0) {
            // Log a clear warning with all missing keys
            console.warn(
              `\n  [${locale}/${namespace}] missing ${missing.length} key(s):\n` +
                missing.map(k => `    - ${k}`).join('\n')
            );
          }

          // Goal state: every locale returns [] (no missing keys).
          // Non-empty snapshots track known gaps — add the translations,
          // then run `vitest -u` to refresh the snapshot.
          expect(missing).toMatchSnapshot();
        });
      }
    });
  }

  it('all locales have the same set of namespace files', () => {
    const referenceNamespaces = Object.keys(
      allLocaleData[REFERENCE_LOCALE]
    ).sort();

    const issues: string[] = [];
    for (const locale of locales) {
      if (locale === REFERENCE_LOCALE) continue;
      const localeNamespaces = Object.keys(allLocaleData[locale]).sort();

      const missingNs = referenceNamespaces.filter(
        ns => !localeNamespaces.includes(ns)
      );
      const extraNs = localeNamespaces.filter(
        ns => !referenceNamespaces.includes(ns)
      );

      if (missingNs.length > 0) {
        issues.push(
          `${locale} is missing namespace file(s): ${missingNs.join(', ')}`
        );
      }
      if (extraNs.length > 0) {
        issues.push(
          `${locale} has extra namespace file(s): ${extraNs.join(', ')}`
        );
      }
    }

    if (issues.length > 0) {
      console.warn(
        '\n  Namespace mismatches:\n' + issues.map(i => `    - ${i}`).join('\n')
      );
    }

    expect(issues).toMatchSnapshot();
  });
});
