import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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
import { Camera, Upload } from 'react-feather';
import { ROUTES } from '../constants/routes';

const NewContact: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { state } = useLocation();
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

  useEffect(() => {
    if (!state?.userId) return;
    handleUserIdChange(state.userId);
  }, [state?.userId, handleUserIdChange]);

  const handleBack = useCallback(() => {
    if (hasUnsavedChanges) {
      setIsDiscardModalOpen(true);
      return;
    }
    navigate(ROUTES.default());
  }, [hasUnsavedChanges, navigate]);

  const handleDiscard = useCallback(() => {
    setIsDiscardModalOpen(false);
    navigate(ROUTES.default());
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
      <PageHeader title="New contact" onBack={handleBack} />

      {/* Main Form */}
      <div className="bg-card rounded-xl p-6 space-y-5">
        {/* Import Options - File and QR Code */}
        <div className="py-6 border-b border-border">
          <div className="text-center mb-4">
            <p className="text-sm text-muted-foreground mb-4">Import contact</p>
            <div className="flex gap-3 justify-center">
              <Button
                onClick={() => setShowScanner(true)}
                variant="primary"
                size="md"
                className="inline-flex items-center gap-2 flex-1 max-w-[140px]"
              >
                <Camera className="w-5 h-5" />
                <span>Scan QR</span>
              </Button>
              <Button
                onClick={() => fileInputRef.current?.click()}
                variant="outline"
                size="md"
                className="inline-flex items-center gap-2 flex-1 max-w-[140px]"
                disabled={fileState.isLoading}
              >
                <Upload className="w-5 h-5" />
                <span>By file</span>
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

        <MessageField message={message.value} onChange={handleMessageChange} />

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
