import { spawnSync } from 'node:child_process';

const suites = [
  [
    'default-feature',
    [
      'test',
      '--workspace',
      '--manifest-path',
      'wasm/Cargo.toml',
      '--all-targets',
      '--verbose',
    ],
  ],
  [
    'native secure-storage',
    [
      'test',
      '--manifest-path',
      'wasm/Cargo.toml',
      '-p',
      'secureStorage',
      '--no-default-features',
      '--features',
      'native',
    ],
  ],
];

const forwardedArgs = process.argv.slice(2);

for (const [name, cargoArgs] of suites) {
  console.log(`Running ${name} Rust tests`);
  const result = spawnSync('cargo', [...cargoArgs, ...forwardedArgs], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
