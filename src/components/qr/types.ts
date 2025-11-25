// Shared props interface for QR scanner components
export interface QRScannerProps {
  onScan: (result: string) => void;
  onError?: (error: string) => void;
  onClose?: () => void;
}
