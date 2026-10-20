// Shared props interface for QR scanner components
export interface QRScannerProps {
  onScan: (result: string) => void;
  onClose: () => void;
  onError: (error: string) => void;
  /**
   * Keep the camera open after a code: `onScan` gets every new code read
   * (animated codes) until `stopped` is set.
   */
  continuous?: boolean;
  /** Shown over the camera while a continuous scan runs. */
  status?: string;
  /** Closes a continuous scanner. */
  stopped?: boolean;
}
