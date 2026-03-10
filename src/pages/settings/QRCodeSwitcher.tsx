import React, { useCallback, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ShareContact from '../../components/settings/ShareContact';
import ScanQRCode from '../../components/settings/ScanQRCode';
import PageLayout from '../../components/ui/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import TabSwitcher from '../../components/ui/TabSwitcher';
import { useAccountStore } from '../../stores/accountStore';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';
import { useGossipSdk } from '../../hooks/useGossipSdk';

type QRCodeSwitcherTab = 'our-code' | 'scan-code';

const QRCodeSwitcher: React.FC = () => {
  const gossip = useGossipSdk();
  const navigate = useNavigate();
  const { userProfile } = useAccountStore();
  const mnsEnabled = useAppStore(s => s.mnsEnabled);
  const mnsDomains = useAppStore(s => s.mnsDomains);
  const [activeTab, setActiveTab] = useState<QRCodeSwitcherTab>('our-code');

  const handleBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleScanSuccess = useCallback(
    (scannedUserId: string) => {
      navigate(ROUTES.newContact(), { state: { userId: scannedUserId } });
    },
    [navigate]
  );

  useEffect(() => {
    if (!userProfile || !gossip.isSessionOpen) {
      navigate(ROUTES.settings());
    }
  }, [userProfile, gossip.isSessionOpen, navigate]);

  return (
    <PageLayout
      header={<PageHeader title="Share Contact" onBack={handleBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-4"
    >
      <div className="mb-4">
        <TabSwitcher
          options={[
            { value: 'our-code', label: 'Code' },
            { value: 'scan-code', label: 'Scan' },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />
      </div>

      {activeTab === 'our-code' ? (
        <ShareContact
          onBack={handleBack}
          userId={userProfile?.userId ?? ''}
          userName={userProfile?.username ?? ''}
          publicKey={gossip.publicKeys}
          mnsDomains={
            mnsEnabled && mnsDomains.length > 0 ? mnsDomains : undefined
          }
          showPageFrame={false}
        />
      ) : (
        <ScanQRCode
          onBack={() => setActiveTab('our-code')}
          onScanSuccess={handleScanSuccess}
        />
      )}
    </PageLayout>
  );
};

export default QRCodeSwitcher;
