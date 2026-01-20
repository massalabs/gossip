import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import PageLayout from '../../components/ui/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import BackgroundSyncSettings from '../../components/settings/BackgroundSyncSettings';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';

const SecuritySettings: React.FC = () => {
  const navigate = useNavigate();
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const platform = Capacitor.getPlatform();
  const isNative = platform !== 'web';

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  return (
    <PageLayout
      header={<PageHeader title="Security" onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6"
    >
      {isNative ? (
        <BackgroundSyncSettings showDebugInfo={showDebugOption} />
      ) : (
        <div className="bg-card rounded-lg p-6 border border-border">
          <p className="text-sm text-muted-foreground">
            Security settings are only available on native platforms (Android
            and iOS).
          </p>
        </div>
      )}
    </PageLayout>
  );
};

export default SecuritySettings;
