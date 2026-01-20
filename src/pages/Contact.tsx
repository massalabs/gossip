import React, { useCallback, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { updateContactName, db } from '../utils';
import { useDiscussionStore } from '../stores/discussionStore';
import { useMessageStore } from '../stores/messageStore';
import ContactAvatar from '../components/avatar/ContactAvatar';
import { useAccountStore } from '../stores/accountStore';
import ContactNameModal from '../components/ui/ContactNameModal';
import Button from '../components/ui/Button';
import PageHeader from '../components/ui/PageHeader';
import PageLayout from '../components/ui/PageLayout';
import UserIdDisplay from '../components/ui/UserIdDisplay';
import BaseModal from '../components/ui/BaseModal';
import { Check, Edit2, Trash2 } from 'react-feather';
import { UserPublicKeys, gossipSdk } from 'gossip-sdk';
import { DiscussionStatus } from '../db';
import { ROUTES } from '../constants/routes';

const Contact: React.FC = () => {
  const { userId } = useParams();
  const [showUserId, setShowUserId] = useState(false);
  const navigate = useNavigate();
  const contact = useDiscussionStore(s =>
    s.contacts.find(c => c.userId === userId)
  );
  const discussion = useDiscussionStore(s =>
    s.discussions.find(d => d.contactUserId === userId)
  );

  // All hooks must be called before early return
  const ownerUserId = useAccountStore(s => s.userProfile?.userId);
  const clearMessages = useMessageStore(s => s.clearMessages);
  const [isNameModalOpen, setIsNameModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [proposedName, setProposedName] = useState(contact?.name || '');
  const [displayName, setDisplayName] = useState(contact?.name || '');
  const [nameError, setNameError] = useState<string | null>(null);

  React.useEffect(() => {
    if (contact) {
      setProposedName(contact.name);
      setDisplayName(contact.name);
    }
  }, [contact]);
  const [showSuccessCheck, setShowSuccessCheck] = useState(false);

  const contactPublicKeys = useMemo(() => {
    if (!contact?.publicKeys) return null;
    try {
      return UserPublicKeys.from_bytes(contact.publicKeys);
    } catch (error) {
      console.error('Failed to decode contact public keys', error);
      return null;
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
      const result = await updateContactName(
        ownerUserId,
        contact.userId,
        name,
        db
      );
      if (!result.success) {
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

  const handleDeleteContact = useCallback(async () => {
    if (!ownerUserId || !contact || !gossipSdk.isSessionOpen) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      const result = await gossipSdk.contacts.delete(
        ownerUserId,
        contact.userId
      );
      if (!result.success) {
        setDeleteError(result.message);
        setIsDeleting(false);
        return;
      }

      // Clear messages from message store
      clearMessages(contact.userId);

      // Navigate back to discussions
      navigate('/discussions');
    } catch (error) {
      console.error('Error deleting contact:', error);
      setDeleteError('Failed to delete contact. Please try again.');
      setIsDeleting(false);
    }
  }, [ownerUserId, contact, clearMessages, navigate]);

  if (!contact) {
    return (
      <div className="bg-background flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-border border-t-primary rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-muted-foreground">Loading contact…</p>
        </div>
      </div>
    );
  }

  const canStart = discussion
    ? discussion.status === DiscussionStatus.ACTIVE
    : true;

  return (
    <PageLayout
      header={<PageHeader title="Contact" onBack={() => navigate(-1)} />}
      className="app-max-w mx-auto"
      contentClassName="pt-4 px-6 pb-6"
    >
      <div className="flex items-center gap-4">
        <ContactAvatar contact={contact} size={14} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-base font-semibold text-foreground truncate">
              {displayName}
            </p>

            <button
              onClick={handleOpenEditName}
              disabled={!canEditName}
              className="shrink-0 p-1 hover:bg-muted rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Edit contact name"
            >
              <Edit2 className="w-4 h-4 text-muted-foreground" />
            </button>
            <div className="flex items-center gap-1">
              {showSuccessCheck && (
                <Check className="w-4 h-4 text-success transition-opacity duration-200" />
              )}
            </div>
          </div>
          <UserIdDisplay
            userId={contact.userId}
            showCopy
            showHideToggle
            visible={showUserId}
            onChange={setShowUserId}
          />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-2">
        <Button
          onClick={() => {
            if (userId) {
              navigate(ROUTES.contactShare({ userId }));
            }
          }}
          disabled={!contactPublicKeys}
          variant="outline"
          size="custom"
          fullWidth
          className="h-[46px] rounded-full bg-card border border-border text-card-foreground font-medium hover:bg-muted"
        >
          Share contact
        </Button>
        {!canStart && (
          <p className="text-xs text-muted-foreground">
            {discussion?.status === 'pending' &&
              'Connection pending. You cannot chat yet.'}
            {discussion?.status === 'closed' && 'This discussion is closed.'}
          </p>
        )}
        <Button
          onClick={() => setIsDeleteModalOpen(true)}
          variant="danger"
          size="custom"
          fullWidth
          className="h-[46px] rounded-full font-medium mt-4"
        >
          <Trash2 className="w-4 h-4 mr-2" />
          Remove contact
        </Button>
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

      <BaseModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          if (!isDeleting) {
            setIsDeleteModalOpen(false);
            setDeleteError(null);
          }
        }}
        title="Remove contact?"
      >
        <div className="space-y-4">
          <p className="text-sm text-foreground">
            Are you sure you want to remove <strong>{displayName}</strong> from
            your contacts? This will also delete all messages and discussions
            with this contact. This action cannot be undone.
          </p>
          {deleteError && (
            <p className="text-sm text-destructive">{deleteError}</p>
          )}
          <div className="flex gap-3">
            <Button
              onClick={handleDeleteContact}
              disabled={isDeleting}
              loading={isDeleting}
              variant="danger"
              size="custom"
              className="flex-1 h-11 rounded-full font-medium"
            >
              {isDeleting ? 'Removing...' : 'Remove'}
            </Button>
            <Button
              onClick={() => {
                setIsDeleteModalOpen(false);
                setDeleteError(null);
              }}
              disabled={isDeleting}
              variant="secondary"
              size="custom"
              className="flex-1 h-11 rounded-full font-medium"
            >
              Cancel
            </Button>
          </div>
        </div>
      </BaseModal>
    </PageLayout>
  );
};

export default Contact;
