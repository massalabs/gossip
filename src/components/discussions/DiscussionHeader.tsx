import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Contact, Discussion } from '../../db';
import { formatUserId } from '../../utils/userId';
import ContactAvatar from '../avatar/ContactAvatar';
import Button from '../ui/Button';
import BackButton from '../ui/BackButton';
import { ChevronLeftIcon } from '../ui/icons';
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
      <div className="h-[72px] flex items-center bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl border-b border-gray-100 dark:border-gray-800/50 shadow-sm">
        <div className="flex items-center w-full px-5">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
            {title}
          </h1>
        </div>
      </div>
    );
  }

  // Guard against undefined/null contact when contact is expected
  if (!contact) {
    return (
      <div className="h-[72px] flex items-center bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl border-b border-gray-100 dark:border-gray-800/50 shadow-sm">
        <div className="flex items-center w-full px-5">
          <BackButton />
          <div className="flex-1">
            <p className="text-gray-500 dark:text-gray-400">
              Contact not found
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Display name: customName takes priority over contact name
  const displayName = discussion?.customName || contact.name || 'Unknown';

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
    <div className="h-[72px] flex items-center bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl border-b border-gray-100 dark:border-gray-800/50 shadow-sm">
      <div className="flex items-center w-full px-5">
        {onBack && (
          <Button
            onClick={onBack}
            variant="circular"
            size="custom"
            className="w-11 h-11 flex items-center justify-center mr-2 group hover:bg-muted/50 active:bg-muted/70"
          >
            <ChevronLeftIcon className="w-6 h-6 text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-white transition-colors" />
          </Button>
        )}
        <button
          onClick={handleHeaderClick}
          className="flex items-center flex-1 min-w-0 group hover:opacity-80 transition-opacity active:opacity-70"
          title="Discussion settings"
        >
          <div className="relative">
            <ContactAvatar contact={contact} size={12} />
            {contact?.isOnline && (
              <span className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-success border-2 border-white dark:border-gray-900 rounded-full shadow-sm"></span>
            )}
          </div>
          <div className="ml-3.5 flex-1 min-w-0 text-left">
            <div className="flex items-center gap-2">
              <h1 className="text-[17px] font-semibold text-gray-900 dark:text-white truncate leading-tight group-hover:text-primary transition-colors">
                {displayName}
              </h1>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-[13px] text-gray-500 dark:text-gray-400 truncate font-medium">
                {formatUserId(contact.userId)}
              </p>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
};

export default DiscussionHeader;
