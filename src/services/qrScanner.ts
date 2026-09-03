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
   * `closeLabel` is the accessibility label of the close button. It is passed
   * from JS because the app has its own language setting, which can differ
   * from the OS locale that native resources would follow.
   */
  scan(options?: { closeLabel?: string }): Promise<{ value: string }>;
}

export const QrScanner = registerPlugin<QrScannerPlugin>('QrScanner');

export function isQrScanCancelled(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'CANCELLED'
  );
}
