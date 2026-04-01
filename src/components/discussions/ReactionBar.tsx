import React from 'react';
import type { Message } from '@massalabs/gossip-sdk';
import type { ReactionGroup } from '../../stores/messageStore';

interface ReactionBarProps {
  reactions: ReactionGroup[];
  message: Message;
  isOutgoing: boolean;
  onToggleReaction?: (
    message: Message,
    emoji: string,
    myReactionId?: number,
    myReactionMessageId?: Uint8Array
  ) => void;
}

const ReactionBar: React.FC<ReactionBarProps> = React.memo(
  ({ reactions, message, isOutgoing, onToggleReaction }) => {
    if (reactions.length === 0) return null;

    return (
      <div
        data-testid="reactions-bar"
        className={`flex gap-1 -mt-1 ${
          isOutgoing ? 'justify-end' : 'justify-start'
        }`}
      >
        {reactions.map(reaction => {
          const isMine =
            reaction.myReactionId != null ||
            reaction.myReactionMessageId != null;

          return (
            <button
              key={reaction.emoji}
              type="button"
              onClick={e => {
                e.stopPropagation();
                onToggleReaction?.(
                  message,
                  reaction.emoji,
                  reaction.myReactionId,
                  reaction.myReactionMessageId
                );
              }}
              className={`flex items-center gap-0.5 text-sm min-w-[2rem] min-h-[1.75rem] px-2 py-1 rounded-full border shadow-sm bg-card/95 backdrop-blur active:scale-95 transition-transform cursor-pointer ${
                isMine
                  ? 'border-accent text-foreground'
                  : 'border-border text-foreground'
              }`}
            >
              <span>{reaction.emoji}</span>
              {reaction.count > 1 && (
                <span className="text-[10px] text-muted-foreground">
                  {reaction.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  }
);

ReactionBar.displayName = 'ReactionBar';

export default ReactionBar;
