import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import BaseModal from '../components/ui/BaseModal';
import Button from '../components/ui/Button';
import { useContactForm } from '../hooks/useContactForm';
import ErrorDisplay from '../components/account/ErrorDisplay';
import ScanQRCode from '../components/settings/ScanQRCode';
import { useAccountStore } from '../stores/accountStore';
import { Info, Upload } from 'react-feather';
import QrCodeIcon from '../components/ui/customIcons/QrCodeIcon';

const NewContact: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { state } = useLocation();
  const [isDiscardModalOpen, setIsDiscardModalOpen] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const { userProfile } = useAccountStore();

  const {
    generalError,
    name,
    userId,
    message,
    isSubmitting,
    canSubmit,
    hasUnsavedChanges,
    fileState,
    handleFileImport,
    handleNameChange,
    handleUserIdChange,
    handleMessageChange,
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

  return (
    <div className="bg-background h-full overflow-auto app-max-w mx-auto">
      {/* Custom Header */}
      <div className="px-6 py-4 border-b border-border bg-card">
        <div className="flex items-center justify-between">
          <button
            onClick={handleBack}
            className="text-foreground hover:text-primary transition-colors"
            aria-label="Cancel"
          >
            Cancel
          </button>
          <h1 className="text-xl font-semibold text-foreground">New contact</h1>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || isSubmitting}
            tabIndex={!canSubmit || isSubmitting ? -1 : 0}
            className="text-foreground hover:text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Add contact"
          >
            {isSubmitting ? 'Adding...' : 'Add'}
          </button>
        </div>
      </div>

      {/* Main Form */}
      <div className="px-6 py-6">
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
                placeholder="Gossip address"
                className="w-full bg-transparent text-foreground placeholder-muted-foreground focus:outline-none pr-10"
                aria-describedby={
                  userId.error
                    ? 'contact-user-id-error'
                    : 'contact-user-id-helper'
                }
              />
              {userId.loading && (
                <div className="absolute right-0 top-1/2 -translate-y-1/2">
                  <div
                    className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin"
                    aria-label="Loading public key"
                  />
                </div>
              )}
            </div>
            {!userId.error && !userId.loading && (
              <p
                id="contact-user-id-helper"
                className="mt-1.5 text-xs text-muted-foreground"
              >
                User ID is a unique 32-byte identifier
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
          <textarea
            id="contact-message"
            value={message.value}
            onChange={e => handleMessageChange(e.target.value)}
            placeholder="Contact request message (optional)"
            rows={3}
            maxLength={500}
            className="w-full bg-transparent text-foreground placeholder-muted-foreground focus:outline-none resize-none"
            aria-label="Contact request message (optional)"
          />
          {message.value && (
            <div className="flex items-center justify-between mt-2">
              <button
                type="button"
                onClick={() => handleMessageChange(getDefaultMessage())}
                className="text-xs text-muted-foreground hover:text-primary underline underline-offset-2 transition-colors"
              >
                Use default message
              </button>
              <span className="text-xs text-muted-foreground">
                {message.value.length}/500
              </span>
            </div>
          )}
          {!message.value && (
            <button
              type="button"
              onClick={() => handleMessageChange(getDefaultMessage())}
              className="text-xs text-muted-foreground hover:text-primary underline underline-offset-2 mt-2 transition-colors"
            >
              Use default message
            </button>
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
                decrypted. Use it for introductions or context, but avoid
                sharing sensitive information. Send private details through
                regular messages after the contact accepts your request.
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
      </div>

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
            <Button
              onClick={handleCancel}
              variant="secondary"
              className="flex-1"
            >
              Cancel
            </Button>
          </div>
        </div>
      </BaseModal>
    </div>
  );
};

export default NewContact;
