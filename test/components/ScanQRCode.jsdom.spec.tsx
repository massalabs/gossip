import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  encodeUserId,
  generateUserKeys,
  UserPublicKeys,
} from '@massalabs/gossip-sdk';
import type { QRScannerProps } from '../../src/components/qr/types';

const mocks = vi.hoisted(() => ({
  scanner: null as QRScannerProps | null,
  permission: 'granted' as 'granted' | 'prompt' | 'denied',
  requested: 'granted' as 'granted' | 'prompt' | 'denied',
  fetchContact: vi.fn(),
  cancel: vi.fn(async () => undefined),
  request: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-hot-toast', () => ({
  default: { error: mocks.toastError },
}));
vi.mock('@capacitor/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@capacitor/core')>()),
  Capacitor: { isNativePlatform: () => true },
}));
vi.mock('@capacitor-community/privacy-screen', () => ({
  PrivacyScreen: {
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
  },
}));
vi.mock('../../src/components/qr/NativeQRScanner', () => ({
  default: (props: QRScannerProps) => {
    mocks.scanner = props;
    return null;
  },
}));
vi.mock('../../src/services/contactExchange', () => ({
  isBluetoothExchangeSupported: () => true,
  checkBluetoothPermission: async () => mocks.permission,
  requestBluetoothPermission: async () => {
    mocks.request();
    return mocks.requested;
  },
  fetchContactOverBluetooth: mocks.fetchContact,
  cancelBluetoothExchange: mocks.cancel,
}));

import ScanQRCode from '../../src/components/settings/ScanQRCode';
import {
  encodeContactFrames,
  generateEphemeralKeyPair,
  generateRendezvousId,
  headerOnlyFrame,
  type ContactCodeHeader,
} from '../../src/utils/contactExchange';

describe('ScanQRCode', () => {
  let keys: UserPublicKeys;
  let otherKeys: UserPublicKeys;
  let header: ContactCodeHeader;
  let container: HTMLDivElement;
  let root: Root;
  const onScanSuccess = vi.fn();
  const onBack = vi.fn();

  beforeAll(async () => {
    // jsdom has no matchMedia; the Bluetooth-only screen's button reads it.
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    keys = (await generateUserKeys('scan-qr-code-a')).public_keys();
    otherKeys = (await generateUserKeys('scan-qr-code-b')).public_keys();
  });

  beforeEach(async () => {
    mocks.permission = 'granted';
    mocks.requested = 'granted';
    mocks.scanner = null;
    vi.clearAllMocks();
    mocks.fetchContact.mockImplementation(() => new Promise(() => {}));
    header = {
      userId: keys.derive_id(),
      ephemeralKey: generateEphemeralKeyPair().publicKey,
      rendezvousId: generateRendezvousId(),
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ScanQRCode onBack={onBack} onScanSuccess={onScanSuccess} />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  /** The scanner owns (and may free) the keys it is given: hand it a copy. */
  const copy = (k: UserPublicKeys) => UserPublicKeys.from_bytes(k.to_bytes());

  async function scan(text: string) {
    await act(async () => {
      mocks.scanner!.onScan(text);
    });
  }

  it('opens a continuous scanner', () => {
    expect(mocks.scanner?.continuous).toBe(true);
    expect(mocks.scanner?.status).toBe('contact_code.point_camera');
  });

  it('adds a contact from the animated frames, keys checked', async () => {
    mocks.permission = 'prompt';
    const frames = encodeContactFrames({
      header,
      name: 'Alice',
      publicKeys: keys.to_bytes(),
    });
    await scan(frames[2]);
    expect(mocks.scanner?.status).toContain('contact_code.reading');
    for (const frame of frames) await scan(frame);
    expect(onScanSuccess).toHaveBeenCalledTimes(1);
    const [userId, name, scannedKeys] = onScanSuccess.mock.calls[0];
    expect(userId).toBe(encodeUserId(keys.derive_id()));
    expect(name).toBe('Alice');
    expect(scannedKeys.to_bytes()).toEqual(keys.to_bytes());
    expect(mocks.scanner?.stopped).toBe(true);
    // Bluetooth not allowed yet: the animated code does not ask for it
    expect(mocks.fetchContact).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('starts Bluetooth on the first frame and takes its answer', async () => {
    let answer: (value: unknown) => void = () => {};
    mocks.fetchContact.mockImplementation(
      () => new Promise(resolve => (answer = resolve))
    );
    const frames = encodeContactFrames({ header, publicKeys: keys.to_bytes() });
    await scan(frames[5]);
    expect(mocks.fetchContact).toHaveBeenCalledTimes(1);
    expect(mocks.fetchContact.mock.calls[0][0].rendezvousId).toEqual(
      header.rendezvousId
    );
    expect(mocks.scanner?.status).toContain('contact_code.using_bluetooth');
    await act(async () =>
      answer({
        userId: encodeUserId(header.userId),
        publicKeys: copy(keys),
      })
    );
    expect(onScanSuccess).toHaveBeenCalledTimes(1);
    expect(onScanSuccess.mock.calls[0][0]).toBe(encodeUserId(header.userId));
    expect(onScanSuccess.mock.calls[0][2].to_bytes()).toEqual(keys.to_bytes());
    expect(mocks.scanner?.stopped).toBe(true);
    // the camera path is over: later frames do nothing
    for (const frame of frames) await scan(frame);
    expect(onScanSuccess).toHaveBeenCalledTimes(1);
  });

  it('keeps plain invite codes working', async () => {
    const userId = encodeUserId(header.userId);
    await scan(`https://gossip.app/invite/${userId}?name=Bob`);
    expect(onScanSuccess).toHaveBeenCalledWith(userId, 'Bob', undefined);
    expect(mocks.fetchContact).not.toHaveBeenCalled();
  });

  it('refuses keys that do not match the user id', async () => {
    mocks.permission = 'denied';
    const frames = encodeContactFrames({
      header,
      publicKeys: otherKeys.to_bytes(),
    });
    for (const frame of frames) await scan(frame);
    expect(onScanSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('contact_code.keys_mismatch');
    expect(onBack).toHaveBeenCalled();
  });

  it('asks for Bluetooth after a simple code, with the camera closed', async () => {
    mocks.permission = 'prompt';
    mocks.fetchContact.mockImplementation(async () => ({
      userId: encodeUserId(header.userId),
      name: 'Carol',
      publicKeys: copy(keys),
    }));
    await scan(headerOnlyFrame(header));
    expect(mocks.request).toHaveBeenCalled();
    expect(mocks.fetchContact).toHaveBeenCalledTimes(1);
    expect(onScanSuccess).toHaveBeenCalledTimes(1);
    expect(onScanSuccess.mock.calls[0].slice(0, 2)).toEqual([
      encodeUserId(header.userId),
      'Carol',
    ]);
  });

  it('gives up when Bluetooth is refused for a simple code', async () => {
    mocks.permission = 'prompt';
    mocks.requested = 'denied';
    await scan(headerOnlyFrame(header));
    expect(mocks.fetchContact).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      'contact_code.bluetooth_needed'
    );
    expect(onBack).toHaveBeenCalled();
  });

  it('says so for a code that is not Gossip', async () => {
    await scan('https://example.com');
    expect(mocks.scanner?.status).toBe('contact_code.not_gossip_code');
    expect(onScanSuccess).not.toHaveBeenCalled();
  });
});
