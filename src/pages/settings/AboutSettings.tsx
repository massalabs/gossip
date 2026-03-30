import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import PageLayout from '../../components/ui/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import InfoRow from '../../components/ui/InfoRow';
import { APP_VERSION, APP_BUILD_ID } from '../../config/version';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';

const AboutSettings: React.FC = () => {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const showDebugOption = useAppStore(s => s.showDebugOption);

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  return (
    <PageLayout
      header={<PageHeader title={t('about.title')} onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6"
    >
      <div className="bg-card rounded-xl border border-border p-4">
        <InfoRow
          label={t('about.version')}
          value={APP_VERSION}
          containerClassName="bg-transparent"
        />
        {showDebugOption && (
          <InfoRow
            label={t('about.build_id')}
            value={APP_BUILD_ID}
            valueClassName="text-xs text-muted-foreground font-mono"
            containerClassName="bg-transparent mt-2"
          />
        )}
      </div>
    </PageLayout>
  );
};

export default AboutSettings;
