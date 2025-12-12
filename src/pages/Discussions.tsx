import React, { useState } from 'react';
import DiscussionListPanel from '../components/discussions/DiscussionList';
import { useAccountStore } from '../stores/accountStore';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'react-feather';
import Button from '../components/ui/Button';
import SearchBar from '../components/ui/SearchBar';
import { PrivacyGraphic } from '../components/graphics';
import HeaderWrapper from '../components/ui/HeaderWrapper';
import UserProfileAvatar from '../components/avatar/UserProfileAvatar';
import ScrollableContent from '../components/ui/ScrollableContent';
import { ROUTES } from '../constants/routes';

const Discussions: React.FC = () => {
  const navigate = useNavigate();
  const { ourPk, ourSk, session, isLoading } = useAccountStore();
  const [searchQuery, setSearchQuery] = useState('');

  if (isLoading || !ourPk || !ourSk || !session) {
    return (
      <div className="bg-background flex items-center justify-center h-full">
        <PrivacyGraphic size={120} loading={true} />
        <p className="text-muted-foreground mt-4">Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card relative">
      <HeaderWrapper>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <UserProfileAvatar size={10} />
            <h1 className="text-xl font-semibold text-black dark:text-white">
              Gossip
            </h1>
          </div>
        </div>
      </HeaderWrapper>
      <ScrollableContent className="flex-1 overflow-y-auto pt-2 px-2 pb-20">
        <div className="px-2 mb-3">
          <SearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search discussions..."
            aria-label="Search discussions"
          />
        </div>
        <DiscussionListPanel
          onSelect={id => {
            navigate(ROUTES.discussion({ userId: id }));
          }}
          headerVariant="link"
          searchQuery={searchQuery}
        />
      </ScrollableContent>
      {/* Floating button positioned above bottom nav */}
      <Button
        onClick={() => navigate(ROUTES.newDiscussion())}
        variant="primary"
        size="custom"
        className="absolute bottom-3 right-4 h-14 w-14 rounded-full flex items-center gap-2 shadow-lg hover:shadow-xl transition-shadow z-50"
        title="Start new discussion"
      >
        <Plus className="text-primary-foreground shrink-0" />
      </Button>
    </div>
  );
};

export default Discussions;
