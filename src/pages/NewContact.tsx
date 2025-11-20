import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import BaseModal from '../components/ui/BaseModal';
import Button from '../components/ui/Button';
import { useContactForm } from '../hooks/useContactForm';
import ImportFileSection from '../components/account/ImportFileSection';
import UserIdField from '../components/account/UserIdField';
import NameField from '../components/account/NameField';
import MessageField from '../components/account/MessageField';
import PrivacyNotice from '../components/account/PrivacyNotice';
import ErrorDisplay from '../components/account/ErrorDisplay';
import PageHeader from '../components/ui/PageHeader';

const NewContact: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [isDiscardModalOpen, setIsDiscardModalOpen] = useState(false);

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
  useEffect(() => {
    const userIdFromUrl = searchParams.get('userId');
    const nameFromUrl = searchParams.get('name');

    if (userIdFromUrl && !userId.value) {
      handleUserIdChange(userIdFromUrl);
    }

    if (nameFromUrl && !name.value) {
      handleNameChange(nameFromUrl);
    }
  }, [
    searchParams,
    userId.value,
    name.value,
    handleUserIdChange,
    handleNameChange,
  ]);

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

  return (
    <div className="bg-card h-full overflow-auto max-w-md mx-auto">
      <PageHeader title="New contact" onBack={handleBack} />

      {/* Main Form */}
      <div className="px-6 pb-32">
        <div className="bg-card rounded-xl p-6 space-y-5">
          <ImportFileSection
            fileInputRef={fileInputRef}
            isImporting={fileState.isLoading}
            onFileImport={handleFileImport}
          />
          {fileState.error && (
            <p className="text-sm text-destructive mt-2" role="alert">
              {fileState.error}
            </p>
          )}

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
