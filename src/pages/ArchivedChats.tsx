import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import PageLayout from '../components/ui/Layout/PageLayout';
import PageHeader from '../components/ui/PageHeader';
import DiscussionListPanel from '../components/discussions/DiscussionList';
import { ROUTES } from '../constants/routes';
import { useOpenChat } from '../hooks/useOpenChat';

/**
 * The archived chats (Lucas's screen 14), opened from the "Archived chats"
 * row of the list. Each can be moved back to the list from its long press or
 * from inside it.
 */
const ArchivedChats: React.FC = () => {
  const { t } = useTranslation('discussions');
  const navigate = useNavigate();
  const openChat = useOpenChat();
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(
    null
  );
  return (
    <PageLayout
      header={
        <PageHeader
          title={t('archived.title')}
          onBack={() => navigate(ROUTES.discussions())}
        />
      }
      className="app-max-w mx-auto"
      contentClassName="px-2 pb-4 flex flex-col"
      onScrollContainerRef={setScrollContainer}
    >
      {scrollContainer && (
        <DiscussionListPanel
          onSelect={userId => void openChat(userId)}
          scrollParent={scrollContainer}
          filter="archived"
        />
      )}
    </PageLayout>
  );
};

export default ArchivedChats;
