import { isValidUserId } from '@massalabs/gossip-sdk';
import { ImportPasswords, type ImportPasswordId } from './importPasswords';

export interface ImportedAccountPreview {
  userId: string;
  username: string;
  avatar: string | null;
  createdAtMs: number;
}

export interface LoadedImportedAccountPreview extends ImportedAccountPreview {
  /** Runtime-only opaque password handle. It encodes no account or slot data. */
  passwordId: ImportPasswordId;
}

export type ImportedAccountAuthenticator = (
  password: Uint8Array
) => Promise<ImportedAccountPreview>;

function publicPreview(value: ImportedAccountPreview): ImportedAccountPreview {
  if (
    typeof value.userId !== 'string' ||
    !isValidUserId(value.userId) ||
    typeof value.username !== 'string' ||
    value.username.length === 0 ||
    value.username.length > 128 ||
    (value.avatar !== null &&
      (typeof value.avatar !== 'string' ||
        value.avatar.length > 1024 * 1024)) ||
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 0
  ) {
    throw new Error('Imported account preview is invalid');
  }
  return Object.freeze({
    userId: value.userId,
    username: value.username,
    avatar: value.avatar,
    createdAtMs: value.createdAtMs,
  });
}

/** Own authenticated previews and their wipeable password handles in RAM only. */
export class ImportedAccountPreviews {
  private readonly previews = new Map<
    ImportPasswordId,
    ImportedAccountPreview
  >();
  private disposed = false;

  constructor(private readonly passwords = new ImportPasswords()) {}

  async authenticate(
    passwordText: string,
    authenticate: ImportedAccountAuthenticator
  ): Promise<LoadedImportedAccountPreview> {
    if (this.disposed)
      throw new Error('Imported account previews are disposed');
    const loaded = await this.passwords.load(passwordText, async candidate => {
      const authenticated = publicPreview(await authenticate(candidate));
      if (
        [...this.previews.values()].some(
          existing => existing.userId === authenticated.userId
        )
      ) {
        throw new Error('Imported account password was already accepted');
      }
      return authenticated;
    });
    this.previews.set(loaded.id, loaded.value);
    return Object.freeze({ ...loaded.value, passwordId: loaded.id });
  }

  list(): LoadedImportedAccountPreview[] {
    if (this.disposed)
      throw new Error('Imported account previews are disposed');
    return [...this.previews].map(([passwordId, preview]) => ({
      ...preview,
      passwordId,
    }));
  }

  async usePassword<T>(
    passwordId: ImportPasswordId,
    operation: (password: Uint8Array) => T | Promise<T>
  ): Promise<T> {
    if (!this.previews.has(passwordId)) {
      throw new Error('Imported account preview is unavailable');
    }
    return this.passwords.use(passwordId, operation);
  }

  remove(passwordId: ImportPasswordId): boolean {
    const removed = this.previews.delete(passwordId);
    const wiped = this.passwords.remove(passwordId);
    return removed && wiped;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.previews.clear();
    this.passwords.dispose();
  }
}
