import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { CheckCircle, Circle, Info } from 'react-feather';
import { SELF_CONTACT_ID, SessionStatus } from '@massalabs/gossip-sdk';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Button from '../../components/ui/Button';
import { useGossipSdk } from '../../hooks/useGossipSdk';
import { ROUTES } from '../../constants/routes';
import { batteryOptimizationService } from '../../services/batteryOptimization';
import { getMeshSettings } from '../../services/meshNode';

interface Readiness {
  meshEnabled: boolean;
  activeContacts: number;
  totalContacts: number;
  /** Null where it does not apply (iOS) or cannot be read. */
  batteryUnrestricted: boolean | null;
}

/** One checklist item: done or not, why it matters, and how to fix it. */
const ChecklistItem: React.FC<{
  done: boolean | null;
  title: string;
  detail: string;
  action?: React.ReactNode;
}> = ({ done, title, detail, action }) => (
  <div className="flex items-start gap-3 px-4 py-4 border-b border-border last:border-b-0">
    <span className="mt-0.5 shrink-0">
      {done === null ? (
        <Info className="w-5 h-5 text-muted-foreground" />
      ) : done ? (
        <CheckCircle className="w-5 h-5 text-success" />
      ) : (
        <Circle className="w-5 h-5 text-muted-foreground" />
      )}
    </span>
    <div className="flex-1 space-y-2">
      <p className="text-base font-medium text-foreground">{title}</p>
      <p className="text-sm text-muted-foreground">{detail}</p>
      {action}
    </div>
  </div>
);

/**
 * What to do while there is still internet, so the offline mesh works on the
 * day: mesh on, fresh sessions with the people you will need, and nothing
 * stopping the app in the background.
 */
const MeshPrepareSettings: React.FC = () => {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const sdk = useGossipSdk();
  const [readiness, setReadiness] = useState<Readiness | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [settings, contacts, battery] = await Promise.all([
        getMeshSettings(),
        sdk.contacts.list(),
        batteryOptimizationService.getStatus().catch(() => null),
      ]);
      const others = contacts.filter(c => c.userId !== SELF_CONTACT_ID);
      const active = others.filter(
        c => sdk.discussions.getStatus(c.userId) === SessionStatus.Active
      ).length;
      if (cancelled) return;
      setReadiness({
        meshEnabled: settings.enabled,
        activeContacts: active,
        totalContacts: others.length,
        batteryUnrestricted: battery
          ? battery.isIgnoringBatteryOptimization
          : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [sdk]);

  const isIos = Capacitor.getPlatform() === 'ios';

  return (
    <PageLayout
      header={
        <PageHeader
          title={t('mesh.prepare')}
          onBack={() => navigate(ROUTES.settingsMesh())}
        />
      }
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-6"
    >
      <p className="text-sm text-muted-foreground">{t('mesh.prepare_intro')}</p>

      {readiness && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <ChecklistItem
            done={readiness.meshEnabled}
            title={t('mesh.check_enabled')}
            detail={t('mesh.check_enabled_detail')}
            action={
              !readiness.meshEnabled && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(ROUTES.settingsMesh())}
                >
                  {t('mesh.check_enabled_action')}
                </Button>
              )
            }
          />
          <ChecklistItem
            done={
              readiness.totalContacts > 0 &&
              readiness.activeContacts === readiness.totalContacts
            }
            title={t('mesh.check_sessions', {
              active: readiness.activeContacts,
              total: readiness.totalContacts,
            })}
            detail={t('mesh.check_sessions_detail')}
          />
          {isIos ? (
            <ChecklistItem
              done={null}
              title={t('mesh.check_ios_background')}
              detail={t('mesh.check_ios_background_detail')}
            />
          ) : (
            <ChecklistItem
              done={readiness.batteryUnrestricted}
              title={t('mesh.check_battery')}
              detail={t('mesh.check_battery_detail')}
              action={
                readiness.batteryUnrestricted === false && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void batteryOptimizationService.openBatteryOptimizationSettings()
                    }
                  >
                    {t('mesh.check_battery_action')}
                  </Button>
                )
              }
            />
          )}
          <ChecklistItem
            done={null}
            title={t('mesh.check_add_nearby')}
            detail={t('mesh.check_add_nearby_detail')}
          />
          <ChecklistItem
            done={null}
            title={t('mesh.check_keyring')}
            detail={t('mesh.check_keyring_detail')}
          />
        </div>
      )}
    </PageLayout>
  );
};

export default MeshPrepareSettings;
