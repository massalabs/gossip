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

  const showMetaBlock =
    !isOnline || (isOnline && isPendingOutgoing) || !!retentionLabel;

  const hasStatusChips = (isOnline && isPendingOutgoing) || !!retentionLabel;

  return (
    <HeaderBar className="min-h-header-safe h-auto! items-start! py-2.5 pb-3">
      <div className="flex items-center w-full gap-2 sm:gap-3">
        {onBack && (
          <Button
            onClick={onBack}
            variant="circular"
            size="custom"
            ariaLabel={t('common:back')}
            className="w-8 h-8 flex items-center justify-center shrink-0"
          >
            <ChevronLeft className="w-5 h-5 text-muted-foreground" />
          </Button>
        )}
        <button
          type="button"
          onClick={handleHeaderClick}
          className="flex items-start flex-1 min-w-0 gap-2.5 sm:gap-3 group text-left hover:opacity-80 transition-opacity active:opacity-70"
          title={t('header.discussion_settings')}
        >
          <div className="relative shrink-0 mt-0.5">
            <ContactAvatar contact={contact} size={12} />
            {contact?.isOnline && (
              <span className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-success border-2 border-card rounded-full shadow-sm" />
            )}
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-1.5">
            <h1 className="text-lg font-semibold text-foreground leading-snug line-clamp-2 wrap-break-word">
              {displayName}
            </h1>
            {showMetaBlock && (
              <div className="flex flex-col gap-1.5 min-w-0">
                {!isOnline && (
                  <p className="text-xs text-accent leading-relaxed">
                    {t('waiting_connection')}
                  </p>
                )}
                {hasStatusChips && (
                  <div className="flex flex-nowrap items-center gap-2 min-w-0 w-full">
                    {isOnline && isPendingOutgoing && (
                      <span className="inline-flex items-center shrink-0 px-2 py-1 rounded-full text-xs font-medium bg-muted text-foreground border border-border">
                        {t('header.waiting_approval')}
                      </span>
                    )}
                    {retentionLabel && (
                      <span className="inline-flex items-center gap-1.5 min-w-0 flex-1 text-xs text-muted-foreground overflow-hidden">
                        <Clock className="w-3.5 h-3.5 shrink-0" />
                        <span className="leading-snug truncate">
                          {t('header.auto_delete_active', {
                            duration: retentionLabel,
                          })}
                        </span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </button>
        {onSearchToggle && (
          <span className="shrink-0" onPointerDown={e => e.preventDefault()}>
            <Button
              onClick={onSearchToggle}
              variant="circular"
              size="custom"
              ariaLabel={t('header.search_messages')}
              className="w-8 h-8 flex items-center justify-center"
            >
              <Search className="w-5 h-5 text-muted-foreground" />
            </Button>
          </span>
        )}
      </div>
    </HeaderBar>
  );
};

export default DiscussionHeader;
