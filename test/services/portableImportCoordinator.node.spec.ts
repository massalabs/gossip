import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GossipSdk, PortableImportCandidate } from '@massalabs/gossip-sdk';
import { PortableImportCoordinator } from '../../src/services/portableImportCoordinator';

const preview = {
  userId: 'gossip1ywzkutgadznd0509tsl4gs4xjvsudhzgjuxc46ytngvq0lacx5es2xyz5s',
  username: 'Alice',
  avatar: null,
  createdAtMs: 1234,
};

function harness() {
  let authorized = true;
  const commitSuccess = vi.fn();
  const borrowed: Uint8Array[] = [];
  const candidate: PortableImportCandidate = {
    push: vi.fn().mockResolvedValue(undefined),
    finishValidation: vi.fn().mockResolvedValue(undefined),
    authenticate: vi.fn().mockResolvedValue(preview),
    install: vi.fn(async admitPasswords => {
      await admitPasswords(async password => {
        borrowed.push(password);
      });
    }),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  const sdk = {
    beginPortableImport: vi.fn().mockResolvedValue(candidate),
  } as unknown as GossipSdk;
  const authorization = {
    isAuthorized: () => authorized,
    commitSuccess,
  };
  return {
    sdk,
    candidate,
    authorization,
    commitSuccess,
    borrowed,
    revoke: () => {
      authorized = false;
    },
  };
}

describe('PortableImportCoordinator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('streams, previews, installs through opaque handles, and wipes passwords', async () => {
    const h = harness();
    const coordinator = await PortableImportCoordinator.begin(
      h.sdk,
      h.authorization
    );
    const chunk = new Uint8Array([1, 2, 3]);
    await coordinator.push(chunk);
    await coordinator.finishValidation();
    const loaded = await coordinator.authenticate('secret-password');

    expect(coordinator.list()).toEqual([loaded]);
    await coordinator.install();
    expect(h.candidate.push).toHaveBeenCalledWith(chunk);
    expect(h.candidate.authenticate).toHaveBeenCalledOnce();
    expect(h.commitSuccess).toHaveBeenCalledOnce();
    expect(h.borrowed).toHaveLength(1);
    expect(Array.from(h.borrowed[0])).toEqual(
      new Array('secret-password'.length).fill(0)
    );
    expect(() => coordinator.list()).toThrow('closed');
  });

  it('retains accepted passwords for a retryable pre-commit failure', async () => {
    const h = harness();
    const installError = new Error('commit failed');
    vi.mocked(h.candidate.install)
      .mockImplementationOnce(async admitPasswords => {
        await admitPasswords(async password => {
          h.borrowed.push(password);
        });
        throw installError;
      })
      .mockImplementationOnce(async admitPasswords => {
        await admitPasswords(async password => {
          h.borrowed.push(password);
        });
      });
    const coordinator = await PortableImportCoordinator.begin(
      h.sdk,
      h.authorization
    );
    await coordinator.authenticate('retry-password');

    await expect(coordinator.install()).rejects.toBe(installError);
    expect(coordinator.list()).toHaveLength(1);
    expect(Array.from(h.borrowed[0])).not.toEqual(
      new Array('retry-password'.length).fill(0)
    );
    await coordinator.install();
    expect(Array.from(h.borrowed[0])).toEqual(
      new Array('retry-password'.length).fill(0)
    );
    expect(Array.from(h.borrowed[1])).toEqual(
      new Array('retry-password'.length).fill(0)
    );
  });

  it('waits for authentication ownership before installation begins', async () => {
    const h = harness();
    let release: ((value: typeof preview) => void) | undefined;
    vi.mocked(h.candidate.authenticate).mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    );
    const coordinator = await PortableImportCoordinator.begin(
      h.sdk,
      h.authorization
    );

    const authenticating = coordinator.authenticate('ordered-password');
    const installing = coordinator.install();
    await expect(coordinator.install()).rejects.toThrow('already installing');
    await vi.waitFor(() =>
      expect(h.candidate.authenticate).toHaveBeenCalledOnce()
    );
    expect(h.candidate.install).not.toHaveBeenCalled();
    release?.(preview);
    await authenticating;
    await installing;
    expect(h.borrowed).toHaveLength(1);
    expect(Array.from(h.borrowed[0])).toEqual(
      new Array('ordered-password'.length).fill(0)
    );
  });

  it('rejects cancellation once terminal installation is in flight', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    vi.mocked(h.candidate.install).mockImplementation(async admitPasswords => {
      await admitPasswords(async password => {
        h.borrowed.push(password);
      });
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    const coordinator = await PortableImportCoordinator.begin(
      h.sdk,
      h.authorization
    );
    await coordinator.authenticate('terminal-password');
    const installing = coordinator.install();
    await vi.waitFor(() => expect(h.candidate.install).toHaveBeenCalledOnce());

    await expect(coordinator.install()).rejects.toThrow('already installing');
    await expect(coordinator.cancel()).rejects.toThrow(
      'cannot be cancelled while installing'
    );
    release?.();
    await installing;
    expect(h.commitSuccess).toHaveBeenCalledOnce();
  });

  it('retries backend cleanup after revoked authorization', async () => {
    const h = harness();
    vi.mocked(h.candidate.abort)
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValueOnce(undefined);
    const coordinator = await PortableImportCoordinator.begin(
      h.sdk,
      h.authorization
    );
    await coordinator.authenticate('cleanup-password');
    h.revoke();

    await expect(coordinator.authenticate('other-password')).rejects.toThrow(
      'not currently authorized'
    );
    expect(h.candidate.abort).toHaveBeenCalledTimes(1);
    await coordinator.cancel();
    expect(h.candidate.abort).toHaveBeenCalledTimes(2);
  });

  it('does not commit success metadata after terminal authorization changes', async () => {
    const h = harness();
    vi.mocked(h.candidate.install).mockImplementation(async admitPasswords => {
      await admitPasswords(async password => {
        h.borrowed.push(password);
      });
      h.revoke();
    });
    const coordinator = await PortableImportCoordinator.begin(
      h.sdk,
      h.authorization
    );
    await coordinator.authenticate('commit-race-password');

    await expect(coordinator.install()).rejects.toThrow(
      'authorization changed at commit'
    );
    expect(h.commitSuccess).not.toHaveBeenCalled();
    expect(Array.from(h.borrowed[0])).toEqual(
      new Array('commit-race-password'.length).fill(0)
    );
    expect(() => coordinator.list()).toThrow('closed');
  });

  it('wipes and closes on terminal password-admission failure', async () => {
    const h = harness();
    let borrowed: Uint8Array | null = null;
    vi.mocked(h.candidate.authenticate).mockImplementation(async password => {
      borrowed = password;
      return preview;
    });
    const terminalError = new Error('admission failed');
    terminalError.name = 'PortableImportTerminalError';
    vi.mocked(h.candidate.install).mockRejectedValue(terminalError);
    const coordinator = await PortableImportCoordinator.begin(
      h.sdk,
      h.authorization
    );
    await coordinator.authenticate('terminal-failure');

    await expect(coordinator.install()).rejects.toBe(terminalError);
    expect(h.candidate.abort).toHaveBeenCalledOnce();
    expect(Array.from(borrowed!)).toEqual(
      new Array('terminal-failure'.length).fill(0)
    );
    expect(() => coordinator.list()).toThrow('closed');
  });

  it('synchronously hides previews when authorization is revoked', async () => {
    const h = harness();
    let borrowed: Uint8Array | null = null;
    vi.mocked(h.candidate.authenticate).mockImplementation(async password => {
      borrowed = password;
      return preview;
    });
    const coordinator = await PortableImportCoordinator.begin(
      h.sdk,
      h.authorization
    );
    await coordinator.authenticate('hidden-password');
    h.revoke();

    expect(() => coordinator.list()).toThrow('not currently authorized');
    expect(Array.from(borrowed!)).toEqual(
      new Array('hidden-password'.length).fill(0)
    );
    expect(h.candidate.abort).toHaveBeenCalledOnce();
  });

  it('aborts and wipes when authorization is revoked', async () => {
    const h = harness();
    const coordinator = await PortableImportCoordinator.begin(
      h.sdk,
      h.authorization
    );
    await coordinator.authenticate('cancel-password');
    let borrowed: Uint8Array | null = null;
    vi.mocked(h.candidate.authenticate).mockImplementation(async password => {
      borrowed = password;
      return preview;
    });
    // Borrow the retained bytes once so the test can observe their backing
    // buffer after cancellation without exposing them through production API.
    coordinator.remove(coordinator.list()[0].passwordId);
    const reloaded = await coordinator.authenticate('cancel-password');
    expect(reloaded.username).toBe('Alice');
    h.revoke();

    await expect(coordinator.install()).rejects.toThrow(
      'not currently authorized'
    );
    expect(h.candidate.abort).toHaveBeenCalledOnce();
    expect(borrowed).not.toBeNull();
    expect(Array.from(borrowed!)).toEqual(
      new Array('cancel-password'.length).fill(0)
    );
  });
});
