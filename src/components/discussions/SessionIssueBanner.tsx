import React from 'react';
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
  const sessionsStatuses = useDiscussionStore(s => s.sessionsStatuses);
  const sessionStatus = discussion
    ? sessionsStatuses.get(discussion.contactUserId)
    : undefined;

  const isSessionSaturated = sessionStatus === SessionStatus.Saturated;
  if (!isSessionSaturated) return null;

  return (
    <div className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-muted-foreground flex items-start gap-2">
      <span className="flex-1">
        You have sent many messages that have not been acknowledged yet. For
        security, no more messages will be sent until a reply is received.
      </span>
      <Popover
        ariaLabel="Why wait for a reply?"
        message={`Receiving a message from the peer allows the encryption key to be renewed. If an attacker gets your current key, they could decrypt your last ${outgoingSentCount} sent messages.`}
      />
    </div>
  );
};

export default SessionIssueBanner;
