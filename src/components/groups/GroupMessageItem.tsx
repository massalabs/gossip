import React, { useCallback, useMemo, useState } from 'react';
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
import SafeName from './SafeName';
import { isolate } from '../../utils/groupName';
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
  /** The text of the messages it replies to, or null when not available. */
  replyPreviews: (string | null)[];
  /**
   * For each message it replies to, the name of the group it is in when
   * that is another group (§7.6 "Display"), else null.
   */
  replyGroups?: (string | null)[];
  canWrite: boolean;
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
  replyPreviews,
  replyGroups,
  canWrite,
  memberName,
  sending = false,
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

  return (
    <div
      className={`flex flex-col max-w-[80%] sm:max-w-[70%] md:max-w-[65%] lg:max-w-[60%] my-1 ${
        isOutgoing ? 'ml-auto mr-3' : 'ml-3 mr-auto'
      } ${sending ? 'opacity-70' : ''}`}
      data-testid="group-message"
      data-sending={sending || undefined}
    >
      {!isOutgoing && (
        <p className="px-1 pb-0.5 text-xs font-medium text-muted-foreground">
          <SafeName name={authorName} />
        </p>
      )}
      <div
        className={`relative px-3.5 py-3 font-normal text-[15px] leading-tight rounded-2xl select-none cursor-pointer focus:outline-none ${
          isOutgoing
            ? 'bg-bubble-sent text-bubble-sent-foreground'
            : 'bg-bubble-received text-bubble-received-foreground'
        } ${menuOpen ? 'shadow-xl brightness-[1.08]' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => {
          if (longPress.longPressTriggered.current) return;
          openMenu();
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') openMenu();
        }}
        onTouchStart={longPress.onTouchStart}
        onTouchMove={longPress.onTouchMove}
        onTouchEnd={longPress.onTouchEnd}
        onContextMenu={longPress.onContextMenu}
      >
        {replyPreviews.map((preview, i) => (
          <div
            key={i}
            data-testid="group-reply-preview"
            className="mb-2 pl-2 border-l-2 border-current/40 text-xs opacity-80 truncate"
          >
            <span className="font-medium">
              {t('timeline.reply_to')}
              {preview !== null && replyGroups?.[i]
                ? ` (${t('timeline.reply_in_group', { name: isolate(replyGroups[i]) })})`
                : ''}
              :{' '}
            </span>
            {preview ?? t('timeline.reply_unavailable')}
          </div>
        ))}
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
