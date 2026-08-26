import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const manifestPath = path.join(root, 'COMPATIBILITY-FIXTURES.sha256');
const fixedFixtures = [
  'gossip-sdk/drizzle/meta/_journal.json',
  'test/fixtures/profileSecurityV1.ts',
  'wasm/secure-storage/tests/fixtures/portable-v1-minimal.gossipbackup',
  'wasm/sessions/tests/fixtures/session-manager-v1.bin',
];

async function expectedPaths(): Promise<string[]> {
  const migrations = (await readdir(path.join(root, 'gossip-sdk/drizzle')))
    .filter(file => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .map(file => `gossip-sdk/drizzle/${file}`);
  return [...migrations, ...fixedFixtures].sort();
}

async function manifestEntries(): Promise<Array<[string, string]>> {
  const manifest = await readFile(manifestPath, 'utf8');
  expect(manifest.endsWith('\n')).toBe(true);
  return manifest
    .trimEnd()
    .split('\n')
    .map(line => {
      const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9_./-]+)$/.exec(line);
      expect(
        match,
        `invalid compatibility manifest line: ${line}`
      ).not.toBeNull();
      return [match![1], match![2]];
    });
}

describe('compatibility fixture hashes', () => {
  it('covers every released SQL migration and frozen format fixture exactly once', async () => {
    const entries = await manifestEntries();
    const paths = entries.map(([, file]) => file);

    expect(paths).toEqual([...paths].sort());
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(await expectedPaths());
  });

  it('freezes append-only migration indices and tags', async () => {
    const migrations = (await expectedPaths()).filter(file =>
      file.endsWith('.sql')
    );
    const journal = JSON.parse(
      await readFile(
        path.join(root, 'gossip-sdk/drizzle/meta/_journal.json'),
        'utf8'
      )
    ) as { entries: Array<{ idx: number; tag: string }> };

    expect(journal.entries.map(({ idx, tag }) => ({ idx, tag }))).toEqual(
      migrations.map((file, idx) => ({
        idx,
        tag: path.basename(file, '.sql'),
      }))
    );
  });

  it('matches every committed byte sequence', async () => {
    const entries = await manifestEntries();
    for (const [expectedHash, file] of entries) {
      const absolute = path.resolve(root, file);
      expect(absolute.startsWith(`${root}${path.sep}`)).toBe(true);
      const actualHash = createHash('sha256')
        .update(await readFile(absolute))
        .digest('hex');
      expect(actualHash, file).toBe(expectedHash);
    }
  });
});
