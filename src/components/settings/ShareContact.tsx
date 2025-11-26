import React, { useState, useCallback } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import { useFileShareContact } from '../../hooks/useFileShareContact';
import PageHeader from '../ui/PageHeader';
import Button from '../ui/Button';
import TabSwitcher from '../ui/TabSwitcher';
import { generateQRCodeUrl } from '../../utils/qrCodeUrl';
import { CopyIcon, CheckIcon } from '../ui/icons';

interface ShareContactProps {
  onBack: () => void;
  pregeneratedQR: string;
}

type ShareTab = 'qr' | 'files';

const ShareContact: React.FC<ShareContactProps> = ({
  onBack,
  pregeneratedQR,
}) => {
  const [activeTab, setActiveTab] = useState<ShareTab>('qr');
  const { ourPk, userProfile } = useAccountStore();
  const { exportFileContact, fileState } = useFileShareContact();
  const [copiedUserId, setCopiedUserId] = useState(false);
  const [copiedQRUrl, setCopiedQRUrl] = useState(false);

  const handleCopyUserId = useCallback(async () => {
    if (!userProfile?.userId) return;
    try {
      await navigator.clipboard.writeText(userProfile.userId);
      setCopiedUserId(true);
      setTimeout(() => setCopiedUserId(false), 2000);
    } catch (err) {
      console.error('Failed to copy user ID:', err);
    }
  }, [userProfile?.userId]);

  const handleCopyQRUrl = useCallback(async () => {
    if (!userProfile?.userId) return;
    try {
      const qrUrl = generateQRCodeUrl(userProfile.userId);
      await navigator.clipboard.writeText(qrUrl);
      setCopiedQRUrl(true);
      setTimeout(() => setCopiedQRUrl(false), 2000);
    } catch (err) {
      console.error('Failed to copy QR code URL:', err);
    }
  }, [userProfile?.userId]);

  if (!userProfile) return null;

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

          {/* Tab content */}
          {activeTab === 'qr' && (
            <div className="flex justify-center py-8">
              <img
                src={pregeneratedQR}
                alt="Your contact QR code"
                className="w-[300px] h-[300px]"
              />
            </div>
          )}

          {activeTab === 'files' && (
            <div className="bg-card rounded-lg p-6">
              <div className="text-center mb-6">
                <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mx-auto mb-4">
                  <svg
                    className="w-6 h-6 text-primary"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    />
                  </svg>
                </div>
                <h4 className="text-lg font-semibold text-foreground mb-2">
                  Share with file
                </h4>
                <p className="text-sm text-muted-foreground mb-6">
                  Download your profile file and share it with people you want
                  to talk to.
                </p>
              </div>

              <Button
                onClick={() => {
                  if (!ourPk || !userProfile?.username) return;
                  exportFileContact({
                    userPubKeys: ourPk.to_bytes(),
                    userName: userProfile.username,
                  });
                }}
                disabled={!ourPk || fileState.isLoading}
                loading={fileState.isLoading}
                variant="primary"
                size="custom"
                fullWidth
                className="h-11 rounded-xl text-sm font-medium"
              >
                {!fileState.isLoading && (
                  <>
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                      />
                    </svg>
                    <span>Download</span>
                  </>
                )}
              </Button>

              {fileState.error && (
                <div className="mt-4 text-sm text-destructive text-center">
                  {fileState.error}
                </div>
              )}
            </div>
          )}

          {/* Copy buttons section */}
          <div className="space-y-2 mt-10">
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-lg"
              onClick={handleCopyUserId}
            >
              {copiedUserId ? (
                <CheckIcon className="w-5 h-5 mr-4 text-success" />
              ) : (
                <CopyIcon className="w-5 h-5 mr-4" />
              )}
              <span
                className={`text-base font-semibold flex-1 text-left ${copiedUserId ? 'text-success' : ''}`}
              >
                {copiedUserId ? 'User ID Copied!' : 'Copy User ID'}
              </span>
            </Button>
            <Button
              variant="outline"
              size="custom"
              className="w-full h-[54px] flex items-center px-4 justify-start rounded-lg"
              onClick={handleCopyQRUrl}
            >
              {copiedQRUrl ? (
                <CheckIcon className="w-5 h-5 mr-4 text-success" />
              ) : (
                <CopyIcon className="w-5 h-5 mr-4" />
              )}
              <span
                className={`text-base font-semibold flex-1 text-left ${copiedQRUrl ? 'text-success' : ''}`}
              >
                {copiedQRUrl ? 'QR Code URL Copied!' : 'Copy QR Code Invite'}
              </span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ShareContact;
