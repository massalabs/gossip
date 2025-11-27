/**
 * Type declarations for blake3-js
 */
declare module 'blake3-js' {
  export class Hasher {
    static newRegular(): Hasher;
    update(input: string | Uint8Array | number[]): Hasher;
    finalize(length?: number, format?: 'hex' | 'bytes'): string | number[];
  }

  export default Hasher;
}
