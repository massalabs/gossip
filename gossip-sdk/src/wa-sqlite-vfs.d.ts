// Type declarations for wa-sqlite VFS implementations missing from upstream types.

declare module 'wa-sqlite/src/examples/AccessHandlePoolVFS.js' {
  import * as VFS from 'wa-sqlite/src/VFS.js';
  export class AccessHandlePoolVFS extends VFS.Base {
    constructor(directoryPath: string);
    isReady: Promise<void>;
    name: string;
    close(): Promise<void>;
    getCapacity(): number;
    getSize(): number;
    addCapacity(count: number): Promise<number>;
  }
}
