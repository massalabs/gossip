import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The radio service against a fake MeshCore companion radio: only the
 * Capacitor Bluetooth plugin is replaced. Frames are real companion protocol
 * frames, parsed by meshcore.js itself.
 */

const radio = vi.hoisted(() => ({
  notify: null as ((v: DataView) => void) | null,
  writes: [] as number[][],
  slots: [] as { name: string; secret: number[] }[],
  disconnects: 0,
}));

const sdk = vi.hoisted(() => ({
  received: [] as Uint8Array[],
  sendRadioText: vi.fn(async () => ({
    eventId: 'e',
    syncObjId: 's',
    merge: 'Won',
    datagram: new Uint8Array([0xaa, 0xbb, 0xcc]),
  })),
}));

function frame(bytes: number[]) {
  queueMicrotask(() =>
    radio.notify?.(new DataView(new Uint8Array(bytes).buffer))
  );
}

function cstring(s: string, size: number): number[] {
  const out = new Array<number>(size).fill(0);
  new TextEncoder().encode(s).forEach((b, i) => (out[i] = b));
  return out;
}

vi.mock('@capacitor-community/bluetooth-le', () => ({
  BleClient: {
    initialize: vi.fn(async () => undefined),
    requestDevice: vi.fn(async () => ({
      deviceId: 'dev-1',
      name: 'MeshCore-Test',
    })),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => {
      radio.disconnects += 1;
    }),
    startNotifications: vi.fn(
      async (_d: string, _s: string, _c: string, cb: (v: DataView) => void) => {
        radio.notify = cb;
      }
    ),
    write: vi.fn(async (_d: string, _s: string, _c: string, v: DataView) => {
      const bytes = [...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)];
      radio.writes.push(bytes);
      switch (bytes[0]) {
        case 0x16: // device query → device info
          frame([
            0x0d,
            14,
            175,
            radio.slots.length,
            0,
            0,
            0,
            0,
            ...cstring('15-Oct-2026', 12),
            ...cstring('Fake Board', 40),
            ...cstring('v1.18.0', 20),
            0,
            0,
          ]);
          break;
        case 0x1f: {
          // get channel
          const slot = radio.slots[bytes[1]];
          frame(
            slot
              ? [0x12, bytes[1], ...cstring(slot.name, 32), ...slot.secret]
              : [0x01, 2]
          );
          break;
        }
        case 0x20: // set channel
          radio.slots[bytes[1]] = {
            name: new TextDecoder()
              .decode(new Uint8Array(bytes.slice(2, 34)))
              .replace(/\0+$/, ''),
            secret: bytes.slice(34, 50),
          };
          frame([0x00]);
          break;
        case 0x3e: // channel datagram
          frame([0x00]);
          break;
        case 0x0a: // sync next message → none
          frame([0x0a]);
          break;
        default:
          frame([0x00]);
      }
    }),
  },
}));

vi.mock('../../src/stores/sdkStore', () => ({
  getSdk: () => ({
    groups: {
      receiveRadio: async (d: Uint8Array) => {
        sdk.received.push(d);
        return null;
      },
      sendRadioText: sdk.sendRadioText,
    },
  }),
}));

const account = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../../src/stores/accountStore', async () => {
  const { create: make } = await import('zustand');
  const store = make<{ userProfile: object | null }>(() => ({
    userProfile: { userId: 'u' },
  }));
  account.store = store;
  return { useAccountStore: store };
});

import {
  GOSSIP_CHANNEL_SECRET,
  GOSSIP_DATA_TYPE,
  connectRadio,
  disconnectRadio,
  sendRadioText,
  useRadioStore,
} from '../../src/services/meshcoreRadio';

const settle = () => new Promise(r => setTimeout(r, 20));

beforeEach(async () => {
  await disconnectRadio();
  radio.writes.length = 0;
  radio.disconnects = 0;
  sdk.received.length = 0;
  radio.slots = [
    { name: 'Public', secret: new Array(16).fill(7) },
    { name: '', secret: new Array(16).fill(0) },
    { name: '', secret: new Array(16).fill(0) },
  ];
});

describe('meshcoreRadio', () => {
  it('puts the Gossip channel in the first free slot and keeps the others', async () => {
    await connectRadio();
    expect(useRadioStore.getState()).toMatchObject({
      status: 'connected',
      deviceName: 'MeshCore-Test',
      channelIdx: 1,
    });
    expect(radio.slots[0].name).toBe('Public');
    expect(radio.slots[1]).toEqual({
      name: 'gossip',
      secret: [...GOSSIP_CHANNEL_SECRET],
    });

    // Reconnecting finds it again instead of taking another slot.
    await disconnectRadio();
    await connectRadio();
    expect(useRadioStore.getState().channelIdx).toBe(1);
    expect(radio.slots[2].name).toBe('');
  });

  it('floods a group datagram on the Gossip channel with the Gossip data type', async () => {
    await connectRadio();
    radio.writes.length = 0;
    await sendRadioText('group-1', 'hello');
    expect(sdk.sendRadioText).toHaveBeenCalledWith('group-1', 'hello');
    expect(radio.writes).toContainEqual([
      0x3e,
      1,
      0xff,
      GOSSIP_DATA_TYPE & 0xff,
      GOSSIP_DATA_TYPE >> 8,
      0xaa,
      0xbb,
      0xcc,
    ]);
  });

  it('hands Gossip datagrams of its channel to the groups, and nothing else', async () => {
    await connectRadio();
    const recv = (channel: number, type: number, data: number[]) =>
      frame([
        0x1b,
        0,
        0,
        0,
        channel,
        0,
        type & 0xff,
        type >> 8,
        data.length,
        ...data,
      ]);
    recv(1, GOSSIP_DATA_TYPE, [1, 2, 3]);
    recv(0, GOSSIP_DATA_TYPE, [4]); // another channel
    recv(1, 0x0100, [5]); // another application
    await settle();
    expect(sdk.received.map(d => [...d])).toEqual([[1, 2, 3]]);
  });

  it('disconnects when the account locks', async () => {
    await connectRadio();
    const store = account.store as { setState: (s: object) => void };
    store.setState({ userProfile: null });
    await settle();
    expect(useRadioStore.getState().status).toBe('disconnected');
    expect(radio.disconnects).toBeGreaterThan(0);
  });

  it('refuses to send without a radio', async () => {
    await expect(sendRadioText('group-1', 'x')).rejects.toThrow(
      'radio:not-connected'
    );
  });
});
