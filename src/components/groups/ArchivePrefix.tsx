import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageDirection,
  MessageStatus,
  type Message,
} from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../../hooks/useGossipSdk';
import { formatRelativeTime } from '../../utils/timeUtils';

interface ArchivePrefixProps {
  /** The peer of the archive this direct chat continues. */
  contactUserId: string;
}

/**
 * The earlier one-to-one conversation a direct chat continues (§5.12),
 * shown first and read-only, then the junction with the group's timeline.
 * Its messages are this device's own, converted locally; none is sent.
 */
const ArchivePrefix: React.FC<ArchivePrefixProps> = ({ contactUserId }) => {
  const { t } = useTranslation('groups');
  const gossip = useGossipSdk();
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    let alive = true;
    gossip.messages
      .getVisibleMessages(contactUserId)
      .then(m => {
        if (alive) setMessages(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [gossip, contactUserId]);

  if (messages.length === 0) return null;

  return (
    <div data-testid="archive-prefix">
      {messages.map(m => {
        const outgoing = m.direction === MessageDirection.OUTGOING;
        const unsent =
          outgoing &&
          (m.status === MessageStatus.WAITING_SESSION ||
            m.status === MessageStatus.FAILED);
        return (
          <div
            key={m.id}
            className={`px-4 py-1 flex ${outgoing ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm opacity-80 ${
                outgoing
                  ? 'bg-accent-soft text-foreground'
                  : 'bg-muted text-foreground'
              }`}
            >
              <p className="whitespace-pre-wrap wrap-break-word">{m.content}</p>
              <p className="mt-1 text-[10px] text-muted-foreground text-right">
                {unsent ? `${t('archive.unsent')} · ` : ''}
                {formatRelativeTime(m.timestamp)}
              </p>
            </div>
          </div>
        );
      })}
      <div
        className="my-3 mx-4 flex items-center gap-2 text-xs text-muted-foreground"
        role="separator"
        data-testid="archive-junction"
      >
        <span className="flex-1 h-px bg-border" />
        <span className="shrink-0">{t('archive.junction')}</span>
        <span className="flex-1 h-px bg-border" />
      </div>
    </div>
  );
};

export default ArchivePrefix;
