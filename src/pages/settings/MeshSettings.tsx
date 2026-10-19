import { logger } from '../../utils/logger.ts';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Bluetooth, CheckSquare, ChevronRight, Share2 } from 'react-feather';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Toggle from '../../components/ui/Toggle';
import InfoRow from '../../components/ui/InfoRow';
import OptionBottomSheet from '../../components/ui/OptionBottomSheet';
import { useGossipSdk } from '../../hooks/useGossipSdk';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';
import {
  MESH_POWER_MODES,
  getMeshSettings,
  getMeshStatus,
  isMeshAvailable,
  setMeshBridgeEnabled,
  setMeshEnabled,
  setMeshPowerMode,
  type MeshNativeStatus,
  type MeshSettings as MeshSettingsValue,
} from '../../services/meshNode';

const STATUS_REFRESH_MS = 3000;

/** A 54px row with an icon, a label, an optional hint and a toggle. */
const ToggleRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  withDivider?: boolean;
}> = ({ icon, label, hint, checked, disabled, onChange, withDivider }) => (
  <div
    className={`min-h-[54px] flex items-center px-4 py-2 w-full ${
      withDivider ? 'border-b border-border' : ''
    }`}
  >
    <span className="text-foreground mr-4 shrink-0">{icon}</span>
    <span className="flex-1 text-left">
      <span className="block text-base font-medium text-foreground">
        {label}
      </span>
      {hint && (
        <span className="block text-xs text-muted-foreground">{hint}</span>
      )}
    </span>
    <Toggle
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      ariaLabel={label}
    />
  </div>
);

const MeshSettings: React.FC = () => {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const sdk = useGossipSdk();
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const [settings, setSettings] = useState<MeshSettingsValue | null>(null);
  const [status, setStatus] = useState<MeshNativeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPowerSheetOpen, setIsPowerSheetOpen] = useState(false);

  useEffect(() => {
    void getMeshSettings().then(setSettings);
  }, []);

  const enabled = settings?.enabled ?? false;

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const next = await getMeshStatus();
      if (!cancelled) setStatus(next);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  const handleMeshToggle = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setError(null);
      try {
        await setMeshEnabled(next, sdk);
        setSettings(await getMeshSettings());
      } catch (err) {
        logger.error('Failed to switch the offline mesh:', err);
        setError(t('mesh.start_failed'));
      } finally {
        setBusy(false);
      }
    },
    [sdk, t]
  );

  const handleBridgeToggle = useCallback(async (next: boolean) => {
    try {
      await setMeshBridgeEnabled(next);
      setSettings(await getMeshSettings());
    } catch (err) {
      logger.error('Failed to switch mesh bridging:', err);
    }
  }, []);

  const handlePowerMode = useCallback(async (index: number | null) => {
    setIsPowerSheetOpen(false);
    const mode = MESH_POWER_MODES[index ?? 1];
    try {
      await setMeshPowerMode(mode);
      setSettings(await getMeshSettings());
    } catch (err) {
      logger.error('Failed to change the mesh power mode:', err);
    }
  }, []);

  const header = (
    <PageHeader
      title={t('mesh.title')}
      onBack={() => navigate(ROUTES.settings())}
    />
  );

  if (!isMeshAvailable()) {
    return (
      <PageLayout
        header={header}
        className="app-max-w mx-auto"
        contentClassName="px-6 py-6"
      >
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">
            {t('mesh.not_available')}
          </p>
        </div>
      </PageLayout>
    );
  }

  const powerMode = settings?.powerMode ?? 'balanced';
  const yesNo = (value: boolean | undefined) =>
    value ? t('mesh.status_yes') : t('mesh.status_no');

  return (
    <PageLayout
      header={header}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-6"
    >
      <p className="text-sm text-muted-foreground">{t('mesh.description')}</p>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <ToggleRow
          icon={<Bluetooth />}
          label={t('mesh.enable')}
          checked={enabled}
          disabled={busy || settings === null}
          onChange={value => void handleMeshToggle(value)}
          withDivider
        />
        <div className="px-4 py-3 border-b border-border">
          <p className="text-xs text-muted-foreground">
            {t('mesh.enable_warning')}
          </p>
          {error && <p className="text-xs text-destructive mt-2">{error}</p>}
        </div>
        <ToggleRow
          icon={<Share2 />}
          label={t('mesh.bridge')}
          hint={t('mesh.bridge_hint')}
          checked={settings?.bridgeEnabled ?? false}
          disabled={settings === null}
          onChange={value => void handleBridgeToggle(value)}
          withDivider
        />
        <div className="px-4 py-3 border-b border-border">
          <p className="text-xs text-muted-foreground">
            {t('mesh.bridge_warning')}
          </p>
        </div>
        <button
          onClick={() => setIsPowerSheetOpen(true)}
          className="w-full flex items-center justify-between text-sm font-medium text-foreground hover:bg-muted px-4 py-3 transition-colors"
        >
          <span>{t('mesh.power_mode')}</span>
          <span className="text-accent-soft-foreground">
            {t(`mesh.power_${powerMode}`)}
          </span>
        </button>
      </div>

      {enabled && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 pt-4 pb-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {t('mesh.status_title')}
            </p>
          </div>
          <InfoRow
            label={t('mesh.status_peers')}
            value={String(status?.meshPeers ?? 0)}
          />
          <InfoRow
            label={t('mesh.status_upload_pending')}
            value={String(status?.uploadPending ?? 0)}
          />
          <InfoRow
            label={t('mesh.status_upstream')}
            value={yesNo(status?.upstreamReachable)}
          />
          <InfoRow
            label={t('mesh.status_stored')}
            value={String(status?.storedBlobs ?? 0)}
          />
          {showDebugOption && (
            <>
              <InfoRow
                label={t('mesh.status_radio_links')}
                value={String(status?.radioLinks ?? 0)}
              />
              <InfoRow
                label={t('mesh.status_rust_core')}
                value={yesNo(status?.rustCore)}
              />
              <InfoRow
                label={t('mesh.status_clock_offset')}
                value={`${status?.clockOffsetMs ?? 0} ms`}
              />
            </>
          )}
          <div className="h-2" />
        </div>
      )}

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => navigate(ROUTES.settingsMeshPrepare())}
          className="w-full h-[54px] flex items-center px-4 text-foreground hover:bg-muted transition-colors"
        >
          <CheckSquare className="mr-4" />
          <span className="text-base font-medium flex-1 text-left">
            {t('mesh.prepare')}
          </span>
          <ChevronRight className="text-muted-foreground" />
        </button>
      </div>

      <OptionBottomSheet
        isOpen={isPowerSheetOpen}
        title={t('mesh.power_mode')}
        description={t('mesh.power_mode_description')}
        options={MESH_POWER_MODES.map((mode, index) => ({
          label: t(`mesh.power_${mode}`),
          value: index,
        }))}
        selectedValue={MESH_POWER_MODES.indexOf(powerMode)}
        onSelect={value => void handlePowerMode(value)}
        onClose={() => setIsPowerSheetOpen(false)}
      />
    </PageLayout>
  );
};

export default MeshSettings;
