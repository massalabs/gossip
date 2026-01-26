import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import PageLayout from '../../components/ui/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Toggle from '../../components/ui/Toggle';
import { useAppStore } from '../../stores/appStore';
import { useAccountStore } from '../../stores/accountStore';
import { ROUTES } from '../../constants/routes';
import { Globe, AlertCircle } from 'react-feather';
import { resolveDeweb } from '@massalabs/massa-web3';
import { openUrl } from '../../utils/linkUtils';

const Web3Settings: React.FC = () => {
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
        console.error('Failed to resolve mns.massa:', error);
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
      header={<PageHeader title="Web3" onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6"
    >
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="h-[54px] flex items-center px-4 justify-start w-full border-b border-border">
          <Globe className="text-foreground mr-4" />
          <span className="text-base font-medium text-foreground flex-1 text-left">
            Enable MNS
          </span>
          <Toggle
            checked={mnsEnabled}
            onChange={handleMnsToggle}
            ariaLabel="Toggle MNS support"
          />
        </div>
        <div className="px-4 py-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            MNS (Massa Name System) is a decentralized naming service that maps
            human-readable domain names (like "alice.massa") to any data like
            gossip IDs. When enabled, you can use MNS domains to identify and
            contact other users. Create and manage your MNS here:{' '}
            <a
              href={mnsUrl || 'https://mns.massa.network/'}
              onClick={e => {
                e.preventDefault();
                openUrl(mnsUrl || 'https://mns.massa.network/');
              }}
              className="text-primary underline hover:text-primary/80"
              aria-label="https://mns.massa (opens in a new tab)"
            >
              https://mns.massa
            </a>
            .
          </p>
          <div className="flex items-start gap-3 bg-muted/30 rounded-lg p-3 border border-border">
            <AlertCircle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="flex-1 space-y-2">
              <p className="text-sm font-medium text-foreground">
                Privacy & Trust Considerations
              </p>
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>
                  <strong>Privacy:</strong> MNS domains link names to your
                  gossip ID and thus to the MNS owner's Massa address. This
                  creates a public association between your identity and
                  blockchain addresses.
                </p>
                <p>
                  <strong>Trust:</strong> Resolving MNS domains requires
                  trusting the Massa RPC response. The RPC endpoint could
                  potentially provide incorrect or malicious resolution data.
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
