import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'react-feather';
import {
  Contact,
  Discussion,
  DiscussionStatus,
  DiscussionDirection,
} from '../../db';
import ContactAvatar from '../avatar/ContactAvatar';
import Button from '../ui/Button';
import BackButton from '../ui/BackButton';
import HeaderBar from '../ui/HeaderWrapper';
import { ROUTES } from '../../constants/routes';

interface DiscussionHeaderProps {
  contact?: Contact | null | undefined;
  discussion?: Discussion | null;
  onBack?: () => void;
  onSync?: () => void;
  title?: string;
}

const DiscussionHeader: React.FC<DiscussionHeaderProps> = ({
  contact,
  discussion,
  onBack,
  title,
}) => {
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

  // Check if discussion is pending outgoing (waiting for approval)
  const isPendingOutgoing =
    discussion?.status === DiscussionStatus.PENDING &&
    discussion?.direction === DiscussionDirection.INITIATED;

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
    </HeaderBar>
  );
};

export default DiscussionHeader;
