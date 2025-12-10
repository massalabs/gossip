import React from 'react';
import DiscussionListPanel from '../components/discussions/DiscussionList';
import { useAccountStore } from '../stores/accountStore';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'react-feather';
import Button from '../components/ui/Button';
import { PrivacyGraphic } from '../components/ui/PrivacyGraphic';
import PageHeader from '../components/ui/PageHeader';
import { ROUTES } from '../constants/routes';

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
    <div className="h-full flex flex-col bg-background relative">
      <PageHeader title="Discussions" />
      {/* Scrollable content with bottom padding to prevent content from being hidden behind the button/nav */}
      <div className="flex-1 overflow-y-auto pt-4 px-2 pb-20">
        <DiscussionListPanel
          onSelect={id => {
            navigate(ROUTES.discussion({ userId: id }));
          }}
          headerVariant="link"
        />
      </div>
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
