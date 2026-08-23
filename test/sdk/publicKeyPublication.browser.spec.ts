import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GossipSdk, SdkEventType, SdkStatus } from '@massalabs/gossip-sdk';
import { AuthService } from '../../gossip-sdk/src/services/auth';

describe('browser public-key reconnect publication', () => {
  let sdk: GossipSdk;
  let postPublicKey: ReturnType<typeof vi.fn>;
  let updatePublicKeyTimestamp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sdk = new GossipSdk();
    postPublicKey = vi.fn();
    updatePublicKeyTimestamp = vi.fn().mockResolvedValue(undefined);
    const auth = new AuthService({
      fetchPublicKeyByUserId: vi.fn(),
      postPublicKey,
    });
    const queries = {
      userProfiles: {
        getById: vi.fn().mockResolvedValue(null),
        updateById: updatePublicKeyTimestamp,
      },
    };
    const internals = sdk as unknown as {
      state: unknown;
      _auth: AuthService;
      _queries: unknown;
    };
    internals.state = {
      status: SdkStatus.SESSION_OPEN,
      messageProtocol: {},
      config: {},
      session: {
        ourPk: { to_bytes: () => new Uint8Array([1, 2, 3]) },
        userIdEncoded: 'gossip1browserpublication',
        dispose: vi.fn(),
      },
    };
    internals._auth = auth;
    internals._queries = queries;
  });

  afterEach(async () => {
    if (sdk.isSessionOpen) await sdk.closeSession();
  });

  it('retries timestamp persistence online without repeating a confirmed post', async () => {
    updatePublicKeyTimestamp.mockRejectedValueOnce(
      new Error('timestamp persistence failed')
    );
    const publicationFailed = new Promise<void>(resolve => {
      sdk.on(SdkEventType.ERROR, event => {
        if (event.context === 'publishPublicKey') resolve();
      });
    });

    sdk.startPublicKeyPublication();
    await publicationFailed;
    expect(postPublicKey).toHaveBeenCalledOnce();
    expect(updatePublicKeyTimestamp).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() =>
      expect(updatePublicKeyTimestamp).toHaveBeenCalledTimes(2)
    );
    expect(postPublicKey).toHaveBeenCalledOnce();
  });

  it('retries on online once and removes the listener on close', async () => {
    let resolveReconnect!: (value: string) => void;
    const reconnectPost = new Promise<string>(resolve => {
      resolveReconnect = resolve;
    });
    postPublicKey
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(reconnectPost);
    const publicationFailed = new Promise<void>(resolve => {
      sdk.on(SdkEventType.ERROR, event => {
        if (event.context === 'publishPublicKey') resolve();
      });
    });
    const removeListener = vi.spyOn(globalThis, 'removeEventListener');

    try {
      sdk.startPublicKeyPublication();
      await publicationFailed;
      expect(postPublicKey).toHaveBeenCalledOnce();

      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(postPublicKey).toHaveBeenCalledTimes(2));

      resolveReconnect('ok');
      await reconnectPost;
      await sdk.closeSession();
      expect(removeListener).toHaveBeenCalledWith(
        'online',
        expect.any(Function)
      );

      window.dispatchEvent(new Event('online'));
      await new Promise(resolve => requestAnimationFrame(resolve));
      expect(postPublicKey).toHaveBeenCalledTimes(2);
    } finally {
      resolveReconnect('ok');
      removeListener.mockRestore();
    }
  });
});
