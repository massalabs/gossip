import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const distPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : defaultRoot;
const forbidden = [
  'injectIndexedDbFaultsForTesting',
  'clearIndexedDbFaultsForTesting',
  'retryFailedCoverNowForTesting',
  'stopPeriodicCoverForTesting',
  'rejectNextSqlRollbackForTesting',
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

const artifacts = await files(distPath);
const productionWorkers = artifacts.filter(artifact =>
  /^secure-storage-worker(?:[-.].*)?\.js$/.test(basename(artifact))
);
const violations = [];
if (productionWorkers.length === 0) {
  violations.push('no production secure-storage worker artifact was found');
}
for (const artifact of artifacts) {
  if (!/\.(?:js|d\.ts)$/.test(artifact)) continue;
  const artifactPath = relative(distPath, artifact);
  const content = await readFile(artifact, 'utf8');
  for (const token of forbidden) {
    if (artifactPath.includes(token) || content.includes(token)) {
      violations.push(`${artifactPath} contains ${token}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Production secure-storage worker audit failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    `Production secure-storage worker contains no test fault controls (${relative(process.cwd(), distPath)}).`
  );
}
