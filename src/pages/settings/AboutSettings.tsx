import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { FileText, Info } from 'react-feather';
import PageLayout from '../../components/ui/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import InfoRow from '../../components/ui/InfoRow';
import Button from '../../components/ui/Button';
import BaseModal from '../../components/ui/BaseModal';
import ToS from '../../components/ToS';
import { APP_VERSION, APP_BUILD_ID } from '../../config/version';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';

const AboutSettings: React.FC = () => {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const [isTermsModalOpen, setIsTermsModalOpen] = useState(false);

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  const handleOpenGossipWebsite = () => {
    window.open('https://usegossip.massa.network/', '_blank');
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
      <div className="mt-6 bg-card rounded-xl border border-border overflow-hidden">
        <Button
          variant="outline"
          size="custom"
          className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border"
          onClick={handleOpenGossipWebsite}
        >
          <Info className="mr-4" />
          <span className="text-base font-semibold flex-1 text-left">
            {t('about.about_gossip', 'About Gossip')}
          </span>
        </Button>
        <Button
          variant="outline"
          size="custom"
          className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0"
          onClick={() => setIsTermsModalOpen(true)}
        >
          <FileText className="mr-4" />
          <span className="text-base font-semibold flex-1 text-left">
            {t('about.terms_conditions', 'Terms & Conditions')}
          </span>
        </Button>
      </div>
      <BaseModal
        isOpen={isTermsModalOpen}
        onClose={() => setIsTermsModalOpen(false)}
        title={t('about.terms_conditions', 'Terms & Conditions')}
      >
        <div className="h-[70vh] min-h-0 flex flex-col">
          <ToS />
        </div>
      </BaseModal>
    </PageLayout>
  );
};

export default AboutSettings;
