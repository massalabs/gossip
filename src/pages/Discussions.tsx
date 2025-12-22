import React, { useCallback, useRef, useState, useEffect } from 'react';
import DiscussionListPanel from '../components/discussions/DiscussionList';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { useNavigate } from 'react-router-dom';
import { Plus, X } from 'react-feather';
import Button from '../components/ui/Button';
import SearchBar from '../components/ui/SearchBar';
import { useSearch } from '../hooks/useSearch';
import { PrivacyGraphic } from '../components/graphics';
import HeaderWrapper from '../components/ui/HeaderWrapper';
import UserProfileAvatar from '../components/avatar/UserProfileAvatar';
import { ROUTES } from '../constants/routes';

const Discussions: React.FC = () => {
  const navigate = useNavigate();
  const { session, isLoading } = useAccountStore();
  const pendingSharedContent = useAppStore(s => s.pendingSharedContent);
  const setPendingSharedContent = useAppStore(s => s.setPendingSharedContent);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Force re-render when ref is set to ensure DiscussionList gets the scroll parent
  const [scrollParentReady, setScrollParentReady] = useState(false);

  // Set up scroll parent
  useEffect(() => {
    if (scrollContainerRef.current) {
      setScrollParentReady(true);
    }
  }, []);

  const handleSelectDiscussion = useCallback(
    (contactUserId: string) => {
      // If there's pending shared content, pass it as prefilled message
      if (pendingSharedContent) {
        navigate(ROUTES.discussion({ userId: contactUserId }), {
          state: { prefilledMessage: pendingSharedContent },
          replace: false,
        });
        // Clear pending shared content after navigation
        setPendingSharedContent(null);
      } else {
        navigate(ROUTES.discussion({ userId: contactUserId }));
      }
    },
    [navigate, pendingSharedContent, setPendingSharedContent]
  );

  const handleCancelShare = useCallback(() => {
    setPendingSharedContent(null);
  }, [setPendingSharedContent]);

  // Use debounced search for filtering discussions
  const {
    query: searchQuery,
    debouncedQuery: debouncedSearchQuery,
    setQuery,
  } = useSearch({
    debounceMs: 300,
  });

  if (isLoading || !session) {
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
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-y-auto pt-2 px-2 pb-20"
      >
        {/* Show banner when there's pending shared content */}
        {pendingSharedContent && (
          <div className="mx-2 mb-4 p-4 bg-accent/50 border border-border rounded-lg">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground mb-1">
                  Share content to discussion
                </p>
                <p className="text-xs text-muted-foreground">
                  Select a discussion below to share the content.
                </p>
              </div>
              <button
                onClick={handleCancelShare}
                className="shrink-0 p-1 hover:bg-accent rounded transition-colors"
                aria-label="Cancel sharing"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          </div>
        )}
        <div className="px-2 mb-3">
          <SearchBar
            value={searchQuery}
            onChange={setQuery}
            placeholder="Search..."
            aria-label="Search"
          />
        </div>
        {scrollParentReady && scrollContainerRef.current && (
          <DiscussionListPanel
            onSelect={handleSelectDiscussion}
            headerVariant="link"
            searchQuery={debouncedSearchQuery}
            scrollParent={scrollContainerRef.current}
          />
        )}
      </div>
      {/* Floating button positioned above bottom nav */}
      <Button
        onClick={() => {
          navigate(ROUTES.newDiscussion());
        }}
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
