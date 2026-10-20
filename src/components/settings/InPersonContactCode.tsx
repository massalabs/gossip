import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { App } from '@capacitor/app';
import { Bluetooth, Check } from 'react-feather';
import type { UserPublicKeys } from '@massalabs/gossip-sdk';
import AnimatedQRCode from '../qr/AnimatedQRCode';
import { logger } from '../../utils/logger.ts';
import {
  ContactCodeSession,
  checkBluetoothPermission,
  requestBluetoothPermission,
} from '../../services/contactExchange';

interface InPersonContactCodeProps {
  userId: string;
  publicKeys: UserPublicKeys;
  name?: string;
}

type BluetoothState =
  | 'checking'
  /** Not allowed yet: offered with a button. */
  | 'prompt'
  | 'on'
  /** Off, refused or unsupported: the animated code still works. */
  | 'unavailable'
  /** Stopped after the time limit or when the app went to the background. */
  | 'stopped';

/**
 * The in-person contact code: an animated QR code that carries the keys,
 * so adding someone works with no internet and without publishing them, and
 * Bluetooth as a faster path once the other phone has read one frame. The
 * ephemeral key and rendezvous id live as long as this code is on screen.
 */
const InPersonContactCode: React.FC<InPersonContactCodeProps> = ({
  userId,
  publicKeys,
  name,
}) => {
  const { t } = useTranslation('contacts');
  const [simple, setSimple] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [bluetooth, setBluetooth] = useState<BluetoothState>('checking');
  const [shared, setShared] = useState(0);

  const [session, setSession] = useState<ContactCodeSession | null>(null);
  const frames = useMemo(
    () => (!session ? [] : simple ? [session.simpleFrame()] : session.frames()),
    [session, simple]
  );

  const start = useCallback(async (code: ContactCodeSession, ask: boolean) => {
    const permission = ask
      ? await requestBluetoothPermission()
      : await checkBluetoothPermission();
    if (code.isStopped) return;
    if (permission === 'prompt') {
      setBluetooth('prompt');
      return;
    }
    if (permission !== 'granted') {
      setBluetooth('unavailable');
      return;
    }
    try {
      await code.startBluetooth({
        onShared: () => setShared(count => count + 1),
        onStopped: () => setBluetooth('stopped'),
      });
      if (code.isPresenting) setBluetooth('on');
    } catch (error) {
      logger.warn('[ContactCode] bluetooth unavailable', error);
      setBluetooth('unavailable');
    }
  }, []);

  // A new session (fresh ephemeral key and rendezvous id) per code shown.
  // Bluetooth runs while it is on screen, if it is already allowed; the
  // ephemeral key is dropped with the code. `generation` restarts it.
  useEffect(() => {
    const code = new ContactCodeSession(userId, publicKeys.to_bytes(), name);
    setSession(code);
    void start(code, false);
    return () => {
      void code.stop();
    };
  }, [userId, publicKeys, name, generation, start]);

  // Leaving the app takes the code off screen: stop advertising.
  useEffect(() => {
    const listener = App.addListener('appStateChange', ({ isActive }) => {
      if (isActive || !session?.isPresenting) return;
      void session.stopBluetooth();
      setBluetooth('stopped');
    });
    return () => {
      void listener.then(l => l.remove());
    };
  }, [session]);

  const restart = useCallback(() => {
    setShared(0);
    setBluetooth('checking');
    setGeneration(g => g + 1);
  }, []);

  const showSimple = useCallback(() => {
    setSimple(true);
    // The simple code needs Bluetooth: ask for it now if it is not allowed.
    if (bluetooth === 'prompt' && session) void start(session, true);
  }, [bluetooth, session, start]);

  if (!session) return null;

  return (
    <div className="flex flex-col items-center gap-3">
      <AnimatedQRCode frames={frames} ariaLabel={t('contact_code.qr_label')} />
      <p className="text-sm font-medium text-foreground text-center">
        {t('contact_code.hold_phone')}
      </p>

      <div
        className="flex items-center gap-2 text-xs text-muted-foreground text-center"
        role="status"
        aria-live="polite"
      >
        {shared > 0 ? (
          <>
            <Check className="w-3.5 h-3.5 text-success shrink-0" />
            <span>{t('contact_code.shared')}</span>
          </>
        ) : (
          <>
            <Bluetooth className="w-3.5 h-3.5 shrink-0" />
            <span>
              {bluetooth === 'on' && t('contact_code.bluetooth_on')}
              {bluetooth === 'unavailable' &&
                (simple
                  ? t('contact_code.bluetooth_unavailable_simple')
                  : t('contact_code.bluetooth_unavailable'))}
              {bluetooth === 'stopped' && t('contact_code.bluetooth_stopped')}
              {bluetooth === 'prompt' && t('contact_code.bluetooth_off_hint')}
            </span>
          </>
        )}
      </div>

      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
        {bluetooth === 'prompt' && (
          <button
            type="button"
            onClick={() => session && void start(session, true)}
            className="text-xs font-medium text-accent-soft-foreground underline underline-offset-2"
          >
            {t('contact_code.bluetooth_offer')}
          </button>
        )}
        {bluetooth === 'stopped' && (
          <button
            type="button"
            onClick={restart}
            className="text-xs font-medium text-accent-soft-foreground underline underline-offset-2"
          >
            {t('contact_code.restart')}
          </button>
        )}
        <button
          type="button"
          onClick={simple ? () => setSimple(false) : showSimple}
          className="text-xs font-medium text-accent-soft-foreground underline underline-offset-2"
        >
          {simple
            ? t('contact_code.animated_code')
            : t('contact_code.simple_code')}
        </button>
      </div>
      {simple && (
        <p className="text-xs text-muted-foreground text-center">
          {t('contact_code.simple_code_hint')}
        </p>
      )}
    </div>
  );
};

export default InPersonContactCode;
