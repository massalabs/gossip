import React, { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPublicKeys } from '@massalabs/gossip-sdk';
import {
  Check,
  Edit2,
  Eye,
  EyeOff,
  FileText,
  Image,
  Link2,
  Send,
} from 'react-feather';
import { Trans, useTranslation } from 'react-i18next';
import { useFileShareContact } from '../../hooks/useFileShareContact';
import { useLinkShare } from '../../hooks/useLinkShare';
import { useQRShare } from '../../hooks/useQRShare';
import { ROUTES } from '../../constants/routes';
import PageHeader from '../ui/PageHeader';
import PageLayout from '../ui/Layout/PageLayout';
import Button from '../ui/Button';
import BaseModal from '../ui/BaseModal';
import ContactNameModal from '../ui/ContactNameModal';
import { generateDeepLinkUrl } from '../../utils/invite';
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
  // Whether the sharing subject is the current user's own profile.
  // When false, the invite greeting uses the contact's name rather than "me".
  isOwnContact?: boolean;
}

const ShareContact: React.FC<ShareContactProps> = ({
  onBack,
  userId,
  userName,
  publicKey,
  mnsDomains,
  showPageFrame = true,
  isOwnContact = true,
}) => {
  const { t } = useTranslation('contacts');
  // Note: we keep a single QR/file-sharing view for now, no tab switcher.
  const { qrDataUrl, setQrDataUrl, isSharingQR, qrShareSource, handleShareQR } =
    useQRShare();
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
  } = useLinkShare(deepLinkUrl, isOwnContact ? undefined : sharedUsername);
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

      {/* Username row: Eye toggles inclusion, pencil edits the name */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center gap-2 h-12 px-3">
          <span
            className={`flex-1 text-sm truncate transition-colors ${
              includeUsername
                ? 'text-foreground font-medium'
                : 'text-muted-foreground/70 line-through'
            }`}
          >
            {sharedUsername || userName}
          </span>
          <button
            type="button"
            onClick={() => setIncludeUsername(!includeUsername)}
            className="p-2 rounded-full hover:bg-muted transition-colors"
            aria-label={
              includeUsername
                ? t('share.hide_username')
                : t('share.include_username')
            }
          >
            {includeUsername ? (
              <Eye className="w-4 h-4 text-foreground" />
            ) : (
              <EyeOff className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setIsUsernameModalOpen(true)}
            disabled={!includeUsername}
            className="p-2 rounded-full hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={t('share.edit_username')}
          >
            <Edit2 className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      <ContactNameModal
        isOpen={isUsernameModalOpen}
        title={t('share.edit_shared_username')}
        initialName={sharedUsername || userName}
        confirmLabel={t('common:save')}
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
            {copiedLink ? t('share.link_copied') : t('share.copy_invite_link')}
          </span>
        </Button>

        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="outline"
            size="custom"
            className="h-11 flex items-center justify-center gap-2 rounded-xl"
            onClick={
              canShareViaOtherApp
                ? handleShareLink
                : () => void handleShareQR('share')
            }
            disabled={
              canShareViaOtherApp ? isSharingLink : !qrDataUrl || isSharingQR
            }
            loading={
              canShareViaOtherApp ? isSharingLink : qrShareSource === 'share'
            }
          >
            <Send className="w-4 h-4" />
            <span className="text-sm font-normal">{t('common:share')}</span>
          </Button>

          <Button
            variant="outline"
            size="custom"
            className="h-11 flex items-center justify-center gap-2 rounded-xl"
            onClick={() => void handleShareQR('qr')}
            disabled={!qrDataUrl || isSharingQR}
            loading={qrShareSource === 'qr'}
          >
            <Image className="w-4 h-4" />
            <span className="text-sm font-normal">{t('share.qr')}</span>
          </Button>

          <Button
            variant="outline"
            size="custom"
            className="h-11 flex items-center justify-center gap-2 rounded-xl"
            onClick={() => setIsFilePanelOpen(true)}
          >
            <FileText className="w-4 h-4" />
            <span className="text-sm font-normal">{t('file')}</span>
          </Button>
        </div>
      </div>

      {/* Expiry hint: must be div — Popover contains block nodes */}
      <div className="text-xs text-muted-foreground text-center">
        {t('share.expiry_hint')}{' '}
        <span className="relative inline-flex align-middle ml-0.5">
          <Popover
            position={PopoverPosition.TOP}
            message={t('share.expiry_popover')}
          />
        </span>
      </div>

      <BaseModal
        isOpen={isFilePanelOpen}
        onClose={() => setIsFilePanelOpen(false)}
        title={t('share.file_modal_title')}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            <Trans
              i18nKey="share.file_modal_body"
              ns="contacts"
              components={{
                newContactLink: (
                  <button
                    type="button"
                    onClick={() => navigate(ROUTES.newContact())}
                    className="text-primary underline underline-offset-2"
                  />
                ),
              }}
            />
          </p>
          <p className="text-sm font-semibold text-foreground">
            {t('share.file_modal_note')}
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
            {t('share.share_file')}
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
