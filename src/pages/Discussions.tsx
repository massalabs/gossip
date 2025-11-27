import React from 'react';
import DiscussionListPanel from '../components/discussions/DiscussionList';
import { useAccountStore } from '../stores/accountStore';
import { useNavigate } from 'react-router-dom';
import Button from '../components/ui/Button';
import { PrivacyGraphic } from '../components/ui/PrivacyGraphic';
import { triggerManualSync } from '../services/messageSync';

const Discussions: React.FC = () => {
  const navigate = useNavigate();
  const { ourPk, ourSk, session, isLoading } = useAccountStore();
  if (isLoading || !ourPk || !ourSk || !session) {
    return (
      <div className="bg-background flex items-center justify-center h-full">
        <PrivacyGraphic size={120} loading={true} />
        <p className="text-muted-foreground mt-4">Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-full bg-background">
      <div className="max-w-md mx-auto h-full flex flex-col bg-card relative">
        <div className="px-6 py-4 border-b border-border flex justify-between items-center">
          <h2 className="text-lg font-medium text-foreground">Discussions</h2>
          <button
            onClick={() => triggerManualSync(ourPk, ourSk, session)}
            className="text-xs text-primary hover:text-primary/80 underline"
          >
            Refresh
          </button>
        </div>
        {/* Scrollable content with bottom padding to prevent content from being hidden behind the button/nav */}
        <div className="pb-bottom-nav flex-1 overflow-y-auto">
          <DiscussionListPanel
            onSelect={id => {
              navigate(`/discussion/${id}`);
            }}
            headerVariant="link"
          />
        </div>
        {/* Floating button positioned above bottom nav - uses same spacing value as pb-bottom-nav for consistency */}
        <Button
          onClick={() => navigate('/new-discussion')}
          variant="primary"
          size="custom"
          className="absolute bottom-nav-offset right-4 px-5 h-14 rounded-full flex items-center gap-2 shadow-lg hover:shadow-xl transition-shadow z-50"
          title="Start new discussion"
        >
          <svg
            className="w-5 h-5 text-primary-foreground shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
          <span className="text-primary-foreground font-semibold text-sm whitespace-nowrap">
            New Chat
          </span>
        </Button>
      </div>
    </div>
  );
};

export default Discussions;
