import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPublicKeys } from '@massalabs/gossip-sdk';
import { Check, Copy, FileText, Link2, Share2 } from 'react-feather';
import toast from 'react-hot-toast';
import { useFileShareContact } from '../../hooks/useFileShareContact';
import { ROUTES } from '../../constants/routes';
import {
  canShareInvitationViaOtherApp,
  shareInvitation,
  shareQRCode,
} from '../../services/shareService';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/PageLayout';
import Button from '../ui/Button';
import BaseModal from '../ui/BaseModal';
import Notice from '../account/PrivacyNotice';
import { generateDeepLinkUrl } from '../../utils/inviteUrl';
import ShareContactQR from './ShareContactQR';
import Popover from '../ui/Popover';
import { PopoverPosition } from '../utils';

interface ShareContactProps {
  onBack: () => void;
  userId: string;
  userName: string;
  publicKey: UserPublicKeys;
  mnsDomains?: string[];
  showPageFrame?: boolean;
}

const ShareContact: React.FC<ShareContactProps> = ({
  onBack,
  userId,
  userName,
  publicKey,
  mnsDomains,
  showPageFrame = true,
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [isLinkPanelOpen, setIsLinkPanelOpen] = useState(false);
  const [isFilePanelOpen, setIsFilePanelOpen] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [isSharingLink, setIsSharingLink] = useState(false);
  const [isSharingQR, setIsSharingQR] = useState(false);
  const [canShareViaOtherApp, setCanShareViaOtherApp] = useState(false);
  const copiedLinkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const { shareFileContact, fileState } = useFileShareContact();
  const navigate = useNavigate();
  const deepLinkUrl = useMemo(() => generateDeepLinkUrl(userId), [userId]);
  const isExportDisabled = !publicKey || fileState.isLoading;

  const handleShareFile = useCallback(() => {
    if (!publicKey || !userName) return;
    shareFileContact({ userPubKeys: publicKey.to_bytes(), userName });
  }, [shareFileContact, publicKey, userName]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(deepLinkUrl);
      setCopiedLink(true);

      if (copiedLinkTimeoutRef.current) {
        clearTimeout(copiedLinkTimeoutRef.current);
      }

      copiedLinkTimeoutRef.current = setTimeout(() => {
        setCopiedLink(false);
        copiedLinkTimeoutRef.current = null;
      }, 2000);
    } catch (error) {
      console.error('Failed to copy invitation link:', error);
      toast.error('Failed to copy invitation link. Please try again.');
    }
  }, [deepLinkUrl]);

  const handleShareLink = useCallback(async () => {
    try {
      setIsSharingLink(true);
      await shareInvitation({ deepLinkUrl });
    } catch (error) {
      console.error('Failed to share invitation link:', error);
      toast.error('Failed to share invitation link. Please try again.');
    } finally {
      setIsSharingLink(false);
    }
  }, [deepLinkUrl]);

  const handleShareQR = useCallback(async () => {
    if (!qrDataUrl) return;

    try {
      setIsSharingQR(true);
      await shareQRCode({
        qrDataUrl,
        fileName: 'contact-qr-code.png',
      });
    } catch (error) {
      console.error('Failed to share QR code:', error);
      toast.error('Failed to share QR code. Please try again.');
    } finally {
      setIsSharingQR(false);
    }
  }, [qrDataUrl]);

  useEffect(() => {
    setCanShareViaOtherApp(canShareInvitationViaOtherApp());

    return () => {
      if (copiedLinkTimeoutRef.current) {
        clearTimeout(copiedLinkTimeoutRef.current);
      }
    };
  }, []);

  const content = (
    <>
      <Notice
        tone="warning"
        className="mb-4"
        title="Invitation expiry"
        content={
          <>
            Invitations will expire 2 weeks after your last connection to the
            app (except invitations shared by file).{' '}
            <span className="relative inline-flex align-middle ml-1">
              <Popover
                position={PopoverPosition.BOTTOM}
                message="Each time you open the app, invitations validity are renewed
                    if more than 24 hours have passed since the last renewal."
              />
            </span>
          </>
        }
      />

      <ShareContactQR
        deepLinkUrl={deepLinkUrl}
        userId={userId}
        mnsDomains={mnsDomains}
        onQRCodeGenerated={setQrDataUrl}
      />

      <div className="mt-4 grid grid-cols-3 gap-3">
        <button
          type="button"
          onClick={() => setIsLinkPanelOpen(true)}
          className="flex flex-col items-center gap-2"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-card border border-border hover:bg-muted/60 transition-colors">
            <Link2 className="h-5 w-5 text-foreground" />
          </span>
          <span className="text-sm text-muted-foreground">Link</span>
        </button>

        <button
          type="button"
          onClick={handleShareQR}
          disabled={!qrDataUrl || isSharingQR}
          className="flex flex-col items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-card border border-border hover:bg-muted/60 transition-colors">
            <Share2 className="h-5 w-5 text-foreground" />
          </span>
          <span className="text-sm text-muted-foreground">
            {isSharingQR ? 'Sharing...' : 'Share'}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setIsFilePanelOpen(true)}
          className="flex flex-col items-center gap-2"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-card border border-border hover:bg-muted/60 transition-colors">
            <FileText className="h-5 w-5 text-foreground" />
          </span>
          <span className="text-sm text-muted-foreground">File</span>
        </button>
      </div>

      <BaseModal
        isOpen={isLinkPanelOpen}
        onClose={() => setIsLinkPanelOpen(false)}
        title="Invitation link"
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card px-3 py-3 break-all text-sm text-foreground">
            {deepLinkUrl}
          </div>
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-xl"
            onClick={handleCopyLink}
          >
            {copiedLink ? (
              <Check className="w-5 h-5 mr-4 text-success" />
            ) : (
              <Copy className="w-5 h-5 mr-4" />
            )}
            <span
              className={`text-base font-normal flex-1 text-left ${copiedLink ? 'text-success' : ''}`}
            >
              {copiedLink ? 'Invitation Link Copied!' : 'Copy Invitation Link'}
            </span>
          </Button>
          <Button
            variant="outline"
            size="custom"
            className="w-full h-[54px] flex items-center px-4 justify-start rounded-xl"
            onClick={handleShareLink}
            disabled={isSharingLink || !canShareViaOtherApp}
            loading={isSharingLink}
          >
            <Share2 className="w-5 h-5 mr-4" />
            <span className="text-base font-normal flex-1 text-left">
              Share Invitation Link
            </span>
          </Button>
        </div>
      </BaseModal>

      <BaseModal
        isOpen={isFilePanelOpen}
        onClose={() => setIsFilePanelOpen(false)}
        title="Share invitation by file"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Share your profile as a file with people you want to talk to. Your
            contact can import your file from the{' '}
            <button
              type="button"
              onClick={() => navigate(ROUTES.newContact())}
              className="text-primary underline underline-offset-2"
            >
              New Contact
            </button>{' '}
            page.
          </p>
          <p className="text-sm font-semibold text-foreground">
            Compared to other profile sharing mode, the file profile remains
            valid even if you don&apos;t login to the app for more than 2 weeks.
          </p>
          <Button
            onClick={handleShareFile}
            disabled={isExportDisabled}
            loading={fileState.isLoading}
            variant="primary"
            size="custom"
            fullWidth
            className="h-11 rounded-xl text-sm font-normal"
          >
            Share file
          </Button>
          {fileState.error && (
            <div className="text-sm text-destructive text-center">
              {fileState.error}
            </div>
          )}
        </div>
      </BaseModal>
    </>
  );

  if (!showPageFrame) {
    return content;
  }

  return (
    <PageLayout
      header={<PageHeader title="Share Contact" onBack={onBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-4"
    >
      {content}
    </PageLayout>
  );
};

export default ShareContact;
