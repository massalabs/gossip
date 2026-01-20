import React from 'react';
import { useNavigate } from 'react-router-dom';
import PageLayout from '../../components/ui/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import InfoRow from '../../components/ui/InfoRow';
import { APP_VERSION, APP_BUILD_ID } from '../../config/version';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';

const AboutSettings: React.FC = () => {
  const navigate = useNavigate();
  const showDebugOption = useAppStore(s => s.showDebugOption);

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  return (
    <PageLayout
      header={<PageHeader title="About" onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6"
    >
      <div className="bg-card rounded-xl border border-border p-4">
        <InfoRow
          label="Version"
          value={APP_VERSION}
          containerClassName="bg-transparent"
        />
        {showDebugOption && (
          <InfoRow
            label="Build ID"
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
