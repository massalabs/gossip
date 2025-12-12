import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import HeaderWrapper from '../../components/ui/HeaderWrapper';
import PageHeader from '../../components/ui/PageHeader';
import ScrollableContent from '../../components/ui/ScrollableContent';
import Button from '../../components/ui/Button';
import { useAccountStore } from '../../stores/accountStore';
import { ROUTES } from '../../constants/routes';
import { Copy, Settings as SettingsIconFeather, Camera } from 'react-feather';
import AccountBackup from '../../components/account/AccountBackup';
import ShareContact from '../../components/settings/ShareContact';
import ScanQRCode from '../../components/settings/ScanQRCode';

enum AccountView {
  MAIN = 'MAIN',
  BACKUP = 'BACKUP',
  SHARE = 'SHARE',
  SCAN = 'SCAN',
}

const AccountSettings: React.FC = () => {
  const navigate = useNavigate();
  const { userProfile, getMnemonicBackupInfo, ourPk } = useAccountStore();
  const [activeView, setActiveView] = useState<AccountView>(AccountView.MAIN);
  const mnemonicBackupInfo = getMnemonicBackupInfo();

  const handleBack = useCallback(() => {
    if (activeView !== AccountView.MAIN) {
      setActiveView(AccountView.MAIN);
    } else {
      navigate(ROUTES.settings());
    }
  }, [activeView, navigate]);

  const handleScanSuccess = useCallback(
    (userId: string) => {
      navigate(ROUTES.newContact(), {
        state: { userId },
        replace: true,
      });
    },
    [navigate]
  );

  if (activeView === AccountView.BACKUP) {
    return <AccountBackup onBack={handleBack} />;
  }

  if (activeView === AccountView.SHARE) {
    return (
      <ShareContact
        onBack={handleBack}
        userId={userProfile!.userId}
        userName={userProfile!.username}
        publicKey={ourPk!}
      />
    );
  }

  if (activeView === AccountView.SCAN) {
    return (
      <ScanQRCode onBack={handleBack} onScanSuccess={handleScanSuccess} />
    );
  }

  return (
    <div className="h-full flex flex-col bg-background app-max-w mx-auto">
      <HeaderWrapper>
        <PageHeader title="Account" onBack={handleBack} />
      </HeaderWrapper>
      <ScrollableContent className="flex-1 overflow-y-auto px-6 py-6">
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border last:border-b-0"
            onClick={() => setActiveView(AccountView.BACKUP)}
          >
            <Copy className="mr-4" />
            <span className="text-base font-semibold flex-1 text-left">
              Account Backup
            </span>
            {mnemonicBackupInfo?.backedUp && (
              <div className="w-2 h-2 bg-success rounded-full ml-auto"></div>
            )}
          </Button>
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0 border-b border-border last:border-b-0"
            onClick={() => setActiveView(AccountView.SHARE)}
          >
            <SettingsIconFeather className="mr-4" />
            <span className="text-base font-semibold flex-1 text-left">
              Share Contact
            </span>
          </Button>
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-none border-0"
            onClick={() => setActiveView(AccountView.SCAN)}
          >
            <Camera className="mr-4" />
            <span className="text-base font-semibold flex-1 text-left">
              Scan QR Code
            </span>
          </Button>
        </div>
      </ScrollableContent>
    </div>
  );
};

export default AccountSettings;

