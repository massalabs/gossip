import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/audit-production-worker.mjs', import.meta.url)
);
const temporaryRoots: string[] = [];

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gossip worker audit '));
  temporaryRoots.push(root);
  await mkdir(join(root, 'assets'));
  return root;
}

function audit(root: string) {
  return spawnSync(process.execPath, [script, root], {
    encoding: 'utf8',
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(root => rm(root, { recursive: true }))
  );
});

describe('production worker artifact audit', () => {
  it('resolves its default artifact URL from a checkout path containing spaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gossip checkout '));
    temporaryRoots.push(root);
    const copiedScript = join(root, 'scripts', 'audit-production-worker.mjs');
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'dist', 'assets'), { recursive: true });
    await copyFile(script, copiedScript);
    await writeFile(
      join(root, 'dist', 'assets', 'secure-storage-worker-clean.js'),
      'export const productionWorker = true;\n'
    );

    const result = spawnSync(process.execPath, [copiedScript], {
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts a clean worker from an artifact path containing spaces', async () => {
    const root = await artifactRoot();
    await writeFile(
      join(root, 'assets', 'secure-storage-worker-clean.js'),
      'export const productionWorker = true;\n'
    );

    const result = audit(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Production secure-storage worker contains no test fault controls'
    );
  });

  it('ignores forbidden tokens outside the artifact root', async () => {
    const parent = await mkdtemp(
      join(tmpdir(), 'secure-storage-worker-test checkout ')
    );
    temporaryRoots.push(parent);
    const root = join(parent, 'dist');
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(
      join(root, 'assets', 'secure-storage-worker-clean.js'),
      'export const productionWorker = true;\n'
    );

    const result = audit(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects forbidden tokens in a relative artifact path', async () => {
    const root = await artifactRoot();
    await writeFile(
      join(root, 'assets', 'secure-storage-worker-test.js'),
      'export const productionWorker = true;\n'
    );

    const result = audit(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${join('assets', 'secure-storage-worker-test.js')} contains secure-storage-worker-test`
    );
  });

  it('rejects forbidden controls in a final application worker', async () => {
    const root = await artifactRoot();
    await writeFile(
      join(root, 'assets', 'secure-storage-worker-bad.js'),
      'export const injectIndexedDbFaultsForTesting = true;\n'
    );

    const result = audit(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('injectIndexedDbFaultsForTesting');
  });

  it('rejects an artifact root with no production worker', async () => {
    const root = await artifactRoot();
    await writeFile(join(root, 'assets', 'application.js'), 'export {};\n');

    const result = audit(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'no production secure-storage worker artifact was found'
    );
  });
});
