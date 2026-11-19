import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupTimelineItem } from '@massalabs/gossip-sdk';
import GroupMessageItem from './GroupMessageItem';
import GroupTimelineLine from './GroupTimelineLine';
import { getGroupService } from '../../stores/groupStore';
import { messageText } from '../../utils/groupTimeline';

interface EarlierChatsProps {
  /** The chats of the same two the current one replaced, oldest first. */
  earlier: string[];
  me: string | undefined;
  memberName: (userId: string) => string;
  /** Bumped on every change, to read again. */
  version: number;
}

/**
 * The chats of two a chat replaced (§5.12), shown oldest first, read-only,
 * after the earlier one-to-one conversation and before the chat's own
 * timeline: nothing written in them is erased.
 */
const EarlierChats: React.FC<EarlierChatsProps> = ({
  earlier,
  me,
  memberName,
  version,
}) => {
  const { t } = useTranslation('groups');
  const [timelines, setTimelines] = useState<GroupTimelineItem[][]>([]);
  const key = earlier.join(',');

  useEffect(() => {
    let alive = true;
    const service = getGroupService();
    if (!service || key === '') {
      setTimelines([]);
      return;
    }
    Promise.all(key.split(',').map(g => service.timeline(g).catch(() => [])))
      .then(all => {
        if (alive) setTimelines(all);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key, version]);

  const items = timelines.flat();
  if (items.length === 0) return null;

  return (
    <div data-testid="earlier-chats">
      {items.map((item, i) =>
        item.kind === 'line' ? (
          <GroupTimelineLine
            key={`earlier-line-${i}`}
            line={item.line}
            memberName={memberName}
          />
        ) : (
          <GroupMessageItem
            key={`earlier-${item.epochId}:${item.syncObjId}`}
            message={item}
            isOutgoing={item.author === me}
            authorName={memberName(item.author)}
            replyPreviews={item.replyTo.map(() => null)}
            canWrite={false}
            onCopy={m => {
              void navigator.clipboard
                ?.writeText(messageText(m, t))
                .catch(() => {});
            }}
          />
        )
      )}
      <div
        className="my-3 mx-4 flex items-center gap-2 text-xs text-muted-foreground"
        role="separator"
        data-testid="earlier-junction"
      >
        <span className="flex-1 h-px bg-border" />
        <span className="shrink-0">{t('archive.earlier_junction')}</span>
        <span className="flex-1 h-px bg-border" />
      </div>
    </div>
  );
};

export default EarlierChats;
