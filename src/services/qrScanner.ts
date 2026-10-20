import { registerPlugin } from '@capacitor/core';

/**
 * Native full-screen QR scanner.
 * Android: CameraX + ZXing core (QrScanActivity). iOS: AVFoundation.
 * Neither path touches Google Play Services or the network.
 */
interface QrScannerPlugin {
  /**
   * Resolves with the decoded text. Rejects with code CANCELLED if the user
   * closes the scanner.
   *
   * With `continuous`, the scanner stays open and emits a `frame` event for
   * every new code it reads (animated codes); it resolves with an empty value
   * once `finish()` closes it.
   *
   * `closeLabel` is the accessibility label of the close button. It is passed
   * from JS because the app has its own language setting, which can differ
   * from the OS locale that native resources would follow.
   */
  scan(options?: {
    closeLabel?: string;
    continuous?: boolean;
  }): Promise<{ value: string }>;
  /** Text shown over the camera of a continuous scan (progress, hints). */
  setStatus(options: { text: string }): Promise<void>;
  /** Closes a continuous scan. */
  finish(): Promise<void>;
  addListener(
    event: 'frame',
    handler: (event: { value: string }) => void
  ): Promise<{ remove(): Promise<void> }>;
}

export const QrScanner = registerPlugin<QrScannerPlugin>('QrScanner');

export function isQrScanCancelled(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'CANCELLED'
  );
}
