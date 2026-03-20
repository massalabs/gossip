/**
 * Secure storage Node.js backend — registers node:fs callbacks for
 * the WASM module and returns the initialized module.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { BLOCK_SIZE, SESSION_COUNT } from './secure-storage-constants.js';

interface FsHandle {
  fd: number;
  path: string;
}

export async function initSecureStorageNodeFs(
  dirPath: string,
  domain?: string
): Promise<any> {
  const fs = await import('node:fs');
  const path = await import('node:path');

  fs.mkdirSync(dirPath, { recursive: true });

  const blockFds: FsHandle[] = [];
  const keypairFds: FsHandle[] = [];

  for (let i = 0; i < SESSION_COUNT; i++) {
    const blockPath = path.join(dirPath, `session_${i}.blocks`);
    const kpPath = path.join(dirPath, `session_${i}.keypair`);

    // Create files if they don't exist
    if (!fs.existsSync(blockPath)) fs.writeFileSync(blockPath, Buffer.alloc(0));
    if (!fs.existsSync(kpPath)) fs.writeFileSync(kpPath, Buffer.alloc(0));

    blockFds.push({ fd: fs.openSync(blockPath, 'r+'), path: blockPath });
    keypairFds.push({ fd: fs.openSync(kpPath, 'r+'), path: kpPath });
  }

  // WASM FFI callbacks — names must match Rust extern declarations
  const g = globalThis as any;

  g.bordercryptReadBlock = (session: number, block: number): Uint8Array => {
    const buf = Buffer.alloc(BLOCK_SIZE);
    fs.readSync(blockFds[session].fd, buf, 0, BLOCK_SIZE, block * BLOCK_SIZE);
    return new Uint8Array(buf);
  };

  g.bordercryptWriteBlock = (
    session: number,
    block: number,
    data: Uint8Array
  ): void => {
    fs.writeSync(
      blockFds[session].fd,
      data,
      0,
      data.byteLength,
      block * BLOCK_SIZE
    );
  };

  g.bordercryptAppendBlock = (session: number, data: Uint8Array): void => {
    const size = fs.fstatSync(blockFds[session].fd).size;
    fs.writeSync(blockFds[session].fd, data, 0, data.byteLength, size);
  };

  g.bordercryptBlockCount = (session: number): number => {
    return Math.floor(fs.fstatSync(blockFds[session].fd).size / BLOCK_SIZE);
  };

  g.bordercryptFsync = (session: number): void => {
    fs.fsyncSync(blockFds[session].fd);
  };

  g.bordercryptReadKeypair = (session: number): Uint8Array => {
    const size = fs.fstatSync(keypairFds[session].fd).size;
    if (size === 0) return new Uint8Array(0);
    const buf = Buffer.alloc(size);
    fs.readSync(keypairFds[session].fd, buf, 0, size, 0);
    return new Uint8Array(buf);
  };

  g.bordercryptWriteKeypair = (session: number, data: Uint8Array): void => {
    fs.ftruncateSync(keypairFds[session].fd, 0);
    fs.writeSync(keypairFds[session].fd, data, 0, data.byteLength, 0);
    fs.fsyncSync(keypairFds[session].fd);
  };

  // Load and init secure storage WASM
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);

  // For Node.js, use initSync with the WASM binary
  const bcPkgDir = path.dirname(
    require.resolve('../../src/assets/generated/wasm-bordercrypt/bordercrypt.js')
  );
  const wasmBinary = fs.readFileSync(
    path.join(bcPkgDir, 'bordercrypt_bg.wasm')
  );

  const bcModule = await import(
    /* @vite-ignore */
    '../assets/generated/wasm-bordercrypt/bordercrypt.js'
  );
  bcModule.initSync({ module: wasmBinary });
  bcModule.initBordercrypt(domain || 'gossip');

  return bcModule;
}
