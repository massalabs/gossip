/**
 * Standalone bordercrypt manager — loads the WASM module independently
 * of SQLite, using in-memory storage callbacks.
 *
 * This allows testing the full bordercrypt lifecycle (provision, allocate,
 * unlock, lock, cover traffic) without routing SQLite through the VFS.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const BLOCK_SIZE = 65536;
const SESSION_COUNT = 5;

interface BordercryptModule {
  initBordercrypt(domain: string): void;
  provisionStorage(): void;
  allocateSession(slot: number, password: Uint8Array): void;
  unlockSession(password: Uint8Array): boolean;
  lockSession(): void;
  isUnlocked(): boolean;
  coverTrafficTick(): void;
  getDataSize(): number;
}

/**
 * In-memory storage for bordercrypt blocks and keypairs.
 * Registers synchronous callbacks on globalThis for the WASM module.
 */
class MemoryBackend {
  private blocks: Uint8Array[][] = [];
  private keypairs: Uint8Array[] = [];

  constructor() {
    for (let i = 0; i < SESSION_COUNT; i++) {
      this.blocks[i] = [];
      this.keypairs[i] = new Uint8Array(0);
    }
  }

  register(): void {
    const g = globalThis as any;

    g.bordercryptReadBlock = (session: number, block: number): Uint8Array => {
      return this.blocks[session]?.[block] ?? new Uint8Array(BLOCK_SIZE);
    };

    g.bordercryptWriteBlock = (
      session: number,
      block: number,
      data: Uint8Array
    ): void => {
      while (this.blocks[session].length <= block) {
        this.blocks[session].push(new Uint8Array(BLOCK_SIZE));
      }
      this.blocks[session][block] = new Uint8Array(data);
    };

    g.bordercryptAppendBlock = (
      session: number,
      data: Uint8Array
    ): void => {
      this.blocks[session].push(new Uint8Array(data));
    };

    g.bordercryptBlockCount = (session: number): number => {
      return this.blocks[session].length;
    };

    g.bordercryptFsync = (): void => {
      // No-op for in-memory storage
    };

    g.bordercryptReadKeypair = (session: number): Uint8Array => {
      return this.keypairs[session];
    };

    g.bordercryptWriteKeypair = (
      session: number,
      data: Uint8Array
    ): void => {
      this.keypairs[session] = new Uint8Array(data);
    };
  }
}

export class BordercryptStandalone {
  private module: BordercryptModule | null = null;
  private backend: MemoryBackend | null = null;

  async init(domain: string = 'gossip'): Promise<void> {
    this.backend = new MemoryBackend();
    this.backend.register();

    const mod = await import(
      /* @vite-ignore */
      '../assets/generated/wasm-bordercrypt/bordercrypt.js'
    );
    await mod.default();
    mod.initBordercrypt(domain);
    this.module = mod;
    console.log('[Bordercrypt] WASM module loaded');
  }

  private require(): BordercryptModule {
    if (!this.module) throw new Error('Bordercrypt not initialized');
    return this.module;
  }

  provision(): void {
    this.require().provisionStorage();
    console.log('[Bordercrypt] Storage provisioned');
  }

  allocate(slot: number, password: string): void {
    this.require().allocateSession(
      slot,
      new TextEncoder().encode(password)
    );
    console.log(`[Bordercrypt] Session allocated in slot ${slot}`);
  }

  unlock(password: string): boolean {
    const result = this.require().unlockSession(
      new TextEncoder().encode(password)
    );
    console.log(`[Bordercrypt] Unlock: ${result ? 'success' : 'no match'}`);
    return result;
  }

  lock(): void {
    this.require().lockSession();
    console.log('[Bordercrypt] Session locked');
  }

  get unlocked(): boolean {
    return this.module?.isUnlocked() ?? false;
  }
}
