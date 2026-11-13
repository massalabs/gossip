import { logger } from '../../utils/logger.ts';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { QrScanner, isQrScanCancelled } from '../../services/qrScanner';
import { QRScannerProps } from './types';

const NativeQRScanner: React.FC<QRScannerProps> = ({
  onScan,
  onError,
  onClose,
  continuous = false,
  status,
  stopped = false,
}) => {
  const { t } = useTranslation('common');
  const scanStartedRef = useRef(false);
  // The handlers change on every render of the parent; the native scanner
  // lives across them, so it calls the latest ones.
  const handlersRef = useRef({ onScan, onError, onClose });
  handlersRef.current = { onScan, onError, onClose };

  // Whether the page is still there. Starting the scanner takes time (the
  // listener, then the camera permission), and the page can go away
  // meanwhile. StrictMode's unmount is followed by a mount at once, which
  // sets it back before anything below reads it.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // Guard against StrictMode double-mount opening the scanner twice
    if (scanStartedRef.current) return;
    scanStartedRef.current = true;

    void (async () => {
      const listener = continuous
        ? await QrScanner.addListener('frame', ({ value }) => {
            if (!mountedRef.current) {
              // a scanner that opened after the page left: close it
              QrScanner.finish().catch(() => undefined);
              return;
            }
            handlersRef.current.onScan(value);
          })
        : null;
      // The page left while the listener was being registered: the cleanup
      // below found no scanner to close, so do not open one now.
      if (!mountedRef.current) {
        await listener?.remove();
        return;
      }
      try {
        const { value } = await QrScanner.scan({
          closeLabel: t('close'),
          continuous,
        });
        // A continuous scan resolves once finish() closed it: nothing to read.
        if (!continuous && mountedRef.current) {
          handlersRef.current.onScan(value);
        }
      } catch (err) {
        // nobody is left to tell
        if (!mountedRef.current) return;
        if (isQrScanCancelled(err)) {
          handlersRef.current.onClose();
          return;
        }
        logger.warn('[QRScan] native scan failed', err);
        handlersRef.current.onError(
          err instanceof Error ? err.message : String(err)
        );
      } finally {
        await listener?.remove();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  useEffect(() => {
    if (!continuous || status === undefined) return;
    QrScanner.setStatus({ text: status }).catch(() => undefined);
  }, [continuous, status]);

  useEffect(() => {
    if (continuous && stopped) QrScanner.finish().catch(() => undefined);
  }, [continuous, stopped]);

  // Leaving the page closes a scanner still open.
  useEffect(
    () => () => {
      if (continuous) QrScanner.finish().catch(() => undefined);
    },
    [continuous]
  );

  return <></>;
};

export default NativeQRScanner;
