import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type FrameHandler = (event: { value: string }) => void;

/** A promise the test settles when it wants to. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  frame: null as FrameHandler | null,
  removeListener: vi.fn(async () => undefined),
  addListener: vi.fn(),
  scan: vi.fn(),
  finish: vi.fn(async () => undefined),
  setStatus: vi.fn(async () => undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../src/services/qrScanner', () => ({
  QrScanner: {
    addListener: mocks.addListener,
    scan: mocks.scan,
    finish: mocks.finish,
    setStatus: mocks.setStatus,
  },
  isQrScanCancelled: (err: unknown) =>
    (err as { code?: string } | null)?.code === 'CANCELLED',
}));

import NativeQRScanner from '../../src/components/qr/NativeQRScanner';

describe('NativeQRScanner', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onScan = vi.fn();
  const onError = vi.fn();
  const onClose = vi.fn();

  async function mount(continuous: boolean) {
    await act(async () => {
      root.render(
        <NativeQRScanner
          onScan={onScan}
          onError={onError}
          onClose={onClose}
          continuous={continuous}
        />
      );
    });
  }

  async function unmount() {
    await act(async () => {
      root.unmount();
    });
  }

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.frame = null;
    mocks.addListener.mockImplementation(
      async (_event: string, handler: FrameHandler) => {
        mocks.frame = handler;
        return { remove: mocks.removeListener };
      }
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('passes the frames of a continuous scan while the page is there', async () => {
    mocks.scan.mockReturnValue(deferred<{ value: string }>().promise);
    await mount(true);

    mocks.frame?.({ value: 'frame-1' });

    expect(onScan).toHaveBeenCalledWith('frame-1');
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it('does not open the scanner when the page left while the listener was registered', async () => {
    const listener = deferred<{ remove(): Promise<void> }>();
    mocks.addListener.mockReturnValue(listener.promise);
    await mount(true);
    await unmount();

    await act(async () => {
      listener.resolve({ remove: mocks.removeListener });
    });

    expect(mocks.scan).not.toHaveBeenCalled();
    expect(mocks.removeListener).toHaveBeenCalledOnce();
  });

  it('closes a scanner that reports a frame after the page left', async () => {
    mocks.scan.mockReturnValue(deferred<{ value: string }>().promise);
    await mount(true);
    await unmount();
    mocks.finish.mockClear();

    mocks.frame?.({ value: 'late' });

    expect(onScan).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledOnce();
  });

  it('ignores the result of a single scan that ends after the page left', async () => {
    const scan = deferred<{ value: string }>();
    mocks.scan.mockReturnValue(scan.promise);
    await mount(false);
    await unmount();

    await act(async () => {
      scan.resolve({ value: 'late' });
    });

    expect(onScan).not.toHaveBeenCalled();
  });

  it('ignores a scan that fails or is cancelled after the page left', async () => {
    const scan = deferred<{ value: string }>();
    mocks.scan.mockReturnValue(scan.promise);
    await mount(true);
    await unmount();

    await act(async () => {
      scan.reject({ code: 'CANCELLED' });
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(mocks.removeListener).toHaveBeenCalledOnce();
  });

  it('opens the scanner once under StrictMode', async () => {
    mocks.scan.mockReturnValue(deferred<{ value: string }>().promise);
    await act(async () => {
      root.render(
        <React.StrictMode>
          <NativeQRScanner
            onScan={onScan}
            onError={onError}
            onClose={onClose}
            continuous
          />
        </React.StrictMode>
      );
    });

    expect(mocks.scan).toHaveBeenCalledOnce();
    mocks.frame?.({ value: 'frame-1' });
    expect(onScan).toHaveBeenCalledWith('frame-1');
  });
});
