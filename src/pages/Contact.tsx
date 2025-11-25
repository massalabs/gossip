import React, { useCallback, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { updateContactName, formatUserId } from '../utils';
import { useDiscussionStore } from '../stores/discussionStore';
import ContactAvatar from '../components/avatar/ContactAvatar';
import { useFileShareContact } from '../hooks/useFileShareContact';
import { useAccountStore } from '../stores/accountStore';
import ContactNameModal from '../components/ui/ContactNameModal';
import Button from '../components/ui/Button';
import CopyClipboard from '../components/ui/CopyClipboard';
import PageHeader from '../components/ui/PageHeader';

const Contact: React.FC = () => {
  const { userId } = useParams();
  const navigate = useNavigate();
  const contact = useDiscussionStore(s =>
    s.contacts.find(c => c.userId === userId)
  );
  const discussion = useDiscussionStore(s =>
    s.discussions.find(d => d.contactUserId === userId)
  );

  // All hooks must be called before early return
  const { exportFileContact, fileState } = useFileShareContact();
  const ownerUserId = useAccountStore(s => s.userProfile?.userId);
  const [isNameModalOpen, setIsNameModalOpen] = useState(false);
  const [proposedName, setProposedName] = useState(contact?.name || '');
  const [displayName, setDisplayName] = useState(contact?.name || '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [showSuccessCheck, setShowSuccessCheck] = useState(false);

  // Update state when contact changes
  React.useEffect(() => {
    if (contact) {
      setProposedName(contact.name);
      setDisplayName(contact.name);
    }
  }, [contact]);

  const canEditName = useMemo(() => !!ownerUserId, [ownerUserId]);

  const handleOpenEditName = useCallback(() => {
    setProposedName(displayName || '');
    setNameError(null);
    setIsNameModalOpen(true);
  }, [displayName]);

  const handleSaveName = useCallback(
    async (name: string) => {
      if (!ownerUserId || !contact) return;
      const result = await updateContactName(ownerUserId, contact.userId, name);
      if (!result.ok) {
        setNameError(result.message);
        return;
      }
      setDisplayName(result.trimmedName);
      setIsNameModalOpen(false);
      setShowSuccessCheck(true);
    },
    [ownerUserId, contact]
  );

  // Hide success check after 3 seconds
  React.useEffect(() => {
    if (showSuccessCheck) {
      const timer = setTimeout(() => {
        setShowSuccessCheck(false);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [showSuccessCheck]);

  if (!contact) {
    return (
      <div className="bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-gray-300 dark:border-gray-700 border-t-blue-600 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Loading contact…
          </p>
        </div>
      </div>
    );
  }

  const canStart = discussion ? discussion.status === 'active' : true;

  return (
    <div className="bg-card h-full overflow-auto max-w-md mx-auto">
      <PageHeader title="Contact" onBack={() => navigate(-1)} />
      <div className="flex-1 pt-4 px-6 pb-6">
        <div className="flex items-center gap-4">
          <ContactAvatar contact={contact} size={14} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-base font-semibold text-gray-900 dark:text-white truncate">
                {displayName}
              </p>

              <button
                onClick={handleOpenEditName}
                disabled={!canEditName}
                className="shrink-0 p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Edit contact name"
              >
                <svg
                  className="w-4 h-4 text-gray-500 dark:text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                  />
                </svg>
              </button>
              <div className="flex items-center gap-1">
                {showSuccessCheck && (
                  <svg
                    className="w-4 h-4 text-green-500 transition-opacity duration-200"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {formatUserId(contact.userId)}
              </p>
              <CopyClipboard text={contact.userId} title="Copy user ID" />
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-2">
          <Button
            onClick={() =>
              exportFileContact({
                userPubKeys: contact.publicKeys,
                userName: contact.name,
              })
            }
            disabled={fileState.isLoading}
            variant="outline"
            size="custom"
            fullWidth
            className="h-[46px] rounded-lg bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-black dark:text-white font-semibold hover:bg-gray-50 dark:hover:bg-gray-600"
          >
            Export contact (.yaml)
          </Button>
          {!canStart && (
            <p className="text-xs text-gray-600 dark:text-gray-400">
              {discussion?.status === 'pending' &&
                'Connection pending. You cannot chat yet.'}
              {discussion?.status === 'closed' && 'This discussion is closed.'}
            </p>
          )}
          {fileState.error && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {fileState.error}
            </p>
          )}
        </div>
      </div>
      <ContactNameModal
        isOpen={isNameModalOpen}
        onClose={() => setIsNameModalOpen(false)}
        title="Edit contact name"
        initialName={proposedName}
        confirmLabel="Save"
        error={nameError}
        onConfirm={async name => {
          if (name == null) {
            setNameError('Name cannot be empty.');
            return;
          }
          await handleSaveName(name);
        }}
      />
    </div>
  );
};

export default Contact;
