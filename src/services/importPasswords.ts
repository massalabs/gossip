const encoder = new TextEncoder();

/**
 * Password bytes owned by one import operation.
 *
 * Callers may borrow the bytes only for the duration of `use`. They must not
 * retain, transfer, log, or persist that reference. `dispose` wipes the same
 * backing buffer synchronously and is safe to call repeatedly.
 */
export class ImportPassword {
  private bytes: Uint8Array | null;

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  static fromText(text: string): ImportPassword {
    return new ImportPassword(encoder.encode(text));
  }

  get disposed(): boolean {
    return this.bytes === null;
  }

  async use<T>(
    operation: (password: Uint8Array) => T | Promise<T>
  ): Promise<T> {
    if (!this.bytes) throw new Error('Import password was disposed');
    return operation(this.bytes);
  }

  dispose(): void {
    this.bytes?.fill(0);
    this.bytes = null;
  }
}

export type ImportPasswordId = symbol;

export interface LoadedImportPassword<T> {
  id: ImportPasswordId;
  value: T;
}

/**
 * Owns passwords accepted by the import screen.
 *
 * Exactly one password authentication may run at a time. A failed candidate
 * is wiped immediately. A successful candidate remains in mutable memory
 * until it is removed, transferred to migration ownership, or the whole set
 * is disposed. The opaque symbols are runtime-only and intentionally cannot
 * encode a profile, slot, or other account identifier.
 */
export class ImportPasswords {
  private readonly retained = new Map<ImportPasswordId, ImportPassword>();
  private loading = false;
  private disposed = false;
  private active: ImportPassword | null = null;

  get isLoading(): boolean {
    return this.loading;
  }

  get size(): number {
    return this.retained.size;
  }

  async load<T>(
    text: string,
    authenticate: (password: Uint8Array) => T | Promise<T>
  ): Promise<LoadedImportPassword<T>> {
    if (this.disposed) throw new Error('Import passwords were disposed');
    if (this.loading) throw new Error('An import password is already loading');

    const password = ImportPassword.fromText(text);
    this.active = password;
    this.loading = true;
    try {
      const value = await password.use(authenticate);
      if (this.disposed) {
        throw new Error('Import passwords were disposed');
      }
      const id = Symbol('import-password');
      this.retained.set(id, password);
      return { id, value };
    } catch (error) {
      password.dispose();
      throw error;
    } finally {
      if (this.active === password) this.active = null;
      this.loading = false;
    }
  }

  async use<T>(
    id: ImportPasswordId,
    operation: (password: Uint8Array) => T | Promise<T>
  ): Promise<T> {
    if (this.disposed) throw new Error('Import passwords were disposed');
    const password = this.retained.get(id);
    if (!password) throw new Error('Import password is unavailable');
    return password.use(operation);
  }

  remove(id: ImportPasswordId): boolean {
    const password = this.retained.get(id);
    if (!password) return false;
    this.retained.delete(id);
    password.dispose();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.dispose();
    this.active = null;
    for (const password of this.retained.values()) password.dispose();
    this.retained.clear();
  }
}
