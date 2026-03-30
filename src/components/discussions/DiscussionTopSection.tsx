import React from 'react';
import { Contact, Discussion, Message } from '@massalabs/gossip-sdk';
import DiscussionHeader from './DiscussionHeader';
import MessageSearch from './MessageSearch';
import SelectionHeader from './SelectionHeader';
import SessionIssueBanner from './SessionIssueBanner';

interface DiscussionTopSectionSelectionProps {
  isSelecting: boolean;
  selectedCount: number;
  canDeleteSelected: boolean;
  onClearSelection: () => void;
  onCopySelected: () => void;
  onDeleteSelected: () => void;
}

interface DiscussionTopSectionSearchProps {
  isOpen: boolean;
  messages: Message[];
  onToggleSearch: () => void;
  onScrollToMessage: (messageId: number) => void;
  onHighlightChange: (messageId: number | null) => void;
  onCloseSearch: () => void;
}

interface DiscussionTopSectionProps {
  contact: Contact;
  discussion: Discussion | null;
  anyDiscussionId: number | null;
  anyDiscussionRetentionDuration: number | null;
  onBack: () => void;
  outgoingSentCount: number;
  selection: DiscussionTopSectionSelectionProps;
  search: DiscussionTopSectionSearchProps;
}

const DiscussionTopSection: React.FC<DiscussionTopSectionProps> = ({
  contact,
  discussion,
  anyDiscussionId,
  anyDiscussionRetentionDuration,
  onBack,
  outgoingSentCount,
  selection,
  search,
}) => {
  return (
    <div className="shrink-0 z-10 w-full">
      {selection.isSelecting ? (
        <SelectionHeader
          count={selection.selectedCount}
          onClear={selection.onClearSelection}
          onCopy={selection.onCopySelected}
          onDelete={selection.onDeleteSelected}
          canDelete={selection.canDeleteSelected}
        />
      ) : (
        <DiscussionHeader
          contact={contact}
          discussion={discussion}
          anyDiscussionId={anyDiscussionId}
          anyDiscussionRetentionDuration={anyDiscussionRetentionDuration}
          onBack={onBack}
          onSearchToggle={search.onToggleSearch}
        />
      )}
      <SessionIssueBanner
        discussion={discussion}
        outgoingSentCount={outgoingSentCount}
      />
      {search.isOpen && (
        <div className="animate-slide-down-in overflow-hidden">
          <MessageSearch
            messages={search.messages}
            onScrollToMessage={search.onScrollToMessage}
            onHighlightChange={search.onHighlightChange}
            onClose={search.onCloseSearch}
          />
        </div>
      )}
    </div>
  );
};

export default DiscussionTopSection;
