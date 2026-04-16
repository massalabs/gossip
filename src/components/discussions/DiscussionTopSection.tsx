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
  onScrollToMessage: (id: number) => void;
  onHighlightChange: (id: number | null) => void;
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
  // Position de la barre de recherche : flux normal (pas de top calculé en JS).
  // Bloc header + recherche = une colonne sans gap interne pour coller la recherche au header ;
  // puis gap-1.5 avant la bannière session.
  return (
    <div className="shrink-0 z-10 w-full flex flex-col gap-1.5">
      <div className="flex flex-col min-w-0">
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
      <SessionIssueBanner
        discussion={discussion}
        outgoingSentCount={outgoingSentCount}
      />
    </div>
  );
};

export default DiscussionTopSection;
