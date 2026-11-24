import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Radio } from 'react-feather';
import toast from 'react-hot-toast';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Button from '../../components/ui/Button';
import { ROUTES } from '../../constants/routes';
import {
  connectRadio,
  disconnectRadio,
  useRadioStore,
} from '../../services/meshcoreRadio';
import { RADIO_MAX_TEXT_BYTES } from '@massalabs/gossip-sdk';

/**
 * Pairing a MeshCore radio: group messages then travel by LoRa when there is
 * no internet (see `services/meshcoreRadio.ts`).
 */
const RadioSettings: React.FC = () => {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const status = useRadioStore(s => s.status);
  const deviceName = useRadioStore(s => s.deviceName);
  const channelIdx = useRadioStore(s => s.channelIdx);

  const connect = () => {
    connectRadio().catch((e: unknown) => {
      const message = e instanceof Error ? e.message : '';
      toast.error(
        message === 'radio:no-free-channel'
          ? t('radio.no_free_channel')
          : message === 'radio:bluetooth-off'
            ? t('radio.bluetooth_off')
            : t('radio.connect_failed')
      );
    });
  };

  return (
    <PageLayout
      header={
        <PageHeader
          title={t('radio.title')}
          onBack={() => navigate(ROUTES.settings())}
        />
      }
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-6"
    >
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 pt-4 pb-3 space-y-2">
          <p className="text-sm text-muted-foreground">
            {t('radio.description', { bytes: RADIO_MAX_TEXT_BYTES })}
          </p>
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Radio className="w-4 h-4" />
            {status === 'connected'
              ? t('radio.connected_to', {
                  name: deviceName,
                  slot: channelIdx,
                })
              : status === 'connecting'
                ? t('radio.connecting')
                : t('radio.not_connected')}
          </p>
        </div>
        <div className="px-4 py-3 border-t border-border">
          <Button
            onClick={
              status === 'connected' ? () => void disconnectRadio() : connect
            }
            disabled={status === 'connecting'}
            loading={status === 'connecting'}
            variant="outline"
            size="custom"
            fullWidth
            className="h-11 rounded-full text-sm font-medium"
          >
            {status === 'connected'
              ? t('radio.disconnect')
              : status === 'connecting'
                ? null
                : t('radio.connect')}
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
        <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
        <ul className="text-sm text-amber-700 dark:text-amber-300 leading-relaxed list-disc pl-4 space-y-1">
          <li>{t('radio.note_visible')}</li>
          <li>{t('radio.note_name')}</li>
          <li>{t('radio.note_pin')}</li>
          <li>{t('radio.note_no_kick')}</li>
        </ul>
      </div>
    </PageLayout>
  );
};

export default RadioSettings;
