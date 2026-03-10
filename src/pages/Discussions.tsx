import React, { useCallback, useState, useMemo } from 'react';
import DiscussionListPanel from '../components/discussions/DiscussionList';
import DiscussionFilterButtons from '../components/discussions/DiscussionFilterButtons';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { useNavigate } from 'react-router-dom';
import { Plus, X, Settings } from 'react-feather';
import Button from '../components/ui/Button';
import SearchBar from '../components/ui/SearchBar';
import { useSearch } from '../hooks/useSearch';
import { PrivacyGraphic } from '../components/graphics';
import PageLayout from '../components/ui/PageLayout';
import UserProfileAvatar from '../components/avatar/UserProfileAvatar';
import QrCodeIcon from '../components/ui/customIcons/QrCodeIcon';
import ThreeDotMenu, { MenuItem } from '../components/ui/ThreeDotMenu';
import { ROUTES } from '../constants/routes';
import { useDiscussionStore } from '../stores/discussionStore';
import { useGossipSdk } from '../hooks/useGossipSdk';
import { SessionStatus } from '@massalabs/gossip-sdk';
import { useOnlineStore } from '../stores/useOnlineStore';

const Discussions: React.FC = () => {
  const gossip = useGossipSdk();
  const navigate = useNavigate();
  const isLoading = useAccountStore(s => s.isLoading);
  const username = useAccountStore(s => s.userProfile?.username);
  const pendingSharedContent = useAppStore(s => s.pendingSharedContent);
  const setPendingSharedContent = useAppStore(s => s.setPendingSharedContent);
  const pendingForwardMessageId = useAppStore(s => s.pendingForwardMessageId);
  const setPendingForwardMessageId = useAppStore(
    s => s.setPendingForwardMessageId
  );
  const discussions = useDiscussionStore(s => s.discussions);
  const filter = useDiscussionStore(s => s.filter);
  const setFilter = useDiscussionStore(s => s.setFilter);
  const sessionsStatuses = useDiscussionStore(s => s.sessionsStatuses);
  const isOnline = useOnlineStore(s => s.isOnline);
  // Callback ref: triggers re-render when scroll container is mounted
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(
    null
  );

  const handleSelectDiscussion = useCallback(
    (contactUserId: string) => {
      // If there's pending shared content, pass it as prefilled message
      if (pendingSharedContent) {
        const state =
          pendingForwardMessageId != null
            ? {
                forwardFromMessageId: pendingForwardMessageId,
              }
            : {
                prefilledMessage: pendingSharedContent,
              };

        navigate(ROUTES.discussion({ userId: contactUserId }), {
          state,
          replace: false,
        });
        // Clear pending shared content after navigation
        setPendingSharedContent(null);
        setPendingForwardMessageId(null);
      } else {
        navigate(ROUTES.discussion({ userId: contactUserId }));
      }
    },
    [
      navigate,
      pendingSharedContent,
      pendingForwardMessageId,
      setPendingSharedContent,
      setPendingForwardMessageId,
    ]
  );

  const handleCancelShare = useCallback(() => {
    setPendingSharedContent(null);
    setPendingForwardMessageId(null);
  }, [setPendingSharedContent, setPendingForwardMessageId]);

  const {
    query: searchQuery,
    debouncedQuery: debouncedSearchQuery,
    setQuery,
  } = useSearch({
    debounceMs: 300,
  });

  // Calculate filter counts
  const filterCounts = useMemo(() => {
    if (!gossip.isSessionOpen) {
      return { all: 0, unread: 0, pending: 0 };
    }
    const allCount = discussions.length;
    const unreadCount = discussions.filter(d => {
      const status = sessionsStatuses.get(d.contactUserId);
      return (
        status != null &&
        [SessionStatus.Active, SessionStatus.Killed].includes(status) &&
        d.unreadCount > 0
      );
    }).length;
    const pendingCount = discussions.filter(d => {
      const status = sessionsStatuses.get(d.contactUserId);
      return (
        status != null &&
        [SessionStatus.PeerRequested, SessionStatus.SelfRequested].includes(
          status
        )
      );
    }).length;

    return { all: allCount, unread: unreadCount, pending: pendingCount };
  }, [discussions, gossip.isSessionOpen, sessionsStatuses]);

  const menuItems: MenuItem[] = useMemo(
    () => [
      {
        label: 'Settings',
        icon: <Settings className="w-5 h-5" />,
        onClick: () => navigate(ROUTES.settings()),
      },
    ],
    [navigate]
  );

  if (isLoading || !gossip.isSessionOpen) {
    return (
      <div className="bg-background flex items-center justify-center h-full">
        <PrivacyGraphic size={120} loading={true} />
        <p className="text-muted-foreground mt-4">Loading...</p>
      </div>
    );
  }

  const headerContent = (
    <div className="flex items-center justify-between w-full">
      <div className="flex items-center gap-3">
        {isOnline && <UserProfileAvatar name={username} size={10} />}
        {isOnline ? (
          <h1 className="text-xl font-semibold text-foreground">Gossip</h1>
        ) : (
          <h1 className="text-xl font-semibold text-accent">
            Waiting for connection...
          </h1>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate(ROUTES.settingsShareContact())}
          aria-label="Share my contact"
          title="Share my contact"
          className="w-8 h-8 flex items-center justify-center rounded-full hover:opacity-70 active:opacity-50"
        >
          <QrCodeIcon className="w-5 h-5 text-accent" />
        </button>
        <ThreeDotMenu items={menuItems} />
      </div>
    </div>
  );

  return (
    <PageLayout
      header={headerContent}
      className="relative"
      contentClassName="pt-2 px-2 pb-4"
      onScrollContainerRef={setScrollContainer}
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
      {/* Filter buttons - only show when not searching */}
      {!searchQuery.trim() && (
        <DiscussionFilterButtons
          filter={filter}
          onFilterChange={setFilter}
          filterCounts={filterCounts}
        />
      )}
      {scrollContainer && (
        <DiscussionListPanel
          onSelect={handleSelectDiscussion}
          headerVariant="link"
          searchQuery={debouncedSearchQuery}
          scrollParent={scrollContainer}
          filter={filter}
        />
      )}
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
    </PageLayout>
  );
};

export default Discussions;
