/**
 * Reads drizzle-kit's migration journal and SQL files, then writes
 * a versioned migration array for the runtime migration runner.
 *
 * Run via: npm run db:generate
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(__dirname, '../drizzle');
const outputFile = resolve(__dirname, '../src/db/generated-migrations.ts');

const journal = JSON.parse(
  readFileSync(resolve(drizzleDir, 'meta/_journal.json'), 'utf-8')
);

const migrations = journal.entries.map(
  (entry: { idx: number; tag: string; when: number }) => {
    const sql = readFileSync(
      resolve(drizzleDir, `${entry.tag}.sql`),
      'utf-8'
    ).replace(/\r\n?/g, '\n');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s: string) => s.trim())
      .filter(Boolean);
    const digest = createHash('sha256')
      .update(JSON.stringify({ idx: entry.idx, tag: entry.tag, statements }))
      .digest('hex');
    return {
      idx: entry.idx,
      tag: entry.tag,
      when: entry.when,
      digest,
      statements,
    };
  }
);

const totalStatements = migrations.reduce(
  (n: number, m: { statements: string[] }) => n + m.statements.length,
  0
);

const output = `// Auto-generated from drizzle migrations — do not edit manually.
// Regenerate with: npm run db:generate

export interface EmbeddedMigration {
  idx: number;
  tag: string;
  when: number;
  digest: string;
  statements: string[];
}

export const MIGRATIONS: EmbeddedMigration[] = ${JSON.stringify(migrations, null, 2)};
`;

writeFileSync(outputFile, output);
console.log(
  `Generated ${migrations.length} migrations (${totalStatements} statements) -> src/db/generated-migrations.ts`
);
