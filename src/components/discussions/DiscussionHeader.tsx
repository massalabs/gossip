import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Contact, Discussion } from '../../db';
import { formatUserId } from '../../utils/userId';
import ContactAvatar from '../avatar/ContactAvatar';
import Button from '../ui/Button';
import BackButton from '../ui/BackButton';

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
            <svg
              className="w-6 h-6 text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-white transition-colors"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </Button>
        )}
        <button
          onClick={() => navigate(`/contact/${contact.userId}`)}
          className="flex items-center flex-1 min-w-0 group hover:opacity-80 transition-opacity active:opacity-70"
          title="View contact details"
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
                {contact.name || 'Unknown'}
              </h1>
              {discussion && (
                <svg
                  className="w-4 h-4 text-emerald-500 shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
              <svg
                className="w-4 h-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
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
