import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Clock,
  Copy,
  CornerUpLeft,
  Edit2,
  RefreshCw,
  Smile,
  Trash2,
} from 'react-feather';
import type { GroupMessage } from '@massalabs/gossip-sdk';
import { parseLinks, openUrl } from '../../utils/linkUtils';
import { formatTime } from '../../utils/timeUtils';
import LinkText from '../discussions/LinkText';
import MessageContextMenu, {
  type MessageContextMenuItem,
} from '../ui/MessageContextMenu';
import EmojiPickerModal from '../ui/EmojiPickerModal';
import BaseModal from '../ui/BaseModal';
import ReactionBar, {
  type ReactionChipGroup,
} from '../discussions/ReactionBar';
import { useLongPress } from '../../hooks/useLongPress';
import {
  SWIPE_THRESHOLD,
  SWIPE_THRESHOLD_OUTGOING,
  useSwipeToReply,
} from '../discussions/hooks/useSwipeToReply';
import ContactAvatar from '../avatar/ContactAvatar';
import { getAuthorNameClass as authorColor } from '../avatar/avatarIdentity';
import SafeName from './SafeName';
import { isolate } from '../../utils/groupName';

/** How wide the swipe-to-reply indicator grows, as in `MessageBubble`. */
const SWIPE_INDICATOR_MAX_WIDTH = 60;

/** What a reply shows of a message it answers (§7.6). */
export interface ReplyQuote {
  /** The target's author, null when this device does not hold it. */
  author: string | null;
  /** Its user ID, for the colour of the name. */
  authorId?: string;
  /**
   * One line of the target, null when this device does not hold it (deleted,
   * or not received yet): the quote then says the message is not available.
   */
  text: string | null;
  /** The other chat the target is in, when it is not this one. */
  group: string | null;
  /** Scrolls to the target, when this timeline shows it. */
  onJump?: () => void;
}
import { messageText, toDate } from '../../utils/groupTimeline';

/** What the menu of a message can do; an absent handler hides its item. */
export interface GroupMessageActions {
  onReply?: (m: GroupMessage) => void;
  onCopy?: (m: GroupMessage) => void;
  /**
   * Edits the message, anyone's (UI4, UI7): who sees the edit is chosen
   * where it is written, not here.
   */
  onEdit?: (m: GroupMessage) => void;
  /** Deletes the message, anyone's: a confirmation asks for whom (UI3). */
  onDelete?: (m: GroupMessage) => void;
  onRetry?: (m: GroupMessage) => void;
  /** Adds this account's reaction `emoji`, or removes it if there is one. */
  onToggleReaction?: (m: GroupMessage, emoji: string) => void;
}

interface GroupMessageItemProps extends GroupMessageActions {
  message: GroupMessage;
  isOutgoing: boolean;
  authorName: string;
  /**
   * The messages it replies to. A target in an epoch this device lacks has
   * no quote: the protocol cannot say what it was.
   */
  quotes: ReplyQuote[];
  canWrite: boolean;
  /**
   * Someone else's message: the author's avatar bubble beside it, in every
   * chat (a chat of two included).
   */
  showAvatar?: boolean;
  /**
   * The first message of a run of the same author: the name above it and
   * the avatar beside it; the rest of the run leaves their place empty.
   */
  runStart?: boolean;
  /** Briefly marked after a tap on a quote of it. */
  highlighted?: boolean;
  /** A new message just seen: a slight glow that fades. */
  glow?: boolean;
  /** The name shown for a member, for the list of who reacted. */
  memberName?: (userId: string) => string;
  /**
   * Shown by this screen while it is being sent, before the engine has it:
   * a clock, and no menu, as nothing can be done with it yet.
   */
  sending?: boolean;
}

/**
 * A group message, in the bubble style of the one-to-one `MessageBubble`, with
 * its author, reply context and the menu of group actions.
 */
const GroupMessageItem: React.FC<GroupMessageItemProps> = ({
  message,
  isOutgoing,
  authorName,
  quotes,
  canWrite,
  memberName,
  sending = false,
  showAvatar = false,
  runStart = true,
  highlighted = false,
  glow = false,
  onReply,
  onCopy,
  onEdit,
  onDelete,
  onRetry,
  onToggleReaction,
}) => {
  const { t } = useTranslation('groups');
  const { t: td } = useTranslation('discussions');
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The emoji whose authors are listed, if any.
  const [reactorsOf, setReactorsOf] = useState<string | null>(null);
  // Reacting is a write: never in a read-only chat (§7.6).
  const toggle = canWrite ? onToggleReaction : undefined;
  const chips: ReactionChipGroup[] = useMemo(
    () =>
      message.reactions.map(r => ({
        emoji: r.emoji,
        count: r.authors.length,
        mine: r.mine,
      })),
    [message.reactions]
  );
  const reactors =
    message.reactions.find(r => r.emoji === reactorsOf)?.authors ?? [];
  const openMenu = () => {
    if (!sending) setMenuOpen(true);
  };
  const longPress = useLongPress({ onLongPress: openMenu });
  // Slide to reply, as in the one-to-one chats (`MessageBubble`).
  const canSwipeReply = canWrite && !!onReply && !sending;
  const suppressClickRef = useRef(false);
  const suppressClicksUntilRef = useRef(0);
  const longPressPosRef = useRef<{ x: number; y: number } | null>(null);
  const swipe = useSwipeToReply<GroupMessage>({
    isOutgoing,
    isDeleted: sending,
    isSelecting: false,
    isTextSelectable: false,
    canReply: canSwipeReply,
    canForward: false,
    onReplyTo: onReply,
    message,
    longPress,
    suppressClickRef,
    suppressClicksUntilRef,
    longPressPosRef,
  });
  const text = messageText(message, t);
  const segments = useMemo(() => parseLinks(text), [text]);

  const handleLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.currentTarget.href) openUrl(e.currentTarget.href);
    },
    []
  );

  const items: MessageContextMenuItem[] = [];
  const add = (
    handler: ((m: GroupMessage) => void) | undefined,
    label: string,
    icon: React.ReactNode,
    danger = false
  ) => {
    if (handler)
      items.push({ label, icon, danger, onClick: () => handler(message) });
  };
  const isText = message.body.type === 'text';
  if (toggle) {
    items.push({
      label: t('message_menu.react'),
      icon: <Smile className="w-4 h-4" />,
      onClick: () => setPickerOpen(true),
    });
  }
  if (canWrite)
    add(onReply, t('message_menu.reply'), <CornerUpLeft className="w-4 h-4" />);
  if (isText) add(onCopy, t('message_menu.copy'), <Copy className="w-4 h-4" />);
  // One Edit and one Delete, on every message: in a read-only chat they act
  // on this device only, which the screen behind them says.
  if (isText)
    add(onEdit, t('message_menu.edit'), <Edit2 className="w-4 h-4" />);
  add(onDelete, t('message_menu.delete'), <Trash2 className="w-4 h-4" />, true);
  if (canWrite)
    add(onRetry, t('message_menu.retry'), <RefreshCw className="w-4 h-4" />);

  const shownTime = message.edited ? message.lastModifiedAt : message.createdAt;

  const { swipeOffset, isAnimatingBack, indicatorThreshold } = swipe;
  const showName = !isOutgoing && runStart && showAvatar;

  return (
    <div
      className={`flex items-start gap-2 ${runStart ? 'mt-2' : 'mt-0.5'} mb-0.5 ${
        isOutgoing ? 'justify-end pl-12 pr-3' : 'pl-3 pr-12'
      } ${sending ? 'opacity-70' : ''}`}
      data-testid="group-message"
      data-sending={sending || undefined}
      data-highlighted={highlighted || undefined}
      data-glow={glow || undefined}
      // pan-y: the browser keeps vertical scrolling and hands horizontal
      // panning to the swipe (React touch listeners are passive).
      style={{ touchAction: 'pan-y' }}
    >
      {!isOutgoing && showAvatar && (
        <div className="w-8 shrink-0" aria-hidden="true">
          {runStart && (
            <span data-testid="group-message-avatar">
              <ContactAvatar
                contact={{
                  userId: message.author,
                  name: authorName,
                  avatar: undefined,
                }}
                size={8}
              />
            </span>
          )}
        </div>
      )}
      <div
        className={`flex flex-col min-w-0 max-w-[80%] sm:max-w-[70%] md:max-w-[65%] lg:max-w-[60%] ${
          isOutgoing ? 'items-end' : 'items-start'
        }`}
      >
        {showName && (
          <p
            className={`px-1 pb-0.5 text-xs font-semibold max-w-full ${authorColor(message.author)}`}
            data-testid="group-message-author"
          >
            <SafeName name={authorName} />
          </p>
        )}
        {!isOutgoing && !showAvatar && runStart && (
          // Without the avatar, who wrote stays for screen readers.
          <span className="sr-only">
            <SafeName name={authorName} />
          </span>
        )}
        <div
          className={`relative max-w-full px-3.5 py-3 font-normal text-[15px] leading-tight rounded-2xl select-none cursor-pointer focus:outline-none transition-shadow motion-reduce:transition-none ${
            isOutgoing
              ? 'bg-bubble-sent text-bubble-sent-foreground'
              : 'bg-bubble-received text-bubble-received-foreground'
          } ${menuOpen ? 'shadow-xl brightness-[1.08]' : ''} ${
            highlighted ? 'ring-2 ring-primary' : ''
          } ${
            glow
              ? 'shadow-[0_0_14px_3px_var(--color-primary)] duration-0'
              : 'duration-[1500ms]'
          }`}
          role="button"
          tabIndex={0}
          onClick={() => {
            if (longPress.longPressTriggered.current) return;
            if (
              suppressClickRef.current ||
              Date.now() < suppressClicksUntilRef.current
            ) {
              suppressClickRef.current = false;
              return;
            }
            openMenu();
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') openMenu();
          }}
          onTouchStart={swipe.handleTouchStart}
          onTouchMove={swipe.handleTouchMove}
          onTouchEnd={swipe.handleTouchEnd}
          onTouchCancel={swipe.handleTouchCancel}
          onContextMenu={longPress.onContextMenu}
          style={{
            transform:
              swipeOffset !== 0 ? `translateX(${swipeOffset}px)` : undefined,
            transition: isAnimatingBack
              ? 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
              : undefined,
          }}
        >
          {-swipeOffset > indicatorThreshold && canSwipeReply && (
            <div
              className={`absolute right-0 top-0 bottom-0 flex items-center justify-center ${isOutgoing ? 'bg-bubble-sent/40' : 'bg-card/20'} rounded-r-2xl`}
              style={{
                width: `${Math.min(-swipeOffset, SWIPE_INDICATOR_MAX_WIDTH)}px`,
                opacity: Math.min(-swipeOffset / SWIPE_INDICATOR_MAX_WIDTH, 1),
              }}
              aria-hidden="true"
            >
              <CornerUpLeft
                className={`w-5 h-5 text-muted-foreground transition-transform ${
                  -swipeOffset >=
                  (isOutgoing ? SWIPE_THRESHOLD_OUTGOING : SWIPE_THRESHOLD)
                    ? 'scale-110'
                    : 'scale-100'
                }`}
              />
            </div>
          )}
          {quotes.map((q, i) => {
            const body = (
              <>
                <span
                  className={`block text-xs font-semibold truncate ${
                    q.authorId && !isOutgoing ? authorColor(q.authorId) : ''
                  }`}
                >
                  {q.author ? (
                    <SafeName name={q.author} />
                  ) : (
                    t('timeline.reply_to')
                  )}
                  {q.group
                    ? ` · ${t('timeline.reply_in_group', { name: isolate(q.group) })}`
                    : ''}
                </span>
                <span
                  className={`block text-xs truncate opacity-80 ${
                    q.text === null ? 'italic' : ''
                  }`}
                >
                  {q.text ?? t('timeline.reply_unavailable')}
                </span>
              </>
            );
            const cls = `block w-full min-w-0 text-left mb-2 pl-2 pr-1 py-1 border-l-2 rounded-r bg-black/5 dark:bg-white/5 ${
              isOutgoing
                ? 'border-bubble-sent-foreground/40'
                : 'border-card-foreground/30'
            }`;
            return q.onJump ? (
              <button
                key={i}
                type="button"
                data-testid="group-reply-preview"
                className={`${cls} hover:bg-black/10 dark:hover:bg-white/10`}
                aria-label={td('message_item.jump_to_original')}
                onClick={e => {
                  e.stopPropagation();
                  q.onJump?.();
                }}
                onKeyDown={e => e.stopPropagation()}
              >
                {body}
              </button>
            ) : (
              <div key={i} data-testid="group-reply-preview" className={cls}>
                {body}
              </div>
            );
          })}
          <p className="whitespace-pre-wrap wrap-break-word">
            <LinkText
              segments={segments}
              onLinkClick={handleLinkClick}
              linkAriaLabel={content =>
                td('message_item.link_opens_new_tab', { content })
              }
            />
          </p>
          <p className="mt-1 text-[11px] opacity-70 text-right">
            {message.edited && (
              <span className="mr-1">{t('timeline.edited')}</span>
            )}
            {formatTime(toDate(shownTime))}
            {sending && (
              <Clock
                className="inline w-3 h-3 ml-1 align-[-2px]"
                aria-label={td('message_item.sending')}
                data-testid="group-message-sending"
              />
            )}
          </p>
        </div>
        <ReactionBar
          reactions={chips}
          message={message}
          isOutgoing={isOutgoing}
          onToggleReaction={toggle ? (m, emoji) => toggle(m, emoji) : undefined}
          onShowReactors={setReactorsOf}
        />
      </div>
      <MessageContextMenu
        items={items}
        isOpen={menuOpen}
        onClose={() => setMenuOpen(false)}
        isOutgoing={isOutgoing}
        canReact={!!toggle}
        reactions={chips}
        onSelectEmoji={emoji => toggle?.(message, emoji)}
        onOpenEmojiPicker={() => {
          setMenuOpen(false);
          setPickerOpen(true);
        }}
      />
      {toggle && (
        <EmojiPickerModal
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          title={td('message_item.add_reaction')}
          onSelectEmoji={emoji => {
            setPickerOpen(false);
            toggle(message, emoji);
          }}
        />
      )}
      <BaseModal
        isOpen={reactorsOf !== null}
        onClose={() => setReactorsOf(null)}
        title={`${t('reactions.title')} ${reactorsOf ?? ''}`}
      >
        <ul className="space-y-2" data-testid="reactors">
          {reactors.map(a => (
            <li key={a} className="text-sm text-foreground">
              <SafeName name={memberName ? memberName(a) : a} />
            </li>
          ))}
        </ul>
      </BaseModal>
    </div>
  );
};

export default GroupMessageItem;
