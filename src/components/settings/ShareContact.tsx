import React, { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPublicKeys } from '@massalabs/gossip-sdk';
import { Check, Edit2, FileText, Image, Link2, Send } from 'react-feather';
import { useTranslation } from 'react-i18next';
import { useFileShareContact } from '../../hooks/useFileShareContact';
import { useLinkShare } from '../../hooks/useLinkShare';
import { useQRShare } from '../../hooks/useQRShare';
import { ROUTES } from '../../constants/routes';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/PageLayout';
import Button from '../ui/Button';
import BaseModal from '../ui/BaseModal';
import ContactNameModal from '../ui/ContactNameModal';
import Toggle from '../ui/Toggle';
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
  const { t } = useTranslation('contacts');
  // Note: we keep a single QR/file-sharing view for now, no tab switcher.
  const { qrDataUrl, setQrDataUrl, isSharingQR, handleShareQR } = useQRShare();
  const [isFilePanelOpen, setIsFilePanelOpen] = useState(false);
  const [includeUsername, setIncludeUsername] = useState(true);
  const [sharedUsername, setSharedUsername] = useState(userName);
  const [isUsernameModalOpen, setIsUsernameModalOpen] = useState(false);
  const { shareFileContact, fileState } = useFileShareContact();
  const navigate = useNavigate();
  const deepLinkUrl = useMemo(
    () =>
      generateDeepLinkUrl(userId, includeUsername ? sharedUsername : undefined),
    [userId, includeUsername, sharedUsername]
  );
  const {
    copiedLink,
    isSharingLink,
    canShareViaOtherApp,
    handleCopyLink,
    handleShareLink,
  } = useLinkShare(deepLinkUrl);
  const isExportDisabled = !publicKey || fileState.isLoading;

  const handleShareFile = useCallback(() => {
    if (!publicKey || !userName) return;
    shareFileContact({ userPubKeys: publicKey.to_bytes(), userName });
  }, [shareFileContact, publicKey, userName]);

  const content = (
    <div className="flex flex-col gap-4">
      {/* Hero: QR code */}
      <ShareContactQR
        deepLinkUrl={deepLinkUrl}
        userId={userId}
        mnsDomains={mnsDomains}
        onQRCodeGenerated={setQrDataUrl}
      />

      {/* Include username toggle + editable name */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between h-11 px-3">
          <span className="text-sm text-foreground">Include username</span>
          <Toggle
            checked={includeUsername}
            onChange={setIncludeUsername}
            ariaLabel="Include username in the invite"
          />
        </div>
        {includeUsername && (
          <>
            <div className="border-t border-border" />
            <button
              type="button"
              onClick={() => setIsUsernameModalOpen(true)}
              className="flex items-center justify-between gap-2 h-11 px-3 w-full hover:bg-accent/5 active:scale-[0.98] transition-all"
            >
              <span className="text-sm text-foreground truncate">
                {sharedUsername || userName}
              </span>
              <Edit2 className="w-4 h-4 text-muted-foreground shrink-0" />
            </button>
          </>
        )}
      </div>

      <ContactNameModal
        isOpen={isUsernameModalOpen}
        title="Edit shared username"
        initialName={sharedUsername || userName}
        confirmLabel="Save"
        onConfirm={name => {
          if (name) setSharedUsername(name);
          setIsUsernameModalOpen(false);
        }}
        onClose={() => setIsUsernameModalOpen(false)}
      />

      {/* Actions */}
      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          size="custom"
          className="w-full h-11 flex items-center px-3 rounded-xl"
          onClick={handleCopyLink}
        >
          {copiedLink ? (
            <Check className="w-5 h-5 mr-3 text-success" />
          ) : (
            <Link2 className="w-5 h-5 mr-3" />
          )}
          <span
            className={`text-sm font-normal flex-1 text-left ${copiedLink ? 'text-success' : ''}`}
          >
            {copiedLink ? 'Link copied!' : 'Copy invite link'}
          </span>
        </Button>

        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="outline"
            size="custom"
            className="h-11 flex items-center justify-center gap-2 rounded-xl"
            onClick={canShareViaOtherApp ? handleShareLink : handleShareQR}
            disabled={
              canShareViaOtherApp ? isSharingLink : !qrDataUrl || isSharingQR
            }
            loading={isSharingLink || isSharingQR}
          >
            <Send className="w-4 h-4" />
            <span className="text-sm font-normal">Share</span>
          </Button>

          <Button
            variant="outline"
            size="custom"
            className="h-11 flex items-center justify-center gap-2 rounded-xl"
            onClick={handleShareQR}
            disabled={!qrDataUrl || isSharingQR}
            loading={isSharingQR}
          >
            <Image className="w-4 h-4" />
            <span className="text-sm font-normal">QR</span>
          </Button>

          <Button
            variant="outline"
            size="custom"
            className="h-11 flex items-center justify-center gap-2 rounded-xl"
            onClick={() => setIsFilePanelOpen(true)}
          >
            <FileText className="w-4 h-4" />
            <span className="text-sm font-normal">File</span>
          </Button>
        </div>
      </div>

      {/* Expiry hint */}
      <p className="text-xs text-muted-foreground text-center">
        Invitations expire after 2 weeks. File invitations don&apos;t.{' '}
        <span className="relative inline-flex align-middle ml-0.5">
          <Popover
            position={PopoverPosition.TOP}
            message="Invitations expire 2 weeks after your last connection. Each time you open the app, validity is renewed if more than 24 hours have passed. File invitations never expire."
          />
        </span>
      </p>

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
    </div>
  );

  if (!showPageFrame) {
    return content;
  }

  return (
    <PageLayout
      header={<PageHeader title={t('share_contact')} onBack={onBack} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-4"
    >
      {content}
    </PageLayout>
  );
};

export default ShareContact;
