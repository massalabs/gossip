import { logger } from '../../utils/logger.ts';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Smartphone } from 'react-feather';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Button from '../../components/ui/Button';
import AnimatedQRCode from '../../components/qr/AnimatedQRCode';
import { ROUTES } from '../../constants/routes';
import { getWebAppUrl } from '../../utils/inviteUrl';
import {
  AppShare,
  buildLandingPage,
  isAppShareAvailable,
  wifiJoinCode,
  type AppShareInfo,
  type HotspotError,
  type HotspotNetwork,
} from '../../services/appShare';

const QR_SIZE = 240;

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'sharing'; network: HotspotNetwork }
  | { kind: 'error'; code: HotspotError };

function errorCode(err: unknown): HotspotError {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case 'PERMISSION_DENIED':
    case 'NOT_SHAREABLE':
    case 'WIFI_OFF':
    case 'UNSUPPORTED':
      return code;
    default:
      return 'FAILED';
  }
}

/**
 * Gives Gossip to a phone that does not have it, with no internet, like
 * Briar and bitchat: this phone opens a Wi-Fi Direct network and serves the
 * APK to the other phone's browser. iPhones get the web app's address, to
 * open while they have internet.
 */
const ShareAppSettings: React.FC = () => {
  const { t, i18n } = useTranslation('settings');
  const navigate = useNavigate();
  const [info, setInfo] = useState<AppShareInfo | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [downloads, setDownloads] = useState(0);
  const [sending, setSending] = useState(0);
  const webAppUrl = useMemo(() => getWebAppUrl(), []);
  const available = isAppShareAvailable();

  useEffect(() => {
    if (!available) return;
    void AppShare.getInfo()
      .then(setInfo)
      .catch(err => logger.error('Failed to read the shareable app:', err));
  }, [available]);

  useEffect(() => {
    if (!available) return;
    const subscriptions = [
      AppShare.addListener('download', ({ state }) => {
        if (state === 'started') setSending(n => n + 1);
        else setSending(n => Math.max(0, n - 1));
        if (state === 'completed') setDownloads(n => n + 1);
      }),
      AppShare.addListener('hotspot', () => {
        setSending(0);
        setPhase({ kind: 'error', code: 'FAILED' });
      }),
    ];
    return () => {
      subscriptions.forEach(s => void s.then(handle => handle.remove()));
      // the network lives only while this page is open
      void AppShare.stopHotspot();
    };
  }, [available]);

  const sizeMb = info ? (info.sizeBytes / 1_000_000).toFixed(0) : '';

  const start = useCallback(async () => {
    setPhase({ kind: 'starting' });
    try {
      const { state } = await AppShare.requestWifiPermission();
      if (state !== 'granted') {
        setPhase({ kind: 'error', code: 'PERMISSION_DENIED' });
        return;
      }
      const landingPage = buildLandingPage({
        lang: i18n.language,
        title: t('share_app.page_title'),
        androidSteps: t('share_app.page_android_steps'),
        download: t('share_app.page_download', { size: sizeMb }),
        iosTitle: t('share_app.ios_title'),
        iosSteps: t('share_app.page_ios_steps'),
        webAppUrl,
      });
      const network = await AppShare.startHotspot({ landingPage });
      setDownloads(0);
      setPhase({ kind: 'sharing', network });
    } catch (err) {
      logger.error('Failed to start the app-sharing network:', err);
      setPhase({ kind: 'error', code: errorCode(err) });
    }
  }, [i18n.language, sizeMb, t, webAppUrl]);

  const stop = useCallback(async () => {
    await AppShare.stopHotspot();
    setSending(0);
    setPhase({ kind: 'idle' });
  }, []);

  const header = (
    <PageHeader
      title={t('share_app.title')}
      onBack={() => navigate(ROUTES.settingsMesh())}
    />
  );

  const iosCard = (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-3">
        <Smartphone className="w-5 h-5 text-foreground shrink-0" />
        <p className="text-base font-medium text-foreground">
          {t('share_app.ios_title')}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        {t('share_app.ios_detail')}
      </p>
      <div className="flex justify-center">
        <AnimatedQRCode
          frames={[webAppUrl]}
          mode="Byte"
          size={QR_SIZE}
          ariaLabel={t('share_app.ios_title')}
        />
      </div>
      <p className="text-xs text-muted-foreground text-center break-all">
        {webAppUrl}
      </p>
    </div>
  );

  if (!available) {
    return (
      <PageLayout
        header={header}
        className="app-max-w mx-auto"
        contentClassName="px-6 py-6 space-y-6"
      >
        <p className="text-sm text-muted-foreground">
          {t('share_app.not_available')}
        </p>
        {iosCard}
      </PageLayout>
    );
  }

  const errorText =
    phase.kind === 'error'
      ? {
          PERMISSION_DENIED: t('share_app.permission_denied'),
          NOT_SHAREABLE: t('share_app.not_shareable'),
          WIFI_OFF: t('share_app.wifi_off'),
          UNSUPPORTED: t('share_app.unsupported'),
          FAILED: t('share_app.failed'),
        }[phase.code]
      : null;

  return (
    <PageLayout
      header={header}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-6"
    >
      <p className="text-sm text-muted-foreground">{t('share_app.intro')}</p>

      {info && !info.shareable ? (
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-sm text-muted-foreground">
            {t('share_app.not_shareable')}
          </p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl p-4 space-y-4">
          {phase.kind === 'sharing' ? (
            <>
              <p className="text-base font-medium text-foreground">
                {t('share_app.step_join')}
              </p>
              <div className="flex justify-center">
                <AnimatedQRCode
                  frames={[
                    wifiJoinCode(phase.network.ssid, phase.network.passphrase),
                  ]}
                  mode="Byte"
                  size={QR_SIZE}
                  ariaLabel={t('share_app.step_join')}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('share_app.join_tip')}
              </p>
              <p className="text-sm font-medium text-foreground text-center">
                {t('share_app.network_details', {
                  ssid: phase.network.ssid,
                  passphrase: phase.network.passphrase,
                })}
              </p>
              <p className="text-base font-medium text-foreground">
                {t('share_app.step_open')}
              </p>
              <div className="flex justify-center">
                <AnimatedQRCode
                  frames={[phase.network.url]}
                  mode="Byte"
                  size={QR_SIZE}
                  ariaLabel={t('share_app.step_open')}
                />
              </div>
              <p className="text-xs text-muted-foreground text-center">
                {phase.network.url}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('share_app.mobile_data_hint')}
              </p>
              <p className="text-sm font-medium text-foreground">
                {sending > 0
                  ? t('share_app.sending')
                  : t('share_app.downloads', { count: downloads })}
              </p>
              <Button variant="outline" fullWidth onClick={() => void stop()}>
                {t('share_app.stop')}
              </Button>
            </>
          ) : (
            <>
              {info && (
                <p className="text-xs text-muted-foreground">
                  {t('share_app.size', {
                    version: info.version,
                    size: sizeMb,
                  })}
                </p>
              )}
              {errorText && (
                <p className="text-sm text-destructive">{errorText}</p>
              )}
              {phase.kind === 'error' && phase.code === 'WIFI_OFF' && (
                <Button
                  variant="outline"
                  fullWidth
                  onClick={() => void AppShare.openWifiSettings()}
                >
                  {t('share_app.wifi_off_button')}
                </Button>
              )}
              <Button
                fullWidth
                loading={phase.kind === 'starting'}
                disabled={phase.kind === 'starting' || info === null}
                onClick={() => void start()}
              >
                {t('share_app.start')}
              </Button>
            </>
          )}
        </div>
      )}

      {iosCard}
    </PageLayout>
  );
};

export default ShareAppSettings;
