import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import BaseModal from '../components/ui/BaseModal';
import Button from '../components/ui/Button';
import { useContactForm } from '../hooks/useContactForm';
import UserIdField from '../components/account/UserIdField';
import NameField from '../components/account/NameField';
import MessageField from '../components/account/MessageField';
import PrivacyNotice from '../components/account/PrivacyNotice';
import ErrorDisplay from '../components/account/ErrorDisplay';
import PageHeader from '../components/ui/PageHeader';
import ScanQRCode from '../components/settings/ScanQRCode';
import { CameraIcon } from '../components/ui/icons';

const NewContact: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [isDiscardModalOpen, setIsDiscardModalOpen] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

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

  // Pre-fill userId and name from URL params (from QR code scan)
  // Use ref to track the last processed URL to prevent re-processing
  const lastProcessedUrl = useRef<string>('');

  useEffect(() => {
    const userIdFromUrl = searchParams.get('userId');
    const nameFromUrl = searchParams.get('name');

    // Create a unique key from the URL params
    const urlKey = `${userIdFromUrl || ''}-${nameFromUrl || ''}`;

    // Only process if URL params changed and we have values
    if (urlKey === lastProcessedUrl.current) return;
    if (!userIdFromUrl) return;

    lastProcessedUrl.current = urlKey;

    // Always update from URL params (they take precedence)
    handleUserIdChange(userIdFromUrl);
    if (nameFromUrl) {
      handleNameChange(nameFromUrl);
    }
  }, [searchParams, handleUserIdChange, handleNameChange]);

  const handleBack = useCallback(() => {
    if (hasUnsavedChanges) {
      setIsDiscardModalOpen(true);
      return;
    }
    navigate('/');
  }, [hasUnsavedChanges, navigate]);

  const handleDiscard = useCallback(() => {
    setIsDiscardModalOpen(false);
    navigate('/');
  }, [navigate]);

  const handleCancel = useCallback(() => {
    setIsDiscardModalOpen(false);
  }, []);

  const handleScanSuccess = useCallback(
    (scannedUserId: string, scannedName?: string) => {
      console.log('handleScanSuccess called with:', {
        scannedUserId,
        scannedName,
      });
      setShowScanner(false);
      // Always update form with scanned data (don't check existing values)
      if (scannedUserId) {
        handleUserIdChange(scannedUserId);
      }
      if (scannedName) {
        console.log('Setting name from scan:', scannedName);
        handleNameChange(scannedName);
      } else {
        console.warn('No name provided in scanned QR code');
      }
    },
    [handleUserIdChange, handleNameChange]
  );

  // Show scanner view if active
  if (showScanner) {
    return (
      <ScanQRCode
        onBack={() => setShowScanner(false)}
        onScanSuccess={handleScanSuccess}
      />
    );
  }

  return (
    <div className="bg-card h-full overflow-auto max-w-md mx-auto">
      <PageHeader title="New contact" onBack={handleBack} />

      {/* Main Form */}
      <div className="px-6 pb-32">
        <div className="bg-card rounded-xl p-6 space-y-5">
          {/* Import Options - File and QR Code */}
          <div className="py-6 border-b border-border">
            <div className="text-center mb-4">
              <p className="text-sm text-muted-foreground mb-4">
                Import contact
              </p>
              <div className="flex gap-3 justify-center">
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  variant="primary"
                  size="md"
                  className="inline-flex items-center gap-2 flex-1 max-w-[140px]"
                  disabled={fileState.isLoading}
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                    />
                  </svg>
                  <span>By file</span>
                </Button>
                <Button
                  onClick={() => setShowScanner(true)}
                  variant="outline"
                  size="md"
                  className="inline-flex items-center gap-2 flex-1 max-w-[140px]"
                >
                  <CameraIcon className="w-5 h-5" />
                  <span>Scan QR</span>
                </Button>
              </div>
            </div>
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
              <p
                className="text-sm text-destructive mt-2 text-center"
                role="alert"
              >
                {fileState.error}
              </p>
            )}
          </div>

          <UserIdField
            userId={userId.value}
            onChange={handleUserIdChange}
            error={userId.error}
            isFetching={userId.loading}
          />

          <NameField
            name={name.value}
            onChange={handleNameChange}
            error={name.error}
          />

          <MessageField
            message={message.value}
            onChange={handleMessageChange}
          />

          <PrivacyNotice />

          <ErrorDisplay error={generalError} />

          {/* Save Button */}
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            loading={isSubmitting}
            fullWidth
            size="md"
            className="h-12 rounded-xl text-base"
          >
            Add contact
          </Button>
        </div>
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
