import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeUserId,
  generateUserKeys,
  type UserPublicKeys,
} from '@massalabs/gossip-sdk';

/**
 * A fake ContactExchange plugin that wires the scanner's `exchange` to the
 * presenter's `request` listener in memory, like two phones over Bluetooth.
 */
const fake = vi.hoisted(() => {
  type RequestHandler = (event: { requestId: number; data: string }) => void;
  type SentHandler = (event: { requestId: number }) => void;
  const state = {
    permission: 'granted' as 'granted' | 'denied' | 'prompt',
    presenting: null as null | { serviceUuid: string },
    onRequest: null as RequestHandler | null,
    onSent: null as SentHandler | null,
    pending: new Map<number, (data: string) => void>(),
    nextId: 1,
    /** Lets a test tamper with the presenter's answer. */
    tamper: (data: string) => data,
  };
  const plugin = {
    checkBluetooth: vi.fn(async () => ({ state: state.permission })),
    requestBluetooth: vi.fn(async () => ({ state: state.permission })),
    startPresenting: vi.fn(async (options: { serviceUuid: string }) => {
      state.presenting = { serviceUuid: options.serviceUuid };
    }),
    stopPresenting: vi.fn(async () => {
      state.presenting = null;
    }),
    respond: vi.fn(async ({ requestId, data }) => {
      const resolve = state.pending.get(requestId);
      if (!resolve) throw new Error('NOT_FOUND');
      state.pending.delete(requestId);
      resolve(state.tamper(data));
      state.onSent?.({ requestId });
    }),
    exchange: vi.fn(
      async (options: { serviceUuid: string; request: string }) =>
        new Promise<{ response: string }>((resolve, reject) => {
          if (
            !state.presenting ||
            state.presenting.serviceUuid !== options.serviceUuid ||
            !state.onRequest
          ) {
            reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' }));
            return;
          }
          const requestId = state.nextId++;
          state.pending.set(requestId, response => resolve({ response }));
          state.onRequest({ requestId, data: options.request });
          // No answer (malformed request): the native side times out.
          setTimeout(() => {
            if (state.pending.delete(requestId)) {
              reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' }));
            }
          }, 50);
        })
    ),
    cancelExchange: vi.fn(async () => undefined),
    addListener: vi.fn(
      async (event: string, handler: RequestHandler | SentHandler) => {
        if (event === 'request') state.onRequest = handler as RequestHandler;
        if (event === 'sent') state.onSent = handler as SentHandler;
        return {
          remove: async () => {
            if (event === 'request') state.onRequest = null;
            if (event === 'sent') state.onSent = null;
          },
        };
      }
    ),
  };
  return { state, plugin };
});

vi.mock('@capacitor/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => fake.plugin,
}));

import {
  ContactCodeSession,
  checkBluetoothPermission,
  fetchContactOverBluetooth,
} from '../../src/services/contactExchange';
import {
  ContactCodeDecoder,
  parseContactFrame,
  verifyContactPayload,
} from '../../src/utils/contactExchange';

describe('contact exchange service', () => {
  let keys: UserPublicKeys;
  let otherKeys: UserPublicKeys;
  let userId: string;

  beforeAll(async () => {
    keys = (await generateUserKeys('contact-exchange-service-a')).public_keys();
    otherKeys = (
      await generateUserKeys('contact-exchange-service-b')
    ).public_keys();
    userId = encodeUserId(keys.derive_id());
  });

  beforeEach(() => {
    fake.state.permission = 'granted';
    fake.state.presenting = null;
    fake.state.tamper = data => data;
    vi.clearAllMocks();
  });

  it('reads the keys from the animated frames alone', async () => {
    const session = new ContactCodeSession(userId, keys.to_bytes(), 'Alice');
    const decoder = new ContactCodeDecoder();
    let contact = null;
    for (const frame of session.frames()) {
      const result = decoder.receive(frame);
      if (result.kind === 'complete') {
        contact = verifyContactPayload(result.payload);
        break;
      }
    }
    expect(contact?.userId).toBe(userId);
    expect(contact?.name).toBe('Alice');
    await session.stop();
  });

  it('gets the keys over Bluetooth from one frame', async () => {
    const session = new ContactCodeSession(userId, keys.to_bytes(), 'Alice');
    const onShared = vi.fn();
    await session.startBluetooth({ onShared, onStopped: vi.fn() });
    expect(session.isPresenting).toBe(true);

    // The scanner only read the simple (header-only) frame.
    const frame = parseContactFrame(session.simpleFrame());
    const contact = await fetchContactOverBluetooth(frame!.header);
    expect(contact?.userId).toBe(userId);
    expect(contact?.name).toBe('Alice');
    expect(contact?.publicKeys.to_bytes()).toEqual(keys.to_bytes());
    expect(onShared).toHaveBeenCalledTimes(1);

    await session.stop();
    expect(fake.plugin.stopPresenting).toHaveBeenCalled();
    expect(session.isStopped).toBe(true);
  });

  it('never sends the keys in the clear', async () => {
    const session = new ContactCodeSession(userId, keys.to_bytes());
    await session.startBluetooth({ onShared: vi.fn(), onStopped: vi.fn() });
    const frame = parseContactFrame(session.simpleFrame())!;
    await fetchContactOverBluetooth(frame.header);
    const response = fake.plugin.respond.mock.calls[0][0].data as string;
    const bytes = Uint8Array.from(atob(response), c => c.charCodeAt(0));
    const keyBytes = keys.to_bytes();
    const needle = Array.from(keyBytes.slice(100, 132)).join(',');
    expect(Array.from(bytes).join(',')).not.toContain(needle);
    await session.stop();
  });

  it('rejects a tampered answer', async () => {
    const session = new ContactCodeSession(userId, keys.to_bytes());
    await session.startBluetooth({ onShared: vi.fn(), onStopped: vi.fn() });
    fake.state.tamper = data => {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      bytes[bytes.length - 1] ^= 1;
      return btoa(String.fromCharCode(...bytes));
    };
    const frame = parseContactFrame(session.simpleFrame())!;
    expect(await fetchContactOverBluetooth(frame.header)).toBe(null);
    await session.stop();
  });

  it('rejects keys that do not match the user id of the code', async () => {
    // A presenter serving someone else's keys under this user id
    const session = new ContactCodeSession(userId, otherKeys.to_bytes());
    await session.startBluetooth({ onShared: vi.fn(), onStopped: vi.fn() });
    const frame = parseContactFrame(session.simpleFrame())!;
    expect(await fetchContactOverBluetooth(frame.header)).toBe(null);
    await session.stop();
  });

  it('does not answer another code', async () => {
    const session = new ContactCodeSession(userId, keys.to_bytes());
    const other = new ContactCodeSession(userId, keys.to_bytes());
    await session.startBluetooth({ onShared: vi.fn(), onStopped: vi.fn() });
    const frame = parseContactFrame(other.simpleFrame())!;
    expect(await fetchContactOverBluetooth(frame.header)).toBe(null);
    await session.stop();
    await other.stop();
  });

  it('stops answering after stop()', async () => {
    const session = new ContactCodeSession(userId, keys.to_bytes());
    await session.startBluetooth({ onShared: vi.fn(), onStopped: vi.fn() });
    const frame = parseContactFrame(session.simpleFrame())!;
    await session.stop();
    expect(await fetchContactOverBluetooth(frame.header)).toBe(null);
    // a stopped code cannot start again: its ephemeral key is gone
    await session.startBluetooth({ onShared: vi.fn(), onStopped: vi.fn() });
    expect(session.isPresenting).toBe(false);
  });

  it('stops Bluetooth after the time limit', async () => {
    vi.useFakeTimers();
    try {
      const session = new ContactCodeSession(userId, keys.to_bytes());
      const onStopped = vi.fn();
      await session.startBluetooth({ onShared: vi.fn(), onStopped });
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(onStopped).toHaveBeenCalled();
      expect(session.isPresenting).toBe(false);
      expect(fake.plugin.stopPresenting).toHaveBeenCalled();
      await session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the permission state', async () => {
    fake.state.permission = 'prompt';
    expect(await checkBluetoothPermission()).toBe('prompt');
  });
});
