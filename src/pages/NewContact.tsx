import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import BaseModal from '../components/ui/BaseModal';
import Button from '../components/ui/Button';
import { useContactForm } from '../hooks/useContactForm';
import ErrorDisplay from '../components/account/ErrorDisplay';
import ScanQRCode from '../components/settings/ScanQRCode';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { Info, Upload, CheckCircle } from 'react-feather';
import { formatUserId } from 'gossip-sdk';
import QrCodeIcon from '../components/ui/customIcons/QrCodeIcon';
import PageLayout from '../components/ui/PageLayout';
import PageHeader from '../components/ui/PageHeader';

const NewContact: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { state } = useLocation();
  const [isDiscardModalOpen, setIsDiscardModalOpen] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
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
      return `Hi! I'm ${userProfile.username} and I'd like to connect with you.`;
    }
    return "Hi! I'd like to connect with you.";
  }, [userProfile?.username]);

  useEffect(() => {
    if (!state?.userId) return;
    handleUserIdChange(state.userId);
  }, [state?.userId, handleUserIdChange]);

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
    (scannedUserId: string) => {
      setShowScanner(false);

      handleUserIdChange(scannedUserId);
    },
    [handleUserIdChange]
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
      title="New contact"
      onBack={handleBack}
      rightAction={
        <button
          onClick={handleSubmit}
          className={`text-foreground hover:text-primary transition-colors ${
            isAddDisabled ? 'opacity-50 cursor-not-allowed' : ''
          }`}
          aria-disabled={isAddDisabled}
          aria-label="Add contact"
        >
          {isSubmitting ? 'Adding...' : 'Add'}
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
      {/* Input Fields Container */}
      <div className="bg-card rounded-xl border border-border overflow-hidden mb-6">
        {/* Username Field */}
        <div className="px-4 py-4 border-b border-border">
          <input
            id="contact-name"
            type="text"
            value={name.value}
            onChange={e => handleNameChange(e.target.value)}
            placeholder="Username"
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
                mnsEnabled ? 'Gossip address or name.massa' : 'Gossip address'
              }
              aria-label={
                mnsEnabled
                  ? 'Gossip address or name.massa (MNS domain)'
                  : 'Gossip address'
              }
              className="w-full bg-transparent text-foreground placeholder-muted-foreground focus:outline-none pr-10"
              aria-describedby={
                userId.error
                  ? 'contact-user-id-error'
                  : mnsState.resolvedGossipId
                    ? 'contact-user-id-mns-resolved'
                    : 'contact-user-id-helper'
              }
            />
            {userId.loading && (
              <div className="absolute right-0 top-1/2 -translate-y-1/2">
                <div
                  className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin"
                  aria-label={
                    mnsState.isResolving
                      ? 'Resolving MNS domain'
                      : 'Loading public key'
                  }
                />
              </div>
            )}
            {!userId.loading && mnsState.resolvedGossipId && !userId.error && (
              <div className="absolute right-0 top-1/2 -translate-y-1/2">
                <CheckCircle
                  className="w-5 h-5 text-success"
                  aria-label="MNS domain resolved"
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
              <span className="font-medium">{mnsState.resolvedDomain}</span>{' '}
              resolved to{' '}
              <span className="text-muted-foreground">
                {formatUserId(mnsState.resolvedGossipId, 6, 4)}
              </span>
            </div>
          )}
          {/* Default helper text */}
          {!userId.error && !userId.loading && !mnsState.resolvedGossipId && (
            <p
              id="contact-user-id-helper"
              className="mt-1.5 text-xs text-muted-foreground"
            >
              {mnsEnabled
                ? 'Enter a Gossip ID or MNS domain (e.g., alice.massa)'
                : 'Enter a Gossip ID'}
            </p>
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
      </div>

      {/* Scan QR Code and File Options */}
      <div className="flex gap-3 mb-6">
        <button
          onClick={() => setShowScanner(true)}
          className="flex-1 flex items-center justify-center gap-2 text-primary hover:text-primary/80 transition-colors py-3"
          aria-label="Scan QR code"
        >
          <QrCodeIcon className="w-5 h-5" />
          <span className="text-base font-medium">Scan QR code</span>
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={fileState.isLoading}
          className="flex-1 flex items-center justify-center gap-2 text-muted-foreground hover:text-foreground transition-colors py-3 disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="Import from file"
        >
          <Upload className="w-5 h-5" />
          <span className="text-base font-medium">Import from file</span>
        </button>
      </div>

      {/* Message Field */}
      <div className="bg-card rounded-xl border border-border p-4 mb-6">
        <label
          htmlFor="contact-message"
          className="block text-sm font-medium text-foreground mb-2"
        >
          Announcement message:
        </label>
        <textarea
          id="contact-message"
          value={message.value}
          onChange={e => handleMessageChange(e.target.value)}
          placeholder={getDefaultMessage()}
          rows={3}
          maxLength={500}
          className="w-full bg-transparent text-foreground placeholder-muted-foreground focus:outline-none resize-none"
          aria-label="Announcement message (optional)"
        />
        {message.value && (
          <div className="flex items-center justify-end mt-2">
            <span className="text-xs text-muted-foreground">
              {message.value.length}/500
            </span>
          </div>
        )}
      </div>

      {/* Share Username Section */}
      <div className="bg-card rounded-xl border border-border p-4 mb-6">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={shareUsername}
            onChange={e => handleShareUsernameChange(e.target.checked)}
            className="w-5 h-5 rounded border-border text-primary focus:ring-primary"
          />
          <span className="text-sm font-medium text-foreground">
            Share my username
          </span>
        </label>
        <p className="text-xs text-muted-foreground mt-1 ml-8">
          The recipient will see this name when they receive your request
        </p>
        {shareUsername && (
          <div className="mt-3">
            <input
              type="text"
              value={customUsername}
              onChange={e => handleCustomUsernameChange(e.target.value)}
              placeholder="Enter username to share"
              className="w-full bg-muted/50 text-foreground placeholder-muted-foreground focus:outline-none rounded-lg px-3 py-2 text-sm"
              aria-label="Username to share with contact"
            />
          </div>
        )}
      </div>

      {/* Privacy Notice */}
      <div className="bg-muted/30 border border-border rounded-xl p-4 mb-6">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-xs font-medium text-foreground mb-1">
              Privacy notice
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              This message is sent with your contact request announcement and
              has{' '}
              <span className="font-medium text-foreground">
                reduced privacy
              </span>{' '}
              compared to regular Gossip messages. Unlike regular messages, if
              your keys are compromised in the future, this message could be
              decrypted. Use it for introductions or context, but avoid sharing
              sensitive information. Send private details through regular
              messages after the contact accepts your request.
            </p>
          </div>
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
        aria-label="Import contact from YAML file"
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
        title="Discard changes?"
      >
        <div className="space-y-4">
          <p className="text-sm text-foreground">
            Unsaved changes will be lost.
          </p>
          <div className="flex gap-3">
            <Button onClick={handleDiscard} variant="danger" className="flex-1">
              Discard
            </Button>
            <Button onClick={handleCancel} variant="ghost" className="flex-1">
              Keep editing
            </Button>
          </div>
        </div>
      </BaseModal>
    </PageLayout>
  );
};

export default NewContact;
