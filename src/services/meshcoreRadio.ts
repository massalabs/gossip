import { create } from 'zustand';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { sha256 } from '@noble/hashes/sha256';
import Connection from '@liamcottle/meshcore.js/src/connection/connection.js';
import Constants from '@liamcottle/meshcore.js/src/constants.js';
import { SdkEventType } from '@massalabs/gossip-sdk';
import type {
  GroupChange,
  GroupRadioReceived,
  GroupRadioRelay,
} from '@massalabs/gossip-sdk';
import { getSdk } from '../stores/sdkStore';
import { useAccountStore } from '../stores/accountStore';
import { useGroupStore } from '../stores/groupStore';
import { logger } from '../utils/logger.ts';
import { RadioForwarder } from './radioForwarder';

/**
 * Group messages over a MeshCore companion radio, paired over Bluetooth.
 *
 * The companion protocol is MeshCore's own code (meshcore.js); this module
 * only gives it a Capacitor Bluetooth transport, keeps the Gossip channel on
 * the radio and passes datagrams between the radio and the group engine,
 * which does all of Gossip's encryption (see `groups::radio`).
 */

/** MeshCore `data_type` of Gossip datagrams: the development namespace until one is registered. */
export const GOSSIP_DATA_TYPE = 0xffff;
/** The MeshCore channel every Gossip radio shares. It carries Gossip ciphertext only. */
export const GOSSIP_CHANNEL_NAME = 'gossip';
export const GOSSIP_CHANNEL_SECRET = sha256(
  new TextEncoder().encode('#gossip-radio-1')
).slice(0, 16);
/** `path_len` for a flood send; 0 is zero-hop (no repeater carries it). */
const FLOOD = 0xff;
const ZERO_HOP = 0;
/** MeshCore boards have 1, 8 or 40 channel slots. */
const MAX_SLOTS = 64;

const SERVICE = Constants.Ble.ServiceUuid.toLowerCase();
const RX = Constants.Ble.CharacteristicUuidRx.toLowerCase();
const TX = Constants.Ble.CharacteristicUuidTx.toLowerCase();

/** meshcore.js over the Capacitor Bluetooth LE plugin (Android, iOS, and Web Bluetooth). */
class CapacitorBleConnection extends Connection {
  constructor(readonly deviceId: string) {
    super();
  }

  async init(): Promise<void> {
    await BleClient.connect(this.deviceId, () => this.onDisconnected());
    await BleClient.startNotifications(this.deviceId, SERVICE, TX, value => {
      this.onFrameReceived(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      );
    });
    await this.onConnected();
  }

  async sendToRadioFrame(data: Uint8Array): Promise<void> {
    await BleClient.write(
      this.deviceId,
      SERVICE,
      RX,
      new DataView(data.buffer, data.byteOffset, data.byteLength)
    );
  }

  async close(): Promise<void> {
    await BleClient.disconnect(this.deviceId);
  }
}

export type RadioStatus = 'disconnected' | 'connecting' | 'connected';

interface RadioState {
  status: RadioStatus;
  deviceName: string | null;
  channelIdx: number | null;
  error: string | null;
}

export const useRadioStore = create<RadioState>(() => ({
  status: 'disconnected',
  deviceName: null,
  channelIdx: null,
  error: null,
}));

let connection: CapacitorBleConnection | null = null;
/** Relays online messages for members who only have radio, while connected. */
let forwarder: RadioForwarder | null = null;
let stopForwarding: (() => void) | null = null;
/** Datagrams are handed to the engine one at a time, in arrival order. */
let incoming: Promise<unknown> = Promise.resolve();

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The slot holding the Gossip channel, set in the first empty slot if
 * missing. The owner's other channels are left alone.
 */
async function ensureGossipChannel(c: Connection): Promise<number> {
  let empty: number | null = null;
  for (let idx = 0; idx < MAX_SLOTS; idx++) {
    let info: { name: string; secret: Uint8Array };
    try {
      info = await c.getChannel(idx);
    } catch {
      break; // past the last slot
    }
    if (
      info.name === GOSSIP_CHANNEL_NAME &&
      equal(info.secret, GOSSIP_CHANNEL_SECRET)
    ) {
      return idx;
    }
    if (empty === null && info.name === '' && info.secret.every(b => b === 0)) {
      empty = idx;
    }
  }
  if (empty === null) throw new Error('radio:no-free-channel');
  await c.setChannel(empty, GOSSIP_CHANNEL_NAME, GOSSIP_CHANNEL_SECRET);
  return empty;
}

/** Hops a datagram took: `0xFF` is a direct (zero-hop) send. */
export function hopsOf(pathLen: number): number {
  return pathLen === 0xff ? 0 : pathLen & 63;
}

function onDatagram(raw: unknown): void {
  const d = raw as {
    channelIdx: number;
    dataType: number;
    data: Uint8Array;
    snr?: number;
    pathLen?: number;
  };
  const { channelIdx } = useRadioStore.getState();
  if (d.channelIdx !== channelIdx || d.dataType !== GOSSIP_DATA_TYPE) return;
  const data = new Uint8Array(d.data);
  const snr = d.snr ?? 0;
  const hops = hopsOf(d.pathLen ?? 0);
  incoming = incoming
    .then(() => getSdk().groups.receiveRadio(data))
    .then((r: GroupRadioReceived | GroupRadioRelay | null) => {
      if (!r) return;
      forwarder?.heardOnRadio(r, snr, hops);
      if (r.kind === 'message' && r.accepted) {
        logger.info('[radio] group message received');
      }
    })
    .catch(error => logger.error('[radio] receive failed:', error));
}

/**
 * This account sent a message online: the engine reports no change for its
 * own messages, so the relay rules are applied here (the author's device
 * relays first).
 */
export function radioMessageSent(groupId: string): void {
  void forwarder
    ?.groupChanged(groupId)
    .catch(error => logger.error('[radio] relay failed:', error));
}

/** Starts relaying online messages of the groups for radio-only members. */
function startForwarding(c: Connection, channelIdx: number): void {
  const sdk = getSdk();
  const f = new RadioForwarder({
    groups: sdk.groups,
    me: sdk.userId,
    memberCount: groupId =>
      useGroupStore.getState().groups.find(g => g.summary.groupId === groupId)
        ?.summary.members.length ?? Number.MAX_SAFE_INTEGER,
    send: async (datagram, zeroHop) => {
      await c.sendChannelData(
        channelIdx,
        zeroHop ? ZERO_HOP : FLOOD,
        new Uint8Array(0),
        GOSSIP_DATA_TYPE,
        datagram
      );
    },
  });
  const onChanged = ({ changes }: { changes: GroupChange[] }) => {
    for (const change of changes) {
      if (change.kind === 'Messages') {
        void f
          .groupChanged(change.groupId)
          .catch(error => logger.error('[radio] relay failed:', error));
      }
    }
  };
  sdk.on(SdkEventType.GROUPS_CHANGED, onChanged);
  forwarder = f;
  stopForwarding = () => {
    f.stop();
    try {
      sdk.off(SdkEventType.GROUPS_CHANGED, onChanged);
    } catch {
      // The SDK may already be gone.
    }
  };
}

function drain(): void {
  void connection
    ?.getWaitingMessages()
    .catch(error => logger.error('[radio] sync failed:', error));
}

/**
 * Asks the user to pick a MeshCore radio, connects to it and makes sure it
 * holds the Gossip channel. Datagrams it hears from then on go to the groups.
 */
export async function connectRadio(): Promise<void> {
  if (useRadioStore.getState().status !== 'disconnected') return;
  useRadioStore.setState({ status: 'connecting', error: null });
  try {
    await BleClient.initialize({ androidNeverForLocation: true });
    // With Bluetooth off the device picker would scan forever and find nothing.
    if (!(await BleClient.isEnabled())) {
      // Android asks the user; elsewhere this is not supported.
      await BleClient.requestEnable().catch(() => undefined);
      if (!(await BleClient.isEnabled()))
        throw new Error('radio:bluetooth-off');
    }
    const device = await BleClient.requestDevice({ services: [SERVICE] });
    const c = new CapacitorBleConnection(device.deviceId);
    c.on('disconnected', () => {
      if (connection === c) {
        connection = null;
        stopForwarding?.();
        stopForwarding = null;
        forwarder = null;
        useRadioStore.setState({
          status: 'disconnected',
          deviceName: null,
          channelIdx: null,
        });
      }
    });
    connection = c;
    await c.init();
    const channelIdx = await ensureGossipChannel(c);
    c.on(Constants.ResponseCodes.ChannelDataRecv, onDatagram);
    c.on(Constants.PushCodes.MsgWaiting, drain);
    startForwarding(c, channelIdx);
    useRadioStore.setState({
      status: 'connected',
      deviceName: device.name ?? device.deviceId,
      channelIdx,
    });
    drain();
  } catch (error) {
    logger.error('[radio] connect failed:', error);
    await disconnectRadio();
    useRadioStore.setState({
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function disconnectRadio(): Promise<void> {
  const c = connection;
  connection = null;
  stopForwarding?.();
  stopForwarding = null;
  forwarder = null;
  useRadioStore.setState({
    status: 'disconnected',
    deviceName: null,
    channelIdx: null,
  });
  if (c) await c.close().catch(() => undefined);
}

/**
 * Sends a text message to a group by radio. The message is also published
 * online by the group engine, as the same event.
 */
export async function sendRadioText(groupId: string, text: string) {
  const c = connection;
  const { channelIdx } = useRadioStore.getState();
  if (!c || channelIdx === null) throw new Error('radio:not-connected');
  const sent = await getSdk().groups.sendRadioText(groupId, text);
  await c.sendChannelData(
    channelIdx,
    FLOOD,
    new Uint8Array(0),
    GOSSIP_DATA_TYPE,
    sent.datagram
  );
  return sent;
}

// Locking closes the radio link: nothing of an account stays reachable.
useAccountStore.subscribe((state, previous) => {
  if (previous.userProfile && !state.userProfile) void disconnectRadio();
});
