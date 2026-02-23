/**
 * Reads drizzle-kit's generated SQL and writes a DDL array
 * with IF NOT EXISTS for safe re-runs.
 *
 * Run via: npm run db:generate
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(__dirname, '../drizzle');
const outputFile = resolve(__dirname, '../src/db/generated-ddl.ts');

// Read all .sql files in order
const sqlFiles = readdirSync(drizzleDir)
  .filter(f => f.endsWith('.sql'))
  .sort();

const statements: string[] = [];
for (const file of sqlFiles) {
  const content = readFileSync(resolve(drizzleDir, file), 'utf-8');
  const stmts = content
    .split('--> statement-breakpoint')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s =>
      s
        .replace(/^CREATE TABLE `/m, 'CREATE TABLE IF NOT EXISTS `')
        .replace(/^CREATE INDEX `/m, 'CREATE INDEX IF NOT EXISTS `')
        .replace(
          /^CREATE UNIQUE INDEX `/m,
          'CREATE UNIQUE INDEX IF NOT EXISTS `'
        )
    );
  statements.push(...stmts);
}

const output = `// Auto-generated from drizzle migrations — do not edit manually.
// Regenerate with: npm run db:generate

export const DDL: string[] = ${JSON.stringify(statements, null, 2)};
`;

writeFileSync(outputFile, output);
console.log(
  `Generated ${statements.length} DDL statements -> src/db/generated-ddl.ts`
);
