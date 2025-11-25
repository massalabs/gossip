import React from 'react';
import { Capacitor } from '@capacitor/core';
import NativeQRScanner from './NativeQRScanner';
import WebQRScanner from './WebQRScanner';
import { QRScannerProps } from './types';

const QRScanner: React.FC<QRScannerProps> = props => {
  const isNative = Capacitor.isNativePlatform();

  if (isNative) {
    return <NativeQRScanner {...props} />;
  }

  return <WebQRScanner {...props} />;
};

export default QRScanner;
export type { QRScannerProps };
