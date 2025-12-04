// Shared props interface for QR scanner components
export interface QRScannerProps {
  onScan: (result: string) => void;
  onClose: () => void;
  onError?: (error: string) => void;
}
