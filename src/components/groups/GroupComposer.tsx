import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, EyeOff, Users, X } from 'react-feather';
import type { GroupMessage } from '@massalabs/gossip-sdk';
import MessageInput, { type SendOptions } from '../discussions/MessageInput';
import ContactAvatar from '../avatar/ContactAvatar';
import Toggle from '../ui/Toggle';
import SafeName from './SafeName';
import { isolate } from '../../utils/groupName';

/**
 * Who sees a message, an edit or a deletion: every member ("for everyone",
 * the default of every action), or this device only.
 */
export type Scope = 'everyone' | 'me';

/** What the input shows of a group message being replied to or edited. */
export interface InputTarget {
  content: string;
  id?: number;
  message: GroupMessage;
}

interface GroupComposerProps {
  me: string;
  /** The members, for the author selector. */
  members: string[];
  memberName: (userId: string) => string;
  /**
   * The author button (UI5, UI6): a new message, or an edit, under any
   * member's name. Without it the user writes as themselves.
   */
  canChooseAuthor: boolean;
  /** The SDK can keep a new message on this device only (scope "me"). */
  canSendLocally: boolean;
  /**
   * Only "only for me" is possible: the chat is read only, and an edit is
   * saved on this device only.
   */
  localOnly?: boolean;
  /** Text to put in a fresh text box; a new `n` puts it in again. */
  draft: { text: string; n: number } | null;
  placeholderKey?: string;
  maxBytes?: number;
  onTooLong?: () => void;
  replyingTo: InputTarget | null;
  onCancelReply: () => void;
  editing: InputTarget | null;
  onCancelEdit: () => void;
  /** `author` is the user unless another member was chosen. */
  onSend: (text: string, options: { author: string; scope: Scope }) => void;
  /**
   * `author` is the author the message has after the edit: its current one
   * unless another member was chosen.
   */
  onEdit: (
    target: InputTarget,
    text: string,
    scope: Scope,
    author: string
  ) => void;
}

/** A row of the author selector. */
const AuthorRow: React.FC<{
  userId: string;
  name: string;
  hint: string;
  selected: boolean;
  onSelect: () => void;
}> = ({ userId, name, hint, selected, onSelect }) => (
  <li>
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className={`w-full min-h-14 flex items-center gap-3 px-4 py-3 text-left transition-colors ${
        selected ? 'bg-accent-soft/40' : 'hover:bg-muted'
      }`}
      data-testid="author-option"
    >
      <ContactAvatar contact={{ userId, name, avatar: undefined }} size={10} />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-foreground truncate">
          <SafeName name={name} />
        </span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      {selected && <Check className="w-5 h-5 text-foreground shrink-0" />}
    </button>
  </li>
);

/**
 * The composer of a chat (UI5, UI6, UI2, UI4, UI7): the text box of the
 * one-to-one chats, with the author button next to Send, the banner that
 * says when the message goes out under another member's name, and the scope
 * chosen by a long press on Send. Editing a message uses the same controls:
 * the author button starts on the message's author and can change it.
 *
 * The chosen author goes back to the user after each message sent, unless
 * "Keep sending as" is on; that switch is off each time the selector opens
 * (it never remembers "on"), and the whole state goes with the screen. An
 * edit's author is chosen for that edit only. The scope goes back to "for
 * everyone" after each send: acting only for oneself is possible but never
 * the default.
 *
 * Nothing here, or anywhere in the app, remembers which messages were sent or
 * edited only for this device: no mark, no label, no stored state. The engine
 * keeps no marker either; that is what makes it deniable.
 */
const GroupComposer: React.FC<GroupComposerProps> = ({
  me,
  members,
  memberName,
  canChooseAuthor,
  canSendLocally,
  localOnly = false,
  draft,
  placeholderKey,
  maxBytes,
  onTooLong,
  replyingTo,
  onCancelReply,
  editing,
  onCancelEdit,
  onSend,
  onEdit,
}) => {
  const { t } = useTranslation('groups');
  const [author, setAuthor] = useState(me);
  const [keepAuthor, setKeepAuthor] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [scope, setScope] = useState<Scope>('everyone');
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  // The author chosen for the edit in progress; null keeps the message's.
  const [editAuthor, setEditAuthor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // A new edit, or its end, starts again from "for everyone", with the
  // message's own author.
  const editKey = editing?.message.syncObjId ?? null;
  useEffect(() => {
    setScope('everyone');
    setScopeMenuOpen(false);
    setEditAuthor(null);
  }, [editKey]);

  // The scope menu closes on Escape and on a press outside it.
  useEffect(() => {
    if (!scopeMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setScopeMenuOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setScopeMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    menuRef.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [scopeMenuOpen]);

  // The scope that applies: a read-only chat only has "only for me".
  const effectiveScope: Scope = localOnly ? 'me' : scope;
  // "Only for me" is offered for an edit; for a new message only when the
  // SDK can keep one on this device.
  const scopeChoice = !localOnly && (editing !== null || canSendLocally);
  const authorShown = editing ? (editAuthor ?? editing.message.author) : author;
  const sendingAsOther = !editing && author !== me;
  const changingAuthor =
    editing !== null && authorShown !== editing.message.author;

  const afterSend = () => {
    setScope('everyone');
    if (!keepAuthor) setAuthor(me);
  };

  const openSelector = () => {
    // Never remembers "on": each opening starts with the switch off.
    setKeepAuthor(false);
    setSelectorOpen(true);
  };

  const scopeMenu = scopeMenuOpen ? (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('composer.scope_title')}
      className="absolute bottom-full right-0 mb-2 w-64 max-w-[calc(100vw-2rem)] bg-card border border-border rounded-xl shadow-xl overflow-hidden z-20"
      data-testid="scope-menu"
      onClick={e => e.stopPropagation()}
    >
      <p className="px-4 pt-3 pb-1 text-xs text-muted-foreground">
        {editing ? t('composer.scope_title_edit') : t('composer.scope_title')}
      </p>
      {(['everyone', 'me'] as const).map(s => (
        <button
          key={s}
          type="button"
          role="menuitemradio"
          aria-checked={scope === s}
          onClick={() => {
            setScope(s);
            setScopeMenuOpen(false);
          }}
          className="w-full min-h-12 flex items-center gap-3 px-4 py-2.5 text-left hover:bg-muted"
          data-testid={`scope-${s}`}
        >
          {s === 'everyone' ? (
            <Users className="w-4 h-4 text-muted-foreground shrink-0" />
          ) : (
            <EyeOff className="w-4 h-4 text-muted-foreground shrink-0" />
          )}
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-foreground">
              {s === 'everyone'
                ? t('composer.scope_everyone')
                : t('composer.scope_me')}
            </span>
            {s === 'me' && (
              <span className="block text-xs text-muted-foreground">
                {t('composer.scope_me_hint')}
              </span>
            )}
          </span>
          {scope === s && <Check className="w-4 h-4 text-foreground" />}
        </button>
      ))}
    </div>
  ) : null;

  const onlyMeMark = {
    icon: <EyeOff className="w-3 h-3" />,
    label: t('composer.scope_me'),
  };
  const sendOptions: SendOptions | undefined = scopeChoice
    ? {
        onOpen: () => setScopeMenuOpen(true),
        label: t('composer.scope_title'),
        menu: scopeMenu,
        mark: scope === 'me' ? onlyMeMark : null,
      }
    : localOnly
      ? {
          // Nothing to choose: the mark says where it goes.
          label: t('composer.scope_me'),
          mark: onlyMeMark,
        }
      : undefined;

  const sendLabel = editing
    ? effectiveScope === 'me'
      ? t('composer.save_edit_me')
      : t('composer.save_edit')
    : effectiveScope === 'me'
      ? t('composer.send_me')
      : undefined;

  const authorButton = canChooseAuthor ? (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation();
        openSelector();
      }}
      aria-haspopup="dialog"
      aria-label={t('composer.author_button', {
        name: isolate(memberName(authorShown)),
      })}
      title={t('composer.author_button', {
        name: isolate(memberName(authorShown)),
      })}
      className={`w-11 h-11 shrink-0 rounded-full flex items-center justify-center disabled:opacity-60 ${
        authorShown !== me ? 'ring-2 ring-foreground' : ''
      }`}
      data-testid="author-button"
    >
      <ContactAvatar
        contact={{
          userId: authorShown,
          name: memberName(authorShown),
          avatar: undefined,
        }}
        size={10}
      />
    </button>
  ) : null;

  const editBanner = changingAuthor ? (
    <div
      className="mb-2 flex items-center gap-3 px-3 py-2 rounded-xl border border-accent-soft bg-accent-soft/30"
      role="status"
      data-testid="edit-author-banner"
    >
      <ContactAvatar
        contact={{
          userId: authorShown,
          name: memberName(authorShown),
          avatar: undefined,
        }}
        size={8}
      />
      <p className="flex-1 min-w-0 text-sm text-foreground">
        {t('composer.edit_as', { name: isolate(memberName(authorShown)) })}
      </p>
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          setEditAuthor(null);
        }}
        aria-label={t('composer.edit_keep_author')}
        title={t('composer.edit_keep_author')}
        className="w-11 h-11 shrink-0 flex items-center justify-center rounded-full hover:bg-muted"
        data-testid="edit-author-reset"
      >
        <X className="w-4 h-4 text-muted-foreground" />
      </button>
    </div>
  ) : null;

  const banner = editing ? (
    editBanner
  ) : sendingAsOther ? (
    <div
      className="mb-2 flex items-center gap-3 px-3 py-2 rounded-xl border border-accent-soft bg-accent-soft/30"
      role="status"
      data-testid="sending-as-banner"
    >
      <ContactAvatar
        contact={{
          userId: author,
          name: memberName(author),
          avatar: undefined,
        }}
        size={8}
      />
      <p className="flex-1 min-w-0 text-sm text-foreground">
        {keepAuthor
          ? t('composer.sending_as_kept', { name: isolate(memberName(author)) })
          : t('composer.sending_as_once', {
              name: isolate(memberName(author)),
            })}
      </p>
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          setAuthor(me);
          setKeepAuthor(false);
        }}
        aria-label={t('composer.send_as_me')}
        title={t('composer.send_as_me')}
        className="w-11 h-11 shrink-0 flex items-center justify-center rounded-full hover:bg-muted"
        data-testid="sending-as-reset"
      >
        <X className="w-4 h-4 text-muted-foreground" />
      </button>
    </div>
  ) : null;

  const ordered = [me, ...members.filter(m => m !== me)];

  return (
    <>
      <MessageInput
        key={draft?.n ?? 0}
        initialValue={draft?.text}
        onSend={text => {
          const chosen = author;
          afterSend();
          onSend(text, { author: chosen, scope: effectiveScope });
        }}
        placeholderKey={placeholderKey}
        maxBytes={maxBytes}
        onTooLong={onTooLong}
        replyingTo={replyingTo}
        onCancelReply={onCancelReply}
        editingMessage={editing}
        editingLabel={
          editing
            ? editing.message.author === me
              ? t('composer.editing_own')
              : t('composer.editing_by', {
                  name: isolate(memberName(editing.message.author)),
                })
            : undefined
        }
        onCancelEdit={onCancelEdit}
        onConfirmEdit={(text, target) => {
          const s = effectiveScope;
          const a = authorShown;
          // The author chosen for new messages is not touched by an edit.
          setScope('everyone');
          setEditAuthor(null);
          onEdit(target, text, s, a);
        }}
        aboveInput={banner}
        beforeSend={authorButton}
        sendLabel={sendLabel}
        sendOptions={sendOptions}
      />
      {selectorOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          onClick={() => setSelectorOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={t('composer.send_as_title')}
          data-testid="author-selector"
        >
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative bg-background w-full max-w-md rounded-t-2xl max-h-[85vh] overflow-y-auto pb-safe-b"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-border">
              <h3 className="text-lg font-semibold text-foreground">
                {editing
                  ? t('composer.edit_as_title')
                  : t('composer.send_as_title')}
              </h3>
              <button
                type="button"
                onClick={() => setSelectorOpen(false)}
                aria-label={t('common:close')}
                className="w-11 h-11 -mr-3 flex items-center justify-center rounded-full hover:bg-muted"
              >
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <p className="text-sm text-muted-foreground">
                {editing
                  ? t('composer.edit_as_hint')
                  : t('composer.send_as_hint')}
              </p>
              {/* "Keep sending as" is about the next messages, not an edit. */}
              {!editing && (
                <div className="flex items-center gap-3">
                  <span className="flex-1 min-w-0">
                    <span
                      id="keep-sending-as"
                      className="block text-sm font-medium text-foreground"
                    >
                      {t('composer.keep_sending_as')}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {keepAuthor
                        ? t('composer.keep_sending_as_on')
                        : t('composer.keep_sending_as_off')}
                    </span>
                  </span>
                  <Toggle
                    checked={keepAuthor}
                    onChange={setKeepAuthor}
                    ariaLabel={t('composer.keep_sending_as')}
                  />
                </div>
              )}
              <ul
                role="menu"
                aria-label={t('composer.send_as_title')}
                className="border border-border rounded-xl overflow-hidden divide-y divide-border"
              >
                {ordered.map(m => (
                  <AuthorRow
                    key={m}
                    userId={m}
                    name={memberName(m)}
                    hint={
                      m === me
                        ? t('composer.send_as_me')
                        : t('composer.send_as_other', {
                            name: isolate(memberName(m)),
                          })
                    }
                    selected={authorShown === m}
                    onSelect={() => {
                      if (editing) {
                        setEditAuthor(m);
                      } else {
                        setAuthor(m);
                        if (m === me) setKeepAuthor(false);
                      }
                      setSelectorOpen(false);
                    }}
                  />
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default GroupComposer;
