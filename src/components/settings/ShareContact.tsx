import React, { useState, useCallback, useMemo } from 'react';
import { useFileShareContact } from '../../hooks/useFileShareContact';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/PageLayout';
import TabSwitcher from '../ui/TabSwitcher';
import { generateDeepLinkUrl } from '../../utils/inviteUrl';
import { UserPublicKeys } from '@massalabs/gossip-sdk';
import ShareContactQR from './ShareContactQR';
import ShareContactCopySection from './ShareContactCopySection';
import ShareContactFileSection from './ShareContactFileSection';

interface ShareContactProps {
  onBack: () => void;
  userId: string;
  userName: string;
  publicKey: UserPublicKeys;
  mnsDomains?: string[];
}

type ShareTab = 'qr' | 'files';

const ShareContact: React.FC<ShareContactProps> = ({
  onBack,
  userId,
  userName,
  publicKey,
  mnsDomains,
}) => {
  const [activeTab, setActiveTab] = useState<ShareTab>('qr');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
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
    <PageLayout
      header={<PageHeader title="Share Contact" onBack={onBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-4"
    >
      {/* Tab switcher */}
      <div className="mb-3">
        <TabSwitcher
          options={[
            { value: 'qr', label: 'Share Invitation' },
            { value: 'files', label: 'File' },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />
      </div>

      <div className={activeTab === 'qr' ? 'block' : 'hidden'}>
        <ShareContactQR
          deepLinkUrl={deepLinkUrl}
          userId={userId}
          mnsDomains={mnsDomains}
          onQRCodeGenerated={setQrDataUrl}
        />
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
      <div className="mt-4">
        <ShareContactCopySection
          deepLinkUrl={deepLinkUrl}
          qrDataUrl={qrDataUrl}
        />
      </div>
    </PageLayout>
  );
};

export default ShareContact;
