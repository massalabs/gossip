import React, { useCallback, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { updateContactName } from '../utils';
import { useDiscussionStore } from '../stores/discussionStore';
import ContactAvatar from '../components/avatar/ContactAvatar';
import { useAccountStore } from '../stores/accountStore';
import ContactNameModal from '../components/ui/ContactNameModal';
import Button from '../components/ui/Button';
import PageHeader from '../components/ui/PageHeader';
import UserIdDisplay from '../components/ui/UserIdDisplay';
import { Check, Edit2 } from 'react-feather';
import ShareContact from '../components/settings/ShareContact';
import { UserPublicKeys } from '../assets/generated/wasm/gossip_wasm';

enum ContactView {
  DETAILS = 'DETAILS',
  SHARE_CONTACT = 'SHARE_CONTACT',
}

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
  const [isNameModalOpen, setIsNameModalOpen] = useState(false);
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
  const [activeView, setActiveView] = useState<ContactView>(
    ContactView.DETAILS
  );

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
      <div className="bg-background flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-border border-t-primary rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-muted-foreground">Loading contact…</p>
        </div>
      </div>
    );
  }

  if (activeView === ContactView.SHARE_CONTACT && contactPublicKeys) {
    return (
      <ShareContact
        onBack={() => setActiveView(ContactView.DETAILS)}
        userId={contact.userId}
        userName={displayName || contact.name}
        publicKey={contactPublicKeys}
      />
    );
  }

  const canStart = discussion ? discussion.status === 'active' : true;

  return (
    <div className="bg-background h-full overflow-auto app-max-w mx-auto">
      <PageHeader title="Contact" onBack={() => navigate(-1)} />
      <div className="flex-1 pt-4 px-6 pb-6">
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
            onClick={() => setActiveView(ContactView.SHARE_CONTACT)}
            disabled={!contactPublicKeys}
            variant="outline"
            size="custom"
            fullWidth
            className="h-[46px] rounded-lg bg-card border border-border text-card-foreground font-semibold hover:bg-muted"
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
