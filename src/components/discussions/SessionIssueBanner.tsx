import React from 'react';
import { useTranslation } from 'react-i18next';
import Popover from '../ui/Popover';
import { Discussion, SessionStatus } from '@massalabs/gossip-sdk';
import { useDiscussionStore } from '../../stores/discussionStore';

interface SessionIssueBannerProps {
  discussion: Discussion | null;
  outgoingSentCount: number;
}

const SessionIssueBanner: React.FC<SessionIssueBannerProps> = ({
  discussion,
  outgoingSentCount,
}) => {
  const { t } = useTranslation('discussions');
  const sessionsStatuses = useDiscussionStore(s => s.sessionsStatuses);
  const sessionStatus = discussion
    ? sessionsStatuses.get(discussion.contactUserId)
    : undefined;

  const isSessionSaturated = sessionStatus === SessionStatus.Saturated;
  if (!isSessionSaturated) return null;

  return (
    <div className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-muted-foreground flex items-start gap-2">
      <span className="flex-1">{t('session_issue.message')}</span>
      <Popover
        ariaLabel={t('session_issue.info_label')}
        message={t('session_issue.info_message', { count: outgoingSentCount })}
      />
    </div>
  );
};

export default SessionIssueBanner;
