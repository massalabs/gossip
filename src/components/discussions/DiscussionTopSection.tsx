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
  onBack: () => void;
  outgoingSentCount: number;
  selection: DiscussionTopSectionSelectionProps;
  search: DiscussionTopSectionSearchProps;
}

const DiscussionTopSection: React.FC<DiscussionTopSectionProps> = ({
  contact,
  discussion,
  onBack,
  outgoingSentCount,
  selection,
  search,
}) => {
  return (
    <div className="fixed z-10 top-0 left-0 w-full">
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
          onBack={onBack}
          onSearchToggle={search.onToggleSearch}
        />
      )}
      <SessionIssueBanner
        discussion={discussion}
        outgoingSentCount={outgoingSentCount}
      />
      {search.isOpen && (
        <MessageSearch
          messages={search.messages}
          onScrollToMessage={search.onScrollToMessage}
          onHighlightChange={search.onHighlightChange}
          onClose={search.onCloseSearch}
        />
      )}
    </div>
  );
};

export default DiscussionTopSection;
