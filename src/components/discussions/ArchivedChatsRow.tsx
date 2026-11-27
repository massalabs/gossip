import React from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, ChevronRight } from 'react-feather';

interface ArchivedChatsRowProps {
  count: number;
  onOpen: () => void;
}

/**
 * The "Archived chats" row at the top of the list (Lucas's screen 03): it
 * leads to the archived list, which replaced the "Archived" filter.
 */
const ArchivedChatsRow: React.FC<ArchivedChatsRowProps> = ({
  count,
  onOpen,
}) => {
  const { t } = useTranslation('discussions');
  return (
    <button
      type="button"
      onClick={onOpen}
      className="hover-fill w-full px-4 py-3 mb-1 flex items-center gap-4 rounded-xl text-left"
      data-testid="archived-chats-row"
    >
      <Archive className="w-5 h-5 text-foreground shrink-0" />
      <span className="flex-1 text-sm font-medium text-foreground">
        {t('archived.title')}
      </span>
      <span className="text-sm text-muted-foreground">{count}</span>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </button>
  );
};

export default ArchivedChatsRow;
