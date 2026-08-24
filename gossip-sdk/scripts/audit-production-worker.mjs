import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('../dist/', import.meta.url);
const forbidden = [
  'injectIndexedDbFaultsForTesting',
  'clearIndexedDbFaultsForTesting',
  'retryFailedCoverNowForTesting',
  'stopPeriodicCoverForTesting',
  'secure-storage-worker-test',
];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    })
  );
  return nested.flat();
}

const distPath = root.pathname;
const artifacts = await files(distPath);
const violations = [];
for (const artifact of artifacts) {
  if (!/\.(?:js|d\.ts)$/.test(artifact)) continue;
  const content = await readFile(artifact, 'utf8');
  for (const token of forbidden) {
    if (artifact.includes(token) || content.includes(token)) {
      violations.push(`${relative(distPath, artifact)} contains ${token}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Production secure-storage worker audit failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    'Production secure-storage worker contains no test fault controls.'
  );
}
