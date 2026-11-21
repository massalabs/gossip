import React from 'react';
import { useLongPress } from '../../hooks/useLongPress';

/**
 * The reactions of one emoji on a message. This account's reaction is named
 * by its stored IDs (one-to-one messages) or by `mine` (group messages).
 */
export interface ReactionChipGroup {
  emoji: string;
  count: number;
  myReactionId?: number;
  myReactionMessageId?: Uint8Array;
  mine?: boolean;
}

interface ReactionBarProps<M> {
  reactions: ReactionChipGroup[];
  message: M;
  isOutgoing: boolean;
  /** Tapping a chip; absent when reacting is not possible. */
  onToggleReaction?: (
    message: M,
    emoji: string,
    myReactionId?: number,
    myReactionMessageId?: Uint8Array
  ) => void;
  /**
   * Shows who reacted with `emoji`: on a long press (or right click) of its
   * chip, and on a tap when reacting is not possible.
   */
  onShowReactors?: (emoji: string) => void;
}

const ReactionChip: React.FC<{
  reaction: ReactionChipGroup;
  onTap?: () => void;
  onLongPress?: () => void;
}> = ({ reaction, onTap, onLongPress }) => {
  const longPress = useLongPress({
    onLongPress: () => onLongPress?.(),
    disabled: !onLongPress,
  });
  const isMine =
    reaction.mine === true ||
    reaction.myReactionId != null ||
    reaction.myReactionMessageId != null;

  return (
    <button
      type="button"
      data-testid="reaction-chip"
      aria-pressed={isMine}
      onClick={e => {
        e.stopPropagation();
        if (longPress.longPressTriggered.current) return;
        onTap?.();
      }}
      onTouchStart={longPress.onTouchStart}
      onTouchMove={longPress.onTouchMove}
      onTouchEnd={longPress.onTouchEnd}
      onTouchCancel={longPress.onTouchCancel}
      onContextMenu={
        onLongPress
          ? e => {
              e.stopPropagation();
              longPress.onContextMenu(e);
            }
          : undefined
      }
      className={`flex items-center gap-0.5 text-sm min-w-[2rem] min-h-[1.75rem] px-2 py-1 rounded-full border shadow-sm bg-card/95 backdrop-blur active:scale-95 transition-transform cursor-pointer animate-reaction-pop ${
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
};

function ReactionBarInner<M>({
  reactions,
  message,
  isOutgoing,
  onToggleReaction,
  onShowReactors,
}: ReactionBarProps<M>) {
  if (reactions.length === 0) return null;

  return (
    <div
      data-testid="reactions-bar"
      className={`flex gap-1 -mt-1 ${
        isOutgoing ? 'justify-end' : 'justify-start'
      }`}
    >
      {reactions.map(reaction => (
        <ReactionChip
          key={reaction.emoji}
          reaction={reaction}
          onTap={
            onToggleReaction
              ? () =>
                  onToggleReaction(
                    message,
                    reaction.emoji,
                    reaction.myReactionId,
                    reaction.myReactionMessageId
                  )
              : onShowReactors
                ? () => onShowReactors(reaction.emoji)
                : undefined
          }
          onLongPress={
            onShowReactors ? () => onShowReactors(reaction.emoji) : undefined
          }
        />
      ))}
    </div>
  );
}

const ReactionBar = React.memo(ReactionBarInner) as typeof ReactionBarInner & {
  displayName?: string;
};

ReactionBar.displayName = 'ReactionBar';

export default ReactionBar;
