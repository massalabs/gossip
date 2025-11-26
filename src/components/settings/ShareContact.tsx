import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
} from 'react';
import { useFileShareContact } from '../../hooks/useFileShareContact';
import PageHeader from '../ui/PageHeader';
import Button from '../ui/Button';
import TabSwitcher from '../ui/TabSwitcher';
import { generateDeepLinkUrl } from '../../utils/qrCodeUrl';
import { CopyIcon, CheckIcon, DownloadIcon } from '../ui/icons';
import { UserPublicKeys } from '../../assets/generated/wasm/gossip_wasm';
import ShareContactQR from './ShareContactQR';

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
  const [copiedUserId, setCopiedUserId] = useState(false);
  const [copiedQRUrl, setCopiedQRUrl] = useState(false);
  const userIdTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qrUrlTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deepLinkUrl = useMemo(() => generateDeepLinkUrl(userId), [userId]);
  const isExportDisabled = !publicKey || fileState.isLoading;

  const handleCopyUserId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setCopiedUserId(true);
      if (userIdTimeoutRef.current) {
        clearTimeout(userIdTimeoutRef.current);
      }
      userIdTimeoutRef.current = setTimeout(() => {
        setCopiedUserId(false);
        userIdTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy user ID:', err);
    }
  }, [userId]);

  const handleCopyQRUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(deepLinkUrl);
      setCopiedQRUrl(true);
      if (qrUrlTimeoutRef.current) {
        clearTimeout(qrUrlTimeoutRef.current);
      }
      qrUrlTimeoutRef.current = setTimeout(() => {
        setCopiedQRUrl(false);
        qrUrlTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy QR code URL:', err);
    }
  }, [deepLinkUrl]);

  useEffect(() => {
    return () => {
      if (userIdTimeoutRef.current) {
        clearTimeout(userIdTimeoutRef.current);
      }
      if (qrUrlTimeoutRef.current) {
        clearTimeout(qrUrlTimeoutRef.current);
      }
    };
  }, []);

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

          {activeTab === 'files' && (
            <div className="bg-card rounded-lg p-6">
              <div className="text-center mb-6">
                <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mx-auto mb-4">
                  <DownloadIcon className="w-6 h-6 text-primary" />
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
                onClick={handleExportFile}
                disabled={isExportDisabled}
                loading={fileState.isLoading}
                variant="primary"
                size="custom"
                fullWidth
                className="h-11 rounded-xl text-sm font-medium"
              >
                <DownloadIcon />
                <span>Download</span>
              </Button>

              {fileState.error && (
                <div className="mt-4 text-sm text-destructive text-center">
                  {fileState.error}
                </div>
              )}
            </div>
          )}

          {/* Copy buttons section */}
          <div className="mt-10 flex flex-col gap-2">
            <Button variant="outline" onClick={handleCopyUserId}>
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
            <Button variant="outline" onClick={handleCopyQRUrl}>
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
