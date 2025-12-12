import React from 'react';
import { useNavigate } from 'react-router-dom';
import HeaderWrapper from '../../components/ui/HeaderWrapper';
import PageHeader from '../../components/ui/PageHeader';
import ScrollableContent from '../../components/ui/ScrollableContent';
import BackgroundSyncSettings from '../../components/settings/BackgroundSyncSettings';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';

const SecuritySettings: React.FC = () => {
  const navigate = useNavigate();
  const showDebugOption = useAppStore(s => s.showDebugOption);

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  return (
    <div className="h-full flex flex-col bg-background app-max-w mx-auto">
      <HeaderWrapper>
        <PageHeader title="Security" onBack={handleBack} />
      </HeaderWrapper>
      <ScrollableContent className="flex-1 overflow-y-auto px-6 py-6">
        <BackgroundSyncSettings showDebugInfo={showDebugOption} />
      </ScrollableContent>
    </div>
  );
};

export default SecuritySettings;

