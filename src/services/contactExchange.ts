import { Capacitor, registerPlugin } from '@capacitor/core';
import { decodeUserId } from '@massalabs/gossip-sdk';
import { logger } from '../utils/logger.ts';
import {
  type ContactCodeHeader,
  type ContactPayload,
  type EphemeralKeyPair,
  type VerifiedContact,
  createRequest,
  decodePayload,
  encodeContactFrames,
  generateEphemeralKeyPair,
  generateRendezvousId,
  headerOnlyFrame,
  openResponse,
  rendezvousUuids,
  sameHeader,
  sealResponse,
  verifyContactPayload,
  encodePayload,
} from '../utils/contactExchange';

export type BluetoothPermission = 'granted' | 'denied' | 'prompt';

/**
 * Native Bluetooth half of the in-person contact exchange
 * (Android `net.massa.gossip.exchange`, iOS `plugins/contactExchange`),
 * separate from the mesh node. Binary values cross the bridge as base64.
 * The native side only moves bytes; the crypto is in `utils/contactExchange`.
 */
interface ContactExchangePlugin {
  checkBluetooth(): Promise<{ state: BluetoothPermission }>;
  requestBluetooth(): Promise<{ state: BluetoothPermission }>;
  /** Advertises `serviceUuid` and serves the exchange characteristic. */
  startPresenting(options: {
    serviceUuid: string;
    characteristicUuid: string;
    timeoutMs: number;
  }): Promise<void>;
  /** Answers a `request` event; the native side chunks and notifies it. */
  respond(options: { requestId: number; data: string }): Promise<void>;
  stopPresenting(): Promise<void>;
  /** Finds the presenter, writes `request`, resolves with its whole answer. */
  exchange(options: {
    serviceUuid: string;
    characteristicUuid: string;
    request: string;
    timeoutMs: number;
  }): Promise<{ response: string }>;
  cancelExchange(): Promise<void>;
  addListener(
    event: 'request',
    handler: (event: { requestId: number; data: string }) => void
  ): Promise<{ remove(): Promise<void> }>;
  addListener(
    event: 'sent',
    handler: (event: { requestId: number }) => void
  ): Promise<{ remove(): Promise<void> }>;
}

export const ContactExchange =
  registerPlugin<ContactExchangePlugin>('ContactExchange');

/** How long the presenter advertises at most, from when the code appears. */
export const PRESENT_TIMEOUT_MS = 2 * 60 * 1000;
/** How long one scanner attempt may take: finding, connecting and reading. */
export const EXCHANGE_TIMEOUT_MS = 25 * 1000;
/** Answers one code gives over Bluetooth before it stops answering. */
const MAX_RESPONSES = 16;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function isBluetoothExchangeSupported(): boolean {
  return Capacitor.isNativePlatform();
}

export async function checkBluetoothPermission(): Promise<BluetoothPermission> {
  if (!isBluetoothExchangeSupported()) return 'denied';
  try {
    return (await ContactExchange.checkBluetooth()).state;
  } catch {
    return 'denied';
  }
}

export async function requestBluetoothPermission(): Promise<BluetoothPermission> {
  if (!isBluetoothExchangeSupported()) return 'denied';
  try {
    return (await ContactExchange.requestBluetooth()).state;
  } catch {
    return 'denied';
  }
}

/**
 * One contact code on screen: a fresh ephemeral X25519 key and rendezvous id,
 * the QR frames, and the Bluetooth presenter while it runs. Dropping the
 * session (`stop`) discards the ephemeral key; nothing is stored.
 */
export class ContactCodeSession {
  readonly header: ContactCodeHeader;
  private keyPair: EphemeralKeyPair | null;
  private contact: ContactPayload;
  private payload: Uint8Array;
  private listeners: { remove(): Promise<void> }[] = [];
  private responses = 0;
  private presenting = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(userId: string, publicKeys: Uint8Array, name?: string) {
    this.keyPair = generateEphemeralKeyPair();
    this.header = {
      userId: decodeUserId(userId),
      ephemeralKey: this.keyPair.publicKey,
      rendezvousId: generateRendezvousId(),
    };
    this.contact = { header: this.header, name, publicKeys };
    this.payload = encodePayload(this.contact);
  }

  /** The animated code, shown in a loop. */
  frames(): string[] {
    return encodeContactFrames(this.contact);
  }

  /** One small frame with the header only: Bluetooth does the rest. */
  simpleFrame(): string {
    return headerOnlyFrame(this.header);
  }

  get isPresenting(): boolean {
    return this.presenting;
  }

  /** `stop()` was called: the ephemeral key is gone. */
  get isStopped(): boolean {
    return this.keyPair === null;
  }

  /**
   * Starts advertising this code's rendezvous id. `onShared` runs each time a
   * phone got the keys; `onStopped` when Bluetooth stops on its own (timeout).
   * Throws when Bluetooth cannot be used (off, not allowed, unsupported).
   */
  async startBluetooth(handlers: {
    onShared: () => void;
    onStopped: () => void;
  }): Promise<void> {
    if (this.presenting || !this.keyPair) return;
    const keyPair = this.keyPair;
    const { serviceUuid, characteristicUuid } = rendezvousUuids(
      this.header.rendezvousId
    );
    this.presenting = true;
    this.listeners.push(
      await ContactExchange.addListener('request', event =>
        this.answer(event.requestId, event.data)
      ),
      await ContactExchange.addListener('sent', () => handlers.onShared())
    );
    try {
      await ContactExchange.startPresenting({
        serviceUuid,
        characteristicUuid,
        timeoutMs: PRESENT_TIMEOUT_MS,
      });
    } catch (error) {
      await this.stopBluetooth();
      throw error;
    }
    // stop() ran while advertising started: undo it.
    if (this.keyPair !== keyPair) {
      this.presenting = false;
      await ContactExchange.stopPresenting().catch(() => undefined);
      return;
    }
    this.timer = setTimeout(() => {
      void this.stopBluetooth().then(handlers.onStopped);
    }, PRESENT_TIMEOUT_MS);
  }

  private answer(requestId: number, data: string): void {
    if (!this.presenting || !this.keyPair) return;
    if (++this.responses > MAX_RESPONSES) return;
    let request: Uint8Array;
    try {
      request = fromBase64(data);
    } catch {
      return;
    }
    const response = sealResponse(
      this.keyPair.secretKey,
      this.header,
      request,
      this.payload
    );
    // A malformed request gets no answer: the native side times it out.
    if (!response) return;
    ContactExchange.respond({ requestId, data: toBase64(response) }).catch(
      error => logger.warn('[ContactExchange] respond failed', error)
    );
  }

  async stopBluetooth(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const listeners = this.listeners;
    this.listeners = [];
    await Promise.all(listeners.map(l => l.remove().catch(() => undefined)));
    if (!this.presenting) return;
    this.presenting = false;
    await ContactExchange.stopPresenting().catch(() => undefined);
  }

  /** Stops Bluetooth and forgets the ephemeral key. */
  async stop(): Promise<void> {
    await this.stopBluetooth();
    this.keyPair?.secretKey.fill(0);
    this.keyPair = null;
  }
}

/**
 * Scanner side: connects to the presenter of `header` and reads its keys.
 * Resolves with the verified contact, or null when nothing valid came back
 * (not found, timeout, bad answer, keys of another user id).
 */
export async function fetchContactOverBluetooth(
  header: ContactCodeHeader
): Promise<VerifiedContact | null> {
  const { serviceUuid, characteristicUuid } = rendezvousUuids(
    header.rendezvousId
  );
  const { request, keyPair } = createRequest();
  try {
    const { response } = await ContactExchange.exchange({
      serviceUuid,
      characteristicUuid,
      request: toBase64(request),
      timeoutMs: EXCHANGE_TIMEOUT_MS,
    });
    const plain = openResponse(keyPair, header, fromBase64(response));
    if (!plain) return null;
    const payload = decodePayload(plain);
    if (!payload || !sameHeader(payload.header, header)) return null;
    return verifyContactPayload(payload);
  } catch (error) {
    logger.warn('[ContactExchange] bluetooth exchange failed', error);
    return null;
  } finally {
    keyPair.secretKey.fill(0);
  }
}

export async function cancelBluetoothExchange(): Promise<void> {
  if (!isBluetoothExchangeSupported()) return;
  await ContactExchange.cancelExchange().catch(() => undefined);
}
