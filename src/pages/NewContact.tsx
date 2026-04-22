import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import BaseModal from '../components/ui/BaseModal';
import Button from '../components/ui/Button';
import { useContactForm } from '../hooks/useContactForm';
import ErrorDisplay from '../components/account/ErrorDisplay';
import ScanQRCode from '../components/settings/ScanQRCode';

import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { Upload, CheckCircle, Info } from 'react-feather';
import { formatUserId } from '@massalabs/gossip-sdk';
import { USERNAME_MAX_LENGTH } from '../utils/validation';
import QrCodeIcon from '../components/ui/customIcons/QrCodeIcon';
import PageLayout from '../components/ui/Layout/PageLayout';
import PageHeader from '../components/ui/PageHeader';
import ConnectionBanner from '../components/ui/ConnectionBanner';
import Toggle from '../components/ui/Toggle';

const NewContact: React.FC = () => {
  const { t } = useTranslation('contacts');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { state } = useLocation();
  const [isDiscardModalOpen, setIsDiscardModalOpen] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const { userProfile } = useAccountStore();
  const mnsEnabled = useAppStore(s => s.mnsEnabled);

  const {
    generalError,
    name,
    userId,
    message,
    mnsState,
    shareUsername,
    customUsername,
    customUsernameError,
    isSubmitting,
    canSubmit,
    hasUnsavedChanges,
    fileState,
    handleFileImport,
    handleNameChange,
    handleUserIdChange,
    handleMessageChange,
    handleShareUsernameChange,
    handleCustomUsernameChange,
    handleSubmit,
  } = useContactForm();

  const getDefaultMessage = useCallback((): string => {
    if (userProfile?.username) {
      return t('new_contact.default_message', {
        username: userProfile.username,
      });
    }
    return t('new_contact.default_message_anonymous');
  }, [userProfile?.username, t]);

  useEffect(() => {
    if (!state?.userId) return;
    handleUserIdChange(state.userId);
    if (state?.name) {
      handleNameChange(state.name);
    }
  }, [state?.userId, state?.name, handleUserIdChange, handleNameChange]);

  const handleBack = useCallback(() => {
    if (hasUnsavedChanges) {
      setIsDiscardModalOpen(true);
      return;
    }
    navigate(-1);
  }, [hasUnsavedChanges, navigate]);

  const handleDiscard = useCallback(() => {
    setIsDiscardModalOpen(false);
    navigate(-1);
  }, [navigate]);

  const handleCancel = useCallback(() => {
    setIsDiscardModalOpen(false);
  }, []);

  const handleScanSuccess = useCallback(
    (scannedUserId: string, scannedName?: string) => {
      setShowScanner(false);

      handleUserIdChange(scannedUserId);
      if (scannedName) {
        handleNameChange(scannedName);
      }
    },
    [handleUserIdChange, handleNameChange]
  );

  if (showScanner) {
    return (
      <ScanQRCode
        onBack={() => setShowScanner(false)}
        onScanSuccess={handleScanSuccess}
      />
    );
  }

  const isAddDisabled = !canSubmit || isSubmitting;

  const headerContent = (
    <PageHeader
      title={t('new_contact.title')}
      onBack={handleBack}
      rightAction={
        <button
          onClick={handleSubmit}
          className={`font-semibold bg-accent text-primary-foreground px-4 py-1.5 rounded-full transition-colors ${
            isAddDisabled
              ? 'opacity-30 cursor-not-allowed'
              : 'hover:bg-accent/80 active:bg-accent/60'
          }`}
          aria-disabled={isAddDisabled}
          aria-label={t('new_contact.add_contact')}
        >
          {isSubmitting ? t('new_contact.adding') : t('new_contact.add')}
        </button>
      }
    />
  );

  return (
    <PageLayout
      header={headerContent}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 pb-safe-b"
    >
      <ConnectionBanner />
      {/* Input Fields Container */}
      <div className="bg-card rounded-xl border border-border overflow-hidden mb-6">
        {/* Username Field */}
        <div className="px-4 py-4 border-b border-border">
          <input
            id="contact-name"
            type="text"
            value={name.value}
            onChange={e => handleNameChange(e.target.value)}
            placeholder={t('new_contact.username_placeholder')}
            className="w-full bg-transparent text-foreground placeholder-muted-foreground focus:outline-none"
            aria-describedby={name.error ? 'contact-name-error' : undefined}
          />
          {name.error && (
            <p
              id="contact-name-error"
              className="mt-1.5 text-sm text-destructive"
              role="alert"
            >
              {name.error}
            </p>
          )}
        </div>

        {/* Gossip Address Field */}
        <div className="px-4 py-4">
          <div className="relative">
            <input
              id="contact-user-id"
              type="text"
              value={userId.value}
              onChange={e => handleUserIdChange(e.target.value)}
              placeholder={
                mnsEnabled
                  ? t('new_contact.address_mns_placeholder')
                  : t('new_contact.address_placeholder')
              }
              aria-label={
                mnsEnabled
                  ? t('new_contact.address_mns_label')
                  : t('new_contact.address_label')
              }
              className="w-full bg-transparent text-foreground placeholder-muted-foreground focus:outline-none pr-10"
              aria-describedby={
                userId.error
                  ? 'contact-user-id-error'
                  : mnsState.resolvedGossipId
                    ? 'contact-user-id-mns-resolved'
                    : undefined
              }
            />
            {userId.loading && (
              <div className="absolute right-0 top-1/2 -translate-y-1/2">
                <div
                  className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin"
                  aria-label={
                    mnsState.isResolving
                      ? t('new_contact.resolving_mns')
                      : t('new_contact.loading_public_key')
                  }
                />
              </div>
            )}
            {!userId.loading && mnsState.resolvedGossipId && !userId.error && (
              <div className="absolute right-0 top-1/2 -translate-y-1/2">
                <CheckCircle
                  className="w-5 h-5 text-success"
                  aria-label={t('new_contact.mns_resolved')}
                />
              </div>
            )}
          </div>
          {/* MNS Resolution Success */}
          {!userId.error && !userId.loading && mnsState.resolvedGossipId && (
            <div
              id="contact-user-id-mns-resolved"
              className="mt-1.5 text-xs text-success"
              aria-live="polite"
              role="status"
            >
              {t('new_contact.mns_resolved_to', {
                domain: mnsState.resolvedDomain,
                id: formatUserId(mnsState.resolvedGossipId, 6, 4),
              })}
            </div>
          )}
          {userId.error && (
            <p
              id="contact-user-id-error"
              className="mt-1.5 text-sm text-destructive"
              role="alert"
            >
              {userId.error}
            </p>
          )}
        </div>

        {/* Scan QR / Import — alternative ways to fill the address */}
        {!(userId.value.trim() && !userId.error) && (
          <>
            <button
              onClick={() => setShowScanner(true)}
              className="w-full flex items-center gap-3 px-4 py-3 border-t border-border text-accent-soft-foreground hover:bg-muted/50 active:bg-muted transition-colors"
              aria-label={t('new_contact.scan_qr')}
            >
              <QrCodeIcon className="w-5 h-5 shrink-0" />
              <span className="text-sm font-medium">
                {t('new_contact.scan_qr')}
              </span>
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={fileState.isLoading}
              className="w-full flex items-center gap-3 px-4 py-3 border-t border-border text-muted-foreground hover:bg-muted/50 active:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={t('new_contact.import_file')}
            >
              <Upload className="w-5 h-5 shrink-0" />
              <span className="text-sm font-medium">
                {t('new_contact.import_file')}
              </span>
            </button>
          </>
        )}
      </div>

      {/* Request details — share username + message */}
      <div className="bg-card rounded-xl border border-border overflow-hidden mb-6">
        {/* Share username */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="text-sm text-foreground">
            {t('new_contact.share_username')}
          </span>
          <Toggle
            checked={shareUsername}
            onChange={handleShareUsernameChange}
            ariaLabel={t('new_contact.share_username')}
          />
        </div>
        {shareUsername && (
          <div className="px-4 pb-3">
            <input
              type="text"
              value={customUsername}
              onChange={e => handleCustomUsernameChange(e.target.value)}
              placeholder={t('new_contact.share_username_placeholder')}
              className="w-full bg-muted/50 text-foreground placeholder-muted-foreground focus:outline-none rounded-lg px-3 py-2 text-sm"
              aria-label={t('new_contact.share_username_aria')}
              maxLength={USERNAME_MAX_LENGTH}
            />
            {customUsernameError && (
              <p className="mt-1.5 text-sm text-destructive" role="alert">
                {customUsernameError}
              </p>
            )}
          </div>
        )}

        {/* Custom message */}
        <div className="border-t border-border">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm text-foreground">
              {t('new_contact.announcement_label')}
            </span>
            <Toggle
              checked={message.value.length > 0 || showMessage}
              onChange={v => {
                setShowMessage(v);
                if (!v) handleMessageChange('');
              }}
              ariaLabel={t('new_contact.announcement_label')}
            />
          </div>
          {(showMessage || message.value.length > 0) && (
            <div className="px-4 pb-3">
              <textarea
                id="contact-message"
                value={message.value}
                onChange={e => handleMessageChange(e.target.value)}
                placeholder={getDefaultMessage()}
                rows={3}
                maxLength={500}
                className="w-full bg-muted/50 text-foreground placeholder-muted-foreground focus:outline-none resize-none text-sm rounded-lg px-3 py-2"
                aria-label={t('new_contact.announcement_aria')}
              />
              {message.value && (
                <div className="flex items-center justify-end mt-1">
                  <span className="text-xs text-muted-foreground">
                    {message.value.length}/500
                  </span>
                </div>
              )}
              <div className="flex items-start gap-2 mt-2 bg-muted/30 rounded-lg p-2.5">
                <Info className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  <Trans
                    i18nKey="privacy_notice.body"
                    ns="contacts"
                    components={{ strong: <strong /> }}
                  />
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Hidden file input for file import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".yaml,.yml"
        className="hidden"
        onChange={handleFileImport}
        disabled={fileState.isLoading}
        aria-label={t('new_contact.import_file_aria')}
      />
      {fileState.error && (
        <p className="text-sm text-destructive mt-2 text-center" role="alert">
          {fileState.error}
        </p>
      )}

      <ErrorDisplay error={generalError} />

      {/* Discard Modal */}
      <BaseModal
        isOpen={isDiscardModalOpen}
        onClose={handleCancel}
        title={t('discard_modal.title')}
      >
        <div className="space-y-4">
          <p className="text-sm text-foreground">{t('discard_modal.body')}</p>
          <div className="flex gap-3">
            <Button onClick={handleDiscard} variant="danger" className="flex-1">
              {t('discard_modal.discard')}
            </Button>
            <Button onClick={handleCancel} variant="ghost" className="flex-1">
              {t('discard_modal.keep_editing')}
            </Button>
          </div>
        </div>
      </BaseModal>
    </PageLayout>
  );
};

export default NewContact;
