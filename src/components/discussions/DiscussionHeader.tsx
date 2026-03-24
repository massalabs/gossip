import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, Clock, Search } from 'react-feather';
import { Contact, SessionStatus } from '@massalabs/gossip-sdk';
import type { Discussion } from '@massalabs/gossip-sdk';
import { useDiscussionStore } from '../../stores/discussionStore';
import ContactAvatar from '../avatar/ContactAvatar';
import Button from '../ui/Button';
import BackButton from '../ui/BackButton';
import HeaderBar from '../ui/HeaderBar';
import { ROUTES } from '../../constants/routes';
import { useOnlineStore } from '../../stores/useOnlineStore';

interface DiscussionHeaderProps {
  contact?: Contact | null | undefined;
  discussion?: Discussion | null;
  anyDiscussionId?: number | null;
  anyDiscussionRetentionDuration?: number | null;
  onBack?: () => void;
  onSync?: () => void;
  onSearchToggle?: () => void;
  title?: string;
}

const DiscussionHeader: React.FC<DiscussionHeaderProps> = ({
  contact,
  discussion,
  anyDiscussionId,
  anyDiscussionRetentionDuration,
  onBack,
  onSearchToggle,
  title,
}) => {
  const { t } = useTranslation('discussions');
  const sessionsStatuses = useDiscussionStore(s => s.sessionsStatuses);
  const navigate = useNavigate();
  const isOnline = useOnlineStore(s => s.isOnline);

  // Header with title (for list view with custom title)
  if (title && !contact) {
    return (
      <HeaderBar>
        <div className="flex items-center w-full">
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        </div>
      </HeaderBar>
    );
  }

  // Guard against undefined/null contact when contact is expected
  if (!contact) {
    return (
      <HeaderBar>
        <div className="flex items-center w-full">
          <BackButton />
          <div className="flex-1">
            <p className="text-muted-foreground">
              {t('header.contact_not_found')}
            </p>
          </div>
        </div>
      </HeaderBar>
    );
  }

  // Display name: customName takes priority over contact name
  const displayName = discussion?.customName || contact.name || 'Unknown';

  const sessionStatus = discussion
    ? sessionsStatuses.get(discussion.contactUserId)
    : undefined;

  // Check if discussion is pending outgoing (waiting for approval)
  const isPendingOutgoing = sessionStatus === SessionStatus.SelfRequested;

  const RETENTION_LABELS: Record<number, string> = {
    300: t('settings.auto_delete_5m'),
    3600: t('settings.auto_delete_1h'),
    28800: t('settings.auto_delete_8h'),
    86400: t('settings.auto_delete_1d'),
    604800: t('settings.auto_delete_1w'),
    2592000: t('settings.auto_delete_1mo'),
  };

  const retentionDuration =
    discussion?.messageRetentionDuration ??
    anyDiscussionRetentionDuration ??
    null;
  const retentionLabel = retentionDuration
    ? (RETENTION_LABELS[retentionDuration] ?? String(retentionDuration) + 's')
    : null;

  const settingsId = discussion?.id ?? anyDiscussionId;
  const handleHeaderClick = () => {
    if (settingsId) {
      navigate(
        ROUTES.discussionSettings({ discussionId: settingsId.toString() })
      );
    }
  };

  return (
    <HeaderBar>
      <div className="flex items-center w-full gap-3">
        {onBack && (
          <Button
            onClick={onBack}
            variant="circular"
            size="custom"
            ariaLabel={t('common:back')}
            className="w-8 h-8 flex items-center justify-center"
          >
            <ChevronLeft className="w-5 h-5 text-muted-foreground" />
          </Button>
        )}
        <button
          onClick={handleHeaderClick}
          className="flex items-center flex-1 min-w-0 gap-3 group hover:opacity-80 transition-opacity active:opacity-70"
          title={t('header.discussion_settings')}
        >
          <div className="relative">
            <ContactAvatar contact={contact} size={12} />
            {contact?.isOnline && (
              <span className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-success border-2 border-card rounded-full shadow-sm"></span>
            )}
          </div>
          <div className="flex-1 min-w-0 text-left">
            <h1 className="text-xl font-semibold text-foreground truncate leading-tight">
              {displayName}
            </h1>
            {!isOnline && (
              <p className="text-xs font-light text-accent truncate">
                {t('waiting_connection')}
              </p>
            )}
            {isOnline && isPendingOutgoing && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-accent text-accent-foreground border border-border">
                {t('header.waiting_approval')}
              </span>
            )}
            {retentionLabel && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="w-3 h-3 shrink-0" />
                {t('header.auto_delete_active', { duration: retentionLabel })}
              </span>
            )}
          </div>
        </button>
        {onSearchToggle && (
          <Button
            onClick={onSearchToggle}
            variant="circular"
            size="custom"
            ariaLabel={t('header.search_messages')}
            className="w-8 h-8 flex items-center justify-center shrink-0"
          >
            <Search className="w-5 h-5 text-muted-foreground" />
          </Button>
        )}
      </div>
    </HeaderBar>
  );
};

export default DiscussionHeader;
