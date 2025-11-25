import React from 'react';
import DiscussionListPanel from '../components/discussions/DiscussionList';
import { useAccountStore } from '../stores/accountStore';
import { useNavigate } from 'react-router-dom';
import Button from '../components/ui/Button';
import { PrivacyGraphic } from '../components/ui/PrivacyGraphic';
import PageHeader from '../components/ui/PageHeader';

const Discussions: React.FC = () => {
  const navigate = useNavigate();
  const isLoading = useAccountStore(s => s.isLoading);
  if (isLoading) {
    return (
      <div className="bg-background flex items-center justify-center h-full">
        <PrivacyGraphic size={120} loading={true} />
        <p className="text-muted-foreground mt-4">Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card relative">
      <PageHeader title="Discussions" />
      {/* Scrollable content with bottom padding to prevent content from being hidden behind the button/nav */}
      <div className="flex-1 overflow-y-auto pt-4 px-2 pb-20">
        <DiscussionListPanel
          onSelect={id => {
            navigate(`/discussion/${id}`);
          }}
          headerVariant="link"
        />
      </div>
      {/* Floating button positioned above bottom nav */}
      <Button
        onClick={() => navigate('/new-discussion')}
        variant="primary"
        size="custom"
        className="absolute bottom-3 right-4 px-5 h-14 rounded-full flex items-center gap-2 shadow-lg hover:shadow-xl transition-shadow z-50"
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
      </Button>
    </div>
  );
};

export default Discussions;
