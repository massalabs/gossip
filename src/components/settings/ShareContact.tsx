import React, { useState } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import { useFileShareContact } from '../../hooks/useFileShareContact';
import PageHeader from '../ui/PageHeader';
import Button from '../ui/Button';
import TabSwitcher from '../ui/TabSwitcher';
// import { generateQRCodeUrl } from '../../utils/qrCodeUrl';

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

  if (!userProfile) return null;

  return (
    <div className="bg-card h-full overflow-auto max-w-md mx-auto">
      <div className="max-w-md mx-auto">
        <PageHeader title="Share Contact" onBack={onBack} />

        <div className="px-4 pb-20 space-y-6">
          <div className="bg-card rounded-lg p-6">
            <TabSwitcher
              options={[
                { value: 'qr', label: 'Scan QR code' },
                { value: 'files', label: 'File' },
              ]}
              value={activeTab}
              onChange={setActiveTab}
            />
          </div>

          {activeTab === 'qr' && (
            <div className="flex justify-center">
              <img
                src={pregeneratedQR}
                alt="Your contact QR code"
                className="w-[300px] h-[300px]"
              />
            </div>
          )}

          {activeTab === 'files' && (
            <div className="relative">
              <div className="bg-card rounded-lg p-6">
                <div className="text-center mb-6">
                  <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mx-auto mb-3">
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
                  <p className="text-sm text-muted-foreground mb-4">
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ShareContact;
