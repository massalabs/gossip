import React from 'react';
import { useNavigate } from 'react-router-dom';
import HeaderWrapper from '../../components/ui/HeaderWrapper';
import PageHeader from '../../components/ui/PageHeader';
import ScrollableContent from '../../components/ui/ScrollableContent';
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
    <div className="h-full flex flex-col bg-background app-max-w mx-auto">
      <HeaderWrapper>
        <PageHeader title="About" onBack={handleBack} />
      </HeaderWrapper>
      <ScrollableContent className="flex-1 overflow-y-auto px-6 py-6">
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
      </ScrollableContent>
    </div>
  );
};

export default AboutSettings;
