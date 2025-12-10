import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDiscussionStore } from '../stores/discussionStore';
import { updateDiscussionName } from '../utils';
import ContactAvatar from '../components/avatar/ContactAvatar';
import ContactNameModal from '../components/ui/ContactNameModal';
import Button from '../components/ui/Button';
import PageHeader from '../components/ui/PageHeader';
import { Check, Edit2, ChevronRight } from 'react-feather';
import { Contact } from '../db';
import { ROUTES } from '../constants/routes';

const DiscussionSettings: React.FC = () => {
  const { discussionId } = useParams();
  const navigate = useNavigate();

  const discussions = useDiscussionStore(s => s.discussions);
  const contacts = useDiscussionStore(s => s.contacts);

  const discussion = useMemo(() => {
    if (!discussionId) return undefined;
    const id = parseInt(discussionId, 10);
    return discussions.find(d => d.id === id);
  }, [discussionId, discussions]);

  // For now, we have a single contact per discussion
  // This array structure supports future group discussions
  const participants: Contact[] = useMemo(() => {
    if (!discussion) return [];
    const contact = contacts.find(c => c.userId === discussion.contactUserId);
    return contact ? [contact] : [];
  }, [discussion, contacts]);

  // Display name logic: customName takes priority over contact name
  const displayName = useMemo(() => {
    if (discussion?.customName) return discussion.customName;
    if (participants.length === 1) return participants[0].name;
    if (participants.length > 1) {
      return participants.map(p => p.name).join(', ');
    }
    return 'Unknown';
  }, [discussion?.customName, participants]);

  const [isNameModalOpen, setIsNameModalOpen] = useState(false);
  const [proposedName, setProposedName] = useState(displayName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [showSuccessCheck, setShowSuccessCheck] = useState(false);

  // Sync proposed name when display name changes
  useEffect(() => {
    setProposedName(displayName);
  }, [displayName]);

  // Hide success check after 3 seconds
  useEffect(() => {
    if (showSuccessCheck) {
      const timer = setTimeout(() => {
        setShowSuccessCheck(false);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [showSuccessCheck]);

  const handleOpenEditName = useCallback(() => {
    setProposedName(discussion?.customName || '');
    setNameError(null);
    setIsNameModalOpen(true);
  }, [discussion?.customName]);

  const handleSaveName = useCallback(
    async (name?: string) => {
      if (!discussion?.id) return;

      const result = await updateDiscussionName(discussion.id, name);
      if (!result.ok) {
        setNameError(result.message);
        return;
      }

      setIsNameModalOpen(false);
      setShowSuccessCheck(true);
    },
    [discussion?.id]
  );

  const handleNavigateToContact = useCallback(
    (contact: Contact) => {
      navigate(ROUTES.contact({ userId: contact.userId }));
    },
    [navigate]
  );

  if (!discussion) {
    return (
      <div className="bg-background flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-border border-t-primary rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-muted-foreground">Loading discussion…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background h-full overflow-auto app-max-w mx-auto">
      <PageHeader title="Discussion Settings" onBack={() => navigate(-1)} />

      <div className="flex-1 pt-4 px-6 pb-6">
        {/* Discussion Name Section */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Discussion Name
          </h2>
          <div className="bg-background border border-border rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <p className="text-base font-semibold text-foreground truncate">
                  {displayName}
                </p>
              </div>
              <div className="flex items-center gap-2 ml-3">
                {showSuccessCheck && (
                  <Check className="w-4 h-4 text-success transition-opacity duration-200" />
                )}
                <Button
                  onClick={handleOpenEditName}
                  variant="ghost"
                  size="custom"
                  className="p-2 hover:bg-muted rounded-lg transition-colors"
                  title="Edit discussion name"
                >
                  <Edit2 className="w-4 h-4 text-muted-foreground" />
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Participants Section */}
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Participants
          </h2>
          <div className="bg-background border border-border rounded-xl divide-y divide-border">
            {participants.map(contact => (
              <button
                key={contact.userId}
                onClick={() => handleNavigateToContact(contact)}
                className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors first:rounded-t-xl last:rounded-b-xl"
              >
                <ContactAvatar contact={contact} size={10} />
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-sm font-medium text-foreground truncate">
                    {contact.name}
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
            ))}
            {participants.length === 0 && (
              <div className="p-4 text-center text-sm text-muted-foreground">
                No participants found
              </div>
            )}
          </div>
        </div>
      </div>

      <ContactNameModal
        isOpen={isNameModalOpen}
        onClose={() => setIsNameModalOpen(false)}
        title="Edit discussion name"
        initialName={proposedName}
        confirmLabel="Save"
        allowEmpty
        error={nameError}
        onConfirm={async name => {
          await handleSaveName(name);
        }}
      />
    </div>
  );
};

export default DiscussionSettings;
