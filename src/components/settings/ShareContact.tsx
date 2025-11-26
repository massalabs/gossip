import React, { useState, useCallback, useMemo } from 'react';
import { useFileShareContact } from '../../hooks/useFileShareContact';
import PageHeader from '../ui/PageHeader';
import TabSwitcher from '../ui/TabSwitcher';
import { generateDeepLinkUrl } from '../../utils/qrCodeUrl';
import { UserPublicKeys } from '../../assets/generated/wasm/gossip_wasm';
import ShareContactQR from './ShareContactQR';
import ShareContactCopySection from './ShareContactCopySection';
import ShareContactFileSection from './ShareContactFileSection';

interface ShareContactProps {
  onBack: () => void;
  userId: string;
  userName: string;
  publicKey: UserPublicKeys;
}

type ShareTab = 'qr' | 'files';

const ShareContact: React.FC<ShareContactProps> = ({
  onBack,
  userId,
  userName,
  publicKey,
}) => {
  const [activeTab, setActiveTab] = useState<ShareTab>('qr');
  const { exportFileContact, fileState } = useFileShareContact();
  const deepLinkUrl = useMemo(() => generateDeepLinkUrl(userId), [userId]);
  const isExportDisabled = !publicKey || fileState.isLoading;

  const handleExportFile = useCallback(() => {
    if (!publicKey || !userName) return;

    exportFileContact({
      userPubKeys: publicKey.to_bytes(),
      userName,
    });
  }, [exportFileContact, publicKey, userName]);

  return (
    <div className="bg-card h-full overflow-auto max-w-md mx-auto">
      <div className="max-w-md mx-auto">
        <PageHeader title="Share Contact" onBack={onBack} />

        <div className="px-4 pb-20 pt-4">
          {/* Tab switcher */}
          <div className="bg-card rounded-lg p-6 mb-8">
            <TabSwitcher
              options={[
                { value: 'qr', label: 'Scan QR code' },
                { value: 'files', label: 'File' },
              ]}
              value={activeTab}
              onChange={setActiveTab}
            />
          </div>

          <div className={activeTab === 'qr' ? 'block' : 'hidden'}>
            <ShareContactQR deepLinkUrl={deepLinkUrl} />
          </div>

          <div className={activeTab === 'files' ? 'block' : 'hidden'}>
            <ShareContactFileSection
              disabled={isExportDisabled}
              isLoading={fileState.isLoading}
              error={fileState.error}
              onExport={handleExportFile}
            />
          </div>

          {/* Copy buttons section */}
          <div className="mt-10">
            <ShareContactCopySection
              userId={userId}
              deepLinkUrl={deepLinkUrl}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ShareContact;
