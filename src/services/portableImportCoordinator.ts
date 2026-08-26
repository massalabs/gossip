import type { GossipSdk, PortableImportCandidate } from '@massalabs/gossip-sdk';
import {
  ImportedAccountPreviews,
  type LoadedImportedAccountPreview,
} from './importedAccountPreviews';

export interface PortableImportAuthorization {
  claim(): Promise<void>;
  release(): Promise<void>;
  isAuthorized(): boolean;
  /** Durably consume replacement authority before the physical commit. */
  prepareCommit(): void;
  /** Finalize non-authority application state after the physical commit. */
  commitSuccess(): void;
}

interface RuntimeAuthorizationGate {
  active: boolean;
  commitPrepared: boolean;
}

/**
 * Own one validated replacement candidate and all accepted password buffers.
 *
 * Invalid candidate input or cancellation is terminal and wipes passwords.
 * A pre-commit migration/install failure keeps the candidate and passwords for
 * an explicit retry. Successful installation ends the SDK runtime, revokes the
 * onboarding grant, then wipes every retained password synchronously.
 */
export class PortableImportCoordinator {
  private readonly previews = new ImportedAccountPreviews();
  private closed = false;
  private cancelRequested = false;
  private installAttempted = false;
  private installReserved = false;
  private installing = false;
  private operationTail = Promise.resolve();

  private constructor(
    private readonly candidate: PortableImportCandidate,
    private readonly authorization: PortableImportAuthorization,
    private readonly gate: RuntimeAuthorizationGate
  ) {}

  static async begin(
    sdk: GossipSdk,
    authorization: PortableImportAuthorization
  ): Promise<PortableImportCoordinator> {
    await authorization.claim();
    const gate = { active: true, commitPrepared: false };
    let candidate: PortableImportCandidate;
    try {
      candidate = await sdk.beginPortableImport(() => {
        if (!gate.active) return false;
        if (gate.commitPrepared) return true;
        try {
          const authorized = authorization.isAuthorized();
          if (!authorized) gate.active = false;
          return authorized;
        } catch (error) {
          gate.active = false;
          throw error;
        }
      });
    } catch (error) {
      await authorization.release().catch(() => {});
      throw error;
    }
    return new PortableImportCoordinator(candidate, authorization, gate);
  }

  push(chunk: Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      this.requireOpen();
      await this.requireAuthorized();
      try {
        await this.candidate.push(chunk);
        await this.requireAuthorized();
      } catch (error) {
        await this.disposeIfRevoked();
        throw error;
      }
    });
  }

  finishValidation(): Promise<void> {
    return this.enqueue(async () => {
      this.requireOpen();
      await this.requireAuthorized();
      try {
        await this.candidate.finishValidation();
        await this.requireAuthorized();
      } catch (error) {
        await this.disposeIfRevoked();
        throw error;
      }
    });
  }

  authenticate(passwordText: string): Promise<LoadedImportedAccountPreview> {
    this.requireOpen();
    if (this.installAttempted) {
      return Promise.reject(new Error('Portable import account set is frozen'));
    }
    return this.enqueue(async () => {
      this.requireOpen();
      await this.requireAuthorized();
      try {
        const loaded = await this.previews.authenticate(
          passwordText,
          password => this.candidate.authenticate(password)
        );
        await this.requireAuthorized();
        return loaded;
      } catch (error) {
        await this.disposeIfRevoked();
        throw error;
      }
    });
  }

  list(): LoadedImportedAccountPreview[] {
    this.requireOpen();
    this.requireAuthorizedSynchronously();
    return this.previews.list();
  }

  remove(passwordId: LoadedImportedAccountPreview['passwordId']): boolean {
    this.requireOpen();
    this.requireAuthorizedSynchronously();
    if (this.installing) {
      throw new Error('Portable import is already installing');
    }
    if (this.installAttempted) {
      throw new Error('Portable import account set is frozen');
    }
    return this.previews.remove(passwordId);
  }

  install(): Promise<void> {
    this.requireOpen();
    if (this.installReserved) {
      return Promise.reject(new Error('Portable import is already installing'));
    }
    this.installAttempted = true;
    this.installReserved = true;
    const installation = this.enqueue(async () => {
      this.requireOpen();
      if (!this.authorizationValid()) {
        await this.revokeAndAbort();
        throw new Error('Portable import is not currently authorized');
      }
      if (this.previews.list().length === 0) {
        throw new Error('Load at least one account before importing');
      }
      this.installing = true;
      try {
        if (!this.gate.commitPrepared) {
          this.authorization.prepareCommit();
          this.gate.commitPrepared = true;
        }
        await this.candidate.install(async admit => {
          for (const preview of this.previews.list()) {
            await this.previews.usePassword(preview.passwordId, admit);
          }
        });
        try {
          if (!this.authorizationValid()) {
            throw new Error('Portable import authorization changed at commit');
          }
          this.authorization.commitSuccess();
          await this.authorization.release();
        } finally {
          // Physical installation is already terminal even if application-state
          // persistence unexpectedly reports an error.
          this.closed = true;
          this.gate.active = false;
          this.previews.dispose();
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === 'PortableImportTerminalError'
        ) {
          await this.revokeAndAbort();
        } else {
          await this.disposeIfRevoked();
        }
        throw error;
      } finally {
        this.installing = false;
      }
    });
    return installation.finally(() => {
      this.installReserved = false;
    });
  }

  async cancel(): Promise<void> {
    if (this.closed) return;
    if (this.installing) {
      throw new Error('Portable import cannot be cancelled while installing');
    }
    this.cancelRequested = true;
    this.gate.active = false;
    this.previews.dispose();
    await this.enqueue(async () => {
      if (this.closed) return;
      await this.candidate.abort();
      await this.authorization.release();
      this.closed = true;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private authorizationValid(): boolean {
    if (!this.gate.active) return false;
    if (this.gate.commitPrepared) return true;
    try {
      const authorized = this.authorization.isAuthorized();
      if (!authorized) this.gate.active = false;
      return authorized;
    } catch {
      this.gate.active = false;
      return false;
    }
  }

  private requireAuthorizedSynchronously(): void {
    if (this.authorizationValid() && !this.cancelRequested) return;
    this.cancelRequested = true;
    this.gate.active = false;
    this.previews.dispose();
    void this.candidate.abort().then(
      async () => {
        await this.authorization.release();
        this.closed = true;
      },
      () => {
        // cancel() remains available to retry cleanup.
      }
    );
    throw new Error('Portable import is not currently authorized');
  }

  private async requireAuthorized(): Promise<void> {
    if (this.authorizationValid() && !this.cancelRequested) return;
    await this.revokeAndAbort();
    throw new Error('Portable import is not currently authorized');
  }

  private async disposeIfRevoked(): Promise<void> {
    if (this.authorizationValid() && !this.cancelRequested) return;
    await this.revokeAndAbort();
  }

  private async revokeAndAbort(): Promise<void> {
    this.cancelRequested = true;
    this.gate.active = false;
    this.previews.dispose();
    try {
      await this.candidate.abort();
      await this.authorization.release();
      this.closed = true;
    } catch {
      // Keep the coordinator cleanup-capable. A later cancel() retries the
      // backend-owned spool cleanup while all application passwords stay wiped.
    }
  }

  private requireOpen(): void {
    if (this.closed || this.cancelRequested) {
      throw new Error('Portable import is closed');
    }
  }
}
