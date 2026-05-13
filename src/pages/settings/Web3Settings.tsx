import { logger } from '../../utils/logger.ts';
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import PageLayout from '../../components/ui/Layout/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Toggle from '../../components/ui/Toggle';
import { useAppStore } from '../../stores/appStore';
import { useAccountStore } from '../../stores/accountStore';
import { ROUTES } from '../../constants/routes';
import { Globe, AlertCircle } from 'react-feather';
import { resolveDeweb } from '@massalabs/massa-web3';
import { openUrl } from '../../utils/linkUtils';

const Web3Settings: React.FC = () => {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const mnsEnabled = useAppStore(s => s.mnsEnabled);
  const setMnsEnabled = useAppStore(s => s.setMnsEnabled);
  const fetchMnsDomains = useAppStore(s => s.fetchMnsDomains);
  const { userProfile, provider } = useAccountStore();
  const [mnsUrl, setMnsUrl] = useState<string | null>(null);

  useEffect(() => {
    const resolveMnsLink = async () => {
      try {
        const url = await resolveDeweb('mns.massa');
        setMnsUrl(url);
      } catch (error) {
        logger.error('Failed to resolve mns.massa:', error);
      }
    };
    resolveMnsLink();
  }, []);

  const handleBack = () => {
    navigate(ROUTES.settings());
  };

  const handleMnsToggle = async (enabled: boolean) => {
    setMnsEnabled(enabled);
    // If enabling MNS, fetch and cache domains
    if (enabled) {
      await fetchMnsDomains(userProfile, provider);
    }
  };

  return (
    <PageLayout
      header={<PageHeader title={t('web3.title')} onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6"
    >
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="h-[54px] flex items-center px-4 justify-start w-full border-b border-border">
          <Globe className="text-foreground mr-4" />
          <span className="text-base font-medium text-foreground flex-1 text-left">
            {t('web3.enable_mns')}
          </span>
          <Toggle
            checked={mnsEnabled}
            onChange={handleMnsToggle}
            ariaLabel={t('web3.toggle_mns')}
          />
        </div>
        <div className="px-4 py-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('web3.mns_description')} {t('web3.mns_manage')}{' '}
            <a
              href={mnsUrl || 'https://mns.massa.network/'}
              onClick={e => {
                e.preventDefault();
                openUrl(mnsUrl || 'https://mns.massa.network/');
              }}
              className="text-primary underline hover:text-primary/80"
              aria-label={t('web3.mns_link_label')}
            >
              https://mns.massa
            </a>
            .
          </p>
          <div className="flex items-start gap-3 bg-muted/30 rounded-lg p-3 border border-border">
            <AlertCircle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="flex-1 space-y-2">
              <p className="text-sm font-medium text-foreground">
                {t('web3.privacy_title')}
              </p>
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>
                  <strong>Privacy:</strong> {t('web3.privacy_body')}
                </p>
                <p>
                  <strong>Trust:</strong> {t('web3.trust_body')}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  );
};

export default Web3Settings;
