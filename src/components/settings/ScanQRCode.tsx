import { logger } from '../../utils/logger.ts';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { UserPublicKeys } from '@massalabs/gossip-sdk';
import { tryParseInvite } from '../../utils/invite';
import toast from 'react-hot-toast';
import { Capacitor } from '@capacitor/core';
import { PrivacyScreen } from '@capacitor-community/privacy-screen';
import { Bluetooth } from 'react-feather';
import WebQRScanner from '../qr/WebQRScanner';
import NativeQRScanner from '../qr/NativeQRScanner';
import Button from '../ui/Button';
import {
  ContactCodeDecoder,
  type ContactCodeHeader,
  type VerifiedContact,
  verifyContactPayload,
} from '../../utils/contactExchange';
import {
  cancelBluetoothExchange,
  checkBluetoothPermission,
  fetchContactOverBluetooth,
  isBluetoothExchangeSupported,
  requestBluetoothPermission,
} from '../../services/contactExchange';

interface ScanQRCodeProps {
  onBack: () => void;
  /**
   * `publicKeys` is set when the code carried them (in-person contact code),
   * already checked against `userId`: no server lookup is needed.
   */
  onScanSuccess: (
    userId: string,
    name?: string,
    publicKeys?: UserPublicKeys
  ) => void;
}

/** Bluetooth attempts per scan before relying on the camera alone. */
const BLUETOOTH_ATTEMPTS = 2;

type BluetoothState = 'idle' | 'checking' | 'running' | 'failed';

/**
 * Scans a plain invite QR code, or an in-person contact code: the frames of
 * the animated code are read until the keys are complete and, as soon as one
 * frame is read, the keys are also asked over Bluetooth. Whichever finishes
 * first wins; keys are checked against the user id before use.
 */
const ScanQRCode: React.FC<ScanQRCodeProps> = ({ onBack, onScanSuccess }) => {
  const { t } = useTranslation('errors');
  const { t: tc } = useTranslation('contacts');
  const isNative = Capacitor.isNativePlatform();
  const decoderRef = useRef(new ContactCodeDecoder());
  const doneRef = useRef(false);
  const bluetoothRef = useRef<BluetoothState>('idle');
  const [progress, setProgress] = useState<number | null>(null);
  const [bluetooth, setBluetooth] = useState<BluetoothState>('idle');
  const [notGossip, setNotGossip] = useState(false);
  const [stopped, setStopped] = useState(false);
  // The camera is closed and only Bluetooth is left (simple code).
  const [bluetoothOnly, setBluetoothOnly] = useState(false);

  // Disable privacy screen when scanner is opened, re-enable when closed
  useEffect(() => {
    if (!isNative) return;

    const disablePrivacyScreen = async () => {
      try {
        await PrivacyScreen.disable();
      } catch (error) {
        logger.warn('Failed to disable privacy screen:', error);
      }
    };

    disablePrivacyScreen();

    // Re-enable privacy screen when component unmounts
    return () => {
      void (async () => {
        try {
          await PrivacyScreen.enable();
        } catch (error) {
          logger.warn('Failed to enable privacy screen:', error);
        }
      })();
    };
  }, [isNative]);

  // Leaving the scanner stops a Bluetooth attempt still running.
  useEffect(
    () => () => {
      doneRef.current = true;
      if (bluetoothRef.current === 'running') void cancelBluetoothExchange();
    },
    []
  );

  const setBluetoothState = useCallback((state: BluetoothState) => {
    bluetoothRef.current = state;
    setBluetooth(state);
  }, []);

  const succeed = useCallback(
    (userId: string, name?: string, publicKeys?: UserPublicKeys) => {
      if (doneRef.current) {
        publicKeys?.free();
        return;
      }
      doneRef.current = true;
      setStopped(true);
      if (bluetoothRef.current === 'running') void cancelBluetoothExchange();
      onScanSuccess(userId, name, publicKeys);
    },
    [onScanSuccess]
  );

  const fail = useCallback(
    (message: string) => {
      if (doneRef.current) return;
      doneRef.current = true;
      setStopped(true);
      if (bluetoothRef.current === 'running') void cancelBluetoothExchange();
      toast.error(message);
      onBack();
    },
    [onBack]
  );

  const runBluetooth = useCallback(
    async (header: ContactCodeHeader, cameraOpen: boolean) => {
      setBluetoothState('running');
      for (let i = 0; i < BLUETOOTH_ATTEMPTS && !doneRef.current; i++) {
        const contact: VerifiedContact | null =
          await fetchContactOverBluetooth(header);
        if (contact) {
          succeed(contact.userId, contact.name, contact.publicKeys);
          return;
        }
      }
      if (doneRef.current) return;
      setBluetoothState('failed');
      if (!cameraOpen) fail(tc('contact_code.bluetooth_failed'));
    },
    [setBluetoothState, succeed, fail, tc]
  );

  /** One frame was read: try Bluetooth too, if it can run. */
  const startBluetooth = useCallback(
    async (header: ContactCodeHeader, headerOnly: boolean) => {
      if (bluetoothRef.current !== 'idle') return;
      // The web has no Bluetooth: only the animated code works there.
      if (!isBluetoothExchangeSupported()) return;
      setBluetoothState('checking');
      const permission = await checkBluetoothPermission();
      if (doneRef.current) return;
      if (permission === 'granted') {
        void runBluetooth(header, true);
        return;
      }
      if (!headerOnly) {
        // The animated code needs no Bluetooth: do not interrupt the camera.
        setBluetoothState('idle');
        return;
      }
      // The simple code needs Bluetooth. Close the camera first: the
      // permission prompt cannot show over it on Android.
      setStopped(true);
      setBluetoothOnly(true);
      const requested = await requestBluetoothPermission();
      if (doneRef.current) return;
      if (requested !== 'granted') {
        fail(tc('contact_code.bluetooth_needed'));
        return;
      }
      void runBluetooth(header, false);
    },
    [setBluetoothState, runBluetooth, fail, tc]
  );

  const handleScan = useCallback(
    (qrText: string) => {
      if (doneRef.current) return;
      const decoder = decoderRef.current;
      const result = decoder.receive(qrText);

      if (result.kind === 'ignored') {
        if (decoder.lockedHeader) return;
        const invite = tryParseInvite(qrText);
        if (invite) {
          succeed(invite.userId, invite.name);
          return;
        }
        setNotGossip(true);
        return;
      }

      setNotGossip(false);
      if (result.kind === 'complete') {
        const contact = verifyContactPayload(result.payload);
        if (!contact) {
          logger.warn('[QRScan] contact code keys do not match its user id');
          fail(tc('contact_code.keys_mismatch'));
          return;
        }
        succeed(contact.userId, contact.name, contact.publicKeys);
        return;
      }

      if (!result.headerOnly) setProgress(result.progress);
      void startBluetooth(result.header, result.headerOnly);
    },
    [succeed, fail, startBluetooth, tc]
  );

  const handleError = (err: string) => {
    logger.warn('[QRScan]', err);
    toast.error(t('qr_scan_failed'));
    onBack();
  };

  const handleCancel = useCallback(() => {
    doneRef.current = true;
    if (bluetoothRef.current === 'running') void cancelBluetoothExchange();
    onBack();
  }, [onBack]);

  const statusLines: string[] = [];
  if (notGossip) statusLines.push(tc('contact_code.not_gossip_code'));
  else if (progress !== null)
    statusLines.push(
      tc('contact_code.reading', { percent: Math.round(progress * 100) })
    );
  else if (!decoderRef.current.lockedHeader)
    statusLines.push(tc('contact_code.point_camera'));
  if (bluetooth === 'running')
    statusLines.push(tc('contact_code.using_bluetooth'));
  if (bluetooth === 'failed')
    statusLines.push(tc('contact_code.bluetooth_failed_keep_camera'));
  if (
    !isNative &&
    decoderRef.current.lockedHeader &&
    progress === null &&
    !notGossip
  )
    statusLines.push(tc('contact_code.web_simple_code'));
  const status = statusLines.join('\n');

  if (bluetoothOnly) {
    return (
      <div
        className="app-max-w mx-auto h-full flex flex-col items-center justify-center gap-6 px-6 text-center"
        role="status"
        aria-live="polite"
      >
        <Bluetooth className="w-10 h-10 text-accent animate-pulse" />
        <p className="text-base text-foreground">
          {tc('contact_code.using_bluetooth')}
        </p>
        <p className="text-sm text-muted-foreground">
          {tc('contact_code.keep_close')}
        </p>
        <Button variant="outline" onClick={handleCancel}>
          {tc('common:cancel')}
        </Button>
      </div>
    );
  }

  if (isNative) {
    return (
      <NativeQRScanner
        onScan={handleScan}
        onError={handleError}
        onClose={handleCancel}
        continuous
        status={status}
        stopped={stopped}
      />
    );
  }

  return (
    <WebQRScanner
      onScan={handleScan}
      onError={handleError}
      onClose={handleCancel}
      continuous
      status={status}
      stopped={stopped}
    />
  );
};

export default ScanQRCode;
