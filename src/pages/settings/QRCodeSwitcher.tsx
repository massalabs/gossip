import React, { useCallback, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera } from 'react-feather';
import ShareContact from '../../components/settings/ShareContact';
import ScanQRCode from '../../components/settings/ScanQRCode';
import PageLayout from '../../components/ui/PageLayout';
import PageHeader from '../../components/ui/PageHeader';
import Button from '../../components/ui/Button';
import { useAccountStore } from '../../stores/accountStore';
import { useAppStore } from '../../stores/appStore';
import { ROUTES } from '../../constants/routes';
import { useGossipSdk } from '../../hooks/useGossipSdk';

const QRCodeSwitcher: React.FC = () => {
  const gossip = useGossipSdk();
  const navigate = useNavigate();
  const { userProfile } = useAccountStore();
  const mnsEnabled = useAppStore(s => s.mnsEnabled);
  const mnsDomains = useAppStore(s => s.mnsDomains);
  const [showScanner, setShowScanner] = useState(false);

  const handleBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleScanSuccess = useCallback(
    (scannedUserId: string, scannedName?: string) => {
      navigate(ROUTES.newContact(), {
        state: { userId: scannedUserId, name: scannedName },
      });
    },
    [navigate]
  );

  useEffect(() => {
    if (!userProfile || !gossip.isSessionOpen) {
      navigate(ROUTES.settings());
    }
  }, [userProfile, gossip.isSessionOpen, navigate]);

  if (showScanner) {
    return (
      <ScanQRCode
        onBack={() => setShowScanner(false)}
        onScanSuccess={handleScanSuccess}
      />
    );
  }

  return (
    <PageLayout
      header={
        <PageHeader
          title="Share Contact"
          onBack={handleBack}
          rightAction={
            <Button
              variant="circular"
              size="custom"
              onClick={() => setShowScanner(true)}
              ariaLabel="Scan QR code"
              className="w-9 h-9 bg-accent hover:bg-accent/80 flex items-center justify-center"
            >
              <Camera className="w-5 h-5 text-accent-foreground" />
            </Button>
          }
        />
      }
      className="app-max-w mx-auto"
      contentClassName="px-6 py-4"
    >
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
    </PageLayout>
  );
};

export default QRCodeSwitcher;
