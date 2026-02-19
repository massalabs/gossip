import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'react-feather';
import { Contact, SessionStatus } from '@massalabs/gossip-sdk';
import type { Discussion } from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../../hooks/useGossipSdk';
import ContactAvatar from '../avatar/ContactAvatar';
import Button from '../ui/Button';
import BackButton from '../ui/BackButton';
import HeaderBar from '../ui/HeaderBar';
import Popover from '../ui/Popover';
import { ROUTES } from '../../constants/routes';

interface DiscussionHeaderProps {
  contact?: Contact | null | undefined;
  discussion?: Discussion | null;
  onBack?: () => void;
  onSync?: () => void;
  title?: string;
  outgoingSentCount?: number;
}

const DiscussionHeader: React.FC<DiscussionHeaderProps> = ({
  contact,
  discussion,
  onBack,
  title,
  outgoingSentCount = 0,
}) => {
  const gossip = useGossipSdk();
  const navigate = useNavigate();

  // Header with title (for list view with custom title)
  if (title && !contact) {
    return (
      <HeaderBar>
        <div className="flex items-center w-full">
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        </div>
      </HeaderBar>
    );
  }

  // Guard against undefined/null contact when contact is expected
  if (!contact) {
    return (
      <HeaderBar>
        <div className="flex items-center w-full">
          <BackButton />
          <div className="flex-1">
            <p className="text-muted-foreground">Contact not found</p>
          </div>
        </div>
      </HeaderBar>
    );
  }

  // Display name: customName takes priority over contact name
  const displayName = discussion?.customName || contact.name || 'Unknown';

  const sessionStatus = discussion
    ? gossip.discussions.getStatus(discussion.contactUserId)
    : undefined;

  // Check if discussion is pending outgoing (waiting for approval)
  const isPendingOutgoing = sessionStatus === SessionStatus.SelfRequested;
  const isSaturated = sessionStatus === SessionStatus.Saturated;
  const isKilled = sessionStatus === SessionStatus.Killed;

  // Navigate to discussion settings if discussion exists, otherwise contact page
  const handleHeaderClick = () => {
    if (discussion?.id) {
      navigate(
        ROUTES.discussionSettings({ discussionId: discussion.id.toString() })
      );
    } else {
      navigate(ROUTES.contact({ userId: contact.userId }));
    }
  };

  return (
    <HeaderBar>
      <div className="flex flex-col w-full gap-3">
        <div className="flex items-center w-full gap-3">
          {onBack && (
            <Button
              onClick={onBack}
              variant="circular"
              size="custom"
              ariaLabel="Back"
              className="w-8 h-8 flex items-center justify-center"
            >
              <ChevronLeft className="w-5 h-5 text-muted-foreground" />
            </Button>
          )}
          <button
            onClick={handleHeaderClick}
            className="flex items-center flex-1 min-w-0 gap-3 group hover:opacity-80 transition-opacity active:opacity-70"
            title="Discussion settings"
          >
            <div className="relative">
              <ContactAvatar contact={contact} size={12} />
              {contact?.isOnline && (
                <span className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-success border-2 border-card rounded-full shadow-sm"></span>
              )}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <h1 className="text-xl font-semibold text-foreground truncate leading-tight">
                {displayName}
              </h1>
              {isPendingOutgoing && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-accent text-accent-foreground border border-border">
                  Waiting approval
                </span>
              )}
            </div>
          </button>
        </div>
        {isKilled && (
          <div className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground">
            Session is currently broken. We will retry automatically every few
            minutes.
          </div>
        )}
        {isSaturated && (
          <div className="w-full rounded-md border border-border bg-accent/20 px-3 py-2 text-sm text-foreground flex items-start gap-2">
            <span className="flex-1">
              You have sent many messages that have not been acknowledged yet.
              For security, it is best to wait for a reply before sending more.
            </span>
            <Popover
              ariaLabel="Why wait for a reply?"
              message={`Receiving a message from the peer allows the encryption key to be renewed. If an attacker gets your current key, they could decrypt your last ${outgoingSentCount} sent messages.`}
            />
          </div>
        )}
      </div>
    </HeaderBar>
  );
};

export default DiscussionHeader;
