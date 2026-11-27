import React, { useEffect, useState } from 'react';
import { Check } from 'react-feather';
import { useTranslation } from 'react-i18next';
import BaseModal from '../ui/BaseModal';
import Button from '../ui/Button';
import SafeName from './SafeName';
import ContactAvatar from '../avatar/ContactAvatar';
import type { LeaveAction } from './LeaveGroupSheet';

/** The ways to leave offered on this screen. */
type How =
  | 'signed'
  | 'ask'
  | 'ignore'
  | 'handover'
  | 'dissolveKeep'
  | 'dissolveDelete'
  | 'ownerIgnore'
  | 'delete';

/** What stays on this device. */
type Keep = 'keep' | 'delete';

interface LeaveChatSheetProps {
  isOpen: boolean;
  isOwner: boolean;
  /** The other members, for "Hand over and leave". */
  otherMembers: string[];
  memberName: (userId: string) => string;
  /**
   * Opened from "Delete chat" on a chat the user is still in: "Delete it" is
   * preselected, and the screen says that leaving comes first.
   */
  deleting?: boolean;
  onAction: (action: LeaveAction) => void;
  onClose: () => void;
}

/**
 * What each way of leaving leaves on this device, as the engine does it: a
 * visible leave, a hand-over and leave, and both quiet ways close the chat on
 * this device at once (its messages are deleted; asking to be kicked keeps the
 * member list until the owner acts). Only dissolving lets the user keep the
 * chat, read only. The screen offers no other combination.
 */
function keepAllowed(how: How): Keep[] {
  return how === 'dissolveKeep' || how === 'dissolveDelete'
    ? ['keep', 'delete']
    : ['delete'];
}

/**
 * Leaving a chat, one screen with two questions (product owner, 2026-11-27):
 * how to leave (the choices of §5.2 with their visibility, and for the owner
 * the hand-over with the pick of the next owner, Lucas's screen 12, then the
 * danger zone of §5.8), and what to keep on this device. A last confirmation
 * follows: every way is final.
 */
const LeaveChatSheet: React.FC<LeaveChatSheetProps> = ({
  isOpen,
  isOwner,
  otherMembers,
  memberName,
  deleting = false,
  onAction,
  onClose,
}) => {
  const { t } = useTranslation('groups');
  const onlyMember = otherMembers.length === 0;
  const initialHow: How | null = isOwner
    ? onlyMember
      ? 'delete'
      : 'handover'
    : null;
  const [how, setHow] = useState<How | null>(initialHow);
  const [nextOwner, setNextOwner] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    setHow(initialHow);
    setNextOwner(null);
    setConfirming(false);
  }, [isOpen, initialHow]);

  type Option = { key: How; label: string; body: string; danger?: boolean };
  const memberOptions: Option[] = [
    {
      key: 'signed',
      label: t('choices.leave_signed'),
      body: t('choices.leave_signed_body'),
    },
    {
      key: 'ask',
      label: t('choices.ask_kick'),
      body: t('choices.ask_kick_body'),
    },
    {
      key: 'ignore',
      label: t('choices.ignore'),
      body: t('choices.ignore_body'),
    },
  ];
  const ownerDanger: Option[] = [
    {
      key: 'dissolveKeep',
      label: t('choices.dissolve_keep'),
      body: t('choices.dissolve_keep_body'),
      danger: true,
    },
    {
      key: 'dissolveDelete',
      label: t('choices.dissolve_delete'),
      body: t('choices.dissolve_delete_body'),
      danger: true,
    },
    {
      key: 'ownerIgnore',
      label: t('choices.ignore'),
      body: t('choices.owner_ignore_body'),
      danger: true,
    },
  ];
  const handover: Option = {
    key: 'handover',
    label: t('choices.handover_leave'),
    body: t('choices.handover_leave_body'),
  };
  const alone: Option = {
    key: 'delete',
    label: t('choices.delete_group'),
    body: t('choices.delete_group_body'),
    danger: true,
  };
  const all = [...memberOptions, ...ownerDanger, handover, alone];
  const chosen = all.find(o => o.key === how) ?? null;

  const allowed: Keep[] = how ? keepAllowed(how) : ['keep', 'delete'];
  const keep: Keep | null =
    how === 'dissolveKeep'
      ? 'keep'
      : how === null
        ? deleting
          ? 'delete'
          : null
        : 'delete';
  const fixedLine =
    how === null || allowed.length > 1
      ? null
      : how === 'ask' || how === 'ignore' || how === 'ownerIgnore'
        ? t('choices.keep_fixed_quiet')
        : t('choices.keep_fixed_leave');

  const chooseKeep = (k: Keep) => {
    if (!allowed.includes(k)) return;
    if (how === 'dissolveKeep' || how === 'dissolveDelete') {
      setHow(k === 'keep' ? 'dissolveKeep' : 'dissolveDelete');
    }
  };
  const chooseHow = (h: How) => setHow(h);

  const ready = how !== null && (how !== 'handover' || nextOwner !== null);
  const action = (): LeaveAction | null => {
    switch (how) {
      case 'signed':
        return { type: 'leave', choice: 'Signed' };
      case 'ask':
        return { type: 'leave', choice: 'AskToBeKicked' };
      case 'ignore':
      case 'ownerIgnore':
      case 'delete':
        return { type: 'leave', choice: 'Silent' };
      case 'handover':
        return nextOwner
          ? { type: 'handoverLeave', newOwner: nextOwner }
          : null;
      case 'dissolveKeep':
        return { type: 'dissolve', deleteMessages: false };
      case 'dissolveDelete':
        return { type: 'dissolve', deleteMessages: true };
      default:
        return null;
    }
  };

  const radio = (o: Option) => {
    const picked = how === o.key;
    return (
      <li key={o.key}>
        <button
          type="button"
          role="radio"
          aria-checked={picked}
          data-testid={`leave-how-${o.key}`}
          onClick={() => chooseHow(o.key)}
          className={`w-full px-4 py-3 flex items-start gap-3 text-left rounded-lg ${
            picked ? 'bg-accent-soft' : 'hover:bg-muted'
          }`}
        >
          <span
            className={`mt-0.5 w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
              picked
                ? 'bg-primary border-primary text-primary-foreground'
                : 'border-border'
            }`}
          >
            {picked && <Check className="w-3.5 h-3.5" />}
          </span>
          <span className="min-w-0">
            <span
              className={`block text-sm font-medium ${
                o.danger ? 'text-destructive' : 'text-foreground'
              }`}
            >
              {o.label}
            </span>
            <span className="block mt-1 text-xs text-muted-foreground">
              {o.body}
            </span>
          </span>
        </button>
      </li>
    );
  };

  const ownerPicker = (
    <div className="pl-12 pr-1 pb-2 space-y-2">
      <p className="text-xs text-muted-foreground">
        {t('choices.pick_next_owner')}
      </p>
      <ul
        className="max-h-[30vh] overflow-y-auto rounded-xl border border-border divide-y divide-border"
        role="radiogroup"
        aria-label={t('choices.pick_next_owner')}
      >
        {otherMembers.map(m => {
          const picked = nextOwner === m;
          return (
            <li key={m}>
              <button
                type="button"
                role="radio"
                aria-checked={picked}
                data-testid="next-owner"
                className={`w-full px-3 py-2.5 flex items-center gap-3 text-left text-sm text-foreground ${
                  picked ? 'bg-accent-soft' : 'hover:bg-muted'
                }`}
                onClick={() => setNextOwner(m)}
              >
                <ContactAvatar
                  contact={{ userId: m, name: memberName(m), avatar: null }}
                  size={8}
                />
                <span className="flex-1 min-w-0 truncate">
                  <SafeName name={memberName(m)} />
                </span>
                <span
                  className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                    picked
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-border'
                  }`}
                >
                  {picked && <Check className="w-3.5 h-3.5" />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );

  const keepOptions: { key: Keep; label: string }[] = [
    { key: 'keep', label: t('choices.keep_read_only') },
    { key: 'delete', label: t('choices.keep_delete') },
  ];

  const sectionTitle = (text: string, danger = false) => (
    <p
      className={`px-1 pb-1 text-xs font-semibold uppercase tracking-wide ${
        danger ? 'text-destructive' : 'text-muted-foreground'
      }`}
    >
      {text}
    </p>
  );

  return (
    <>
      <BaseModal
        isOpen={isOpen && !confirming}
        onClose={onClose}
        title={deleting ? t('details.delete_title') : t('choices.leave_title')}
      >
        <div className="space-y-4" data-testid="leave-chat-sheet">
          {deleting && (
            <p className="text-sm text-muted-foreground">
              {t('choices.delete_needs_leave')}
            </p>
          )}
          <section>
            {sectionTitle(t('choices.how_title'))}
            <ul role="radiogroup" aria-label={t('choices.how_title')}>
              {!isOwner && memberOptions.map(radio)}
              {isOwner && onlyMember && radio(alone)}
              {isOwner && !onlyMember && (
                <>
                  {radio(handover)}
                  {how === 'handover' && <li>{ownerPicker}</li>}
                </>
              )}
            </ul>
            {isOwner && !onlyMember && (
              <div className="mt-3 pt-3 border-t border-border">
                {sectionTitle(t('choices.danger_zone'), true)}
                <ul role="radiogroup" aria-label={t('choices.danger_zone')}>
                  {ownerDanger.map(radio)}
                </ul>
              </div>
            )}
          </section>
          <section className="pt-3 border-t border-border">
            {sectionTitle(t('choices.keep_title'))}
            <ul
              role="radiogroup"
              aria-label={t('choices.keep_title')}
              className="flex flex-col gap-1"
            >
              {keepOptions.map(k => {
                const picked = keep === k.key;
                const enabled = allowed.includes(k.key);
                return (
                  <li key={k.key}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={picked}
                      aria-disabled={!enabled}
                      disabled={!enabled}
                      data-testid={`leave-keep-${k.key}`}
                      onClick={() => chooseKeep(k.key)}
                      className={`w-full px-4 py-2.5 flex items-center gap-3 text-left text-sm rounded-lg ${
                        picked
                          ? 'bg-accent-soft'
                          : enabled
                            ? 'hover:bg-muted'
                            : ''
                      } ${enabled ? 'text-foreground' : 'text-muted-foreground opacity-60'}`}
                    >
                      <span
                        className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                          picked
                            ? 'bg-primary border-primary text-primary-foreground'
                            : 'border-border'
                        }`}
                      >
                        {picked && <Check className="w-3.5 h-3.5" />}
                      </span>
                      {k.label}
                    </button>
                  </li>
                );
              })}
            </ul>
            {fixedLine && (
              <p
                className="px-1 pt-2 text-xs text-muted-foreground"
                data-testid="leave-keep-fixed"
              >
                {fixedLine}
              </p>
            )}
          </section>
          <div className="flex gap-3 pt-1">
            <Button
              variant="secondary"
              size="custom"
              className="flex-1 h-11 rounded-full font-semibold"
              onClick={onClose}
            >
              {t('choices.cancel_stay')}
            </Button>
            <Button
              variant="danger"
              size="custom"
              className="flex-1 h-11 rounded-full font-semibold"
              disabled={!ready}
              data-testid="leave-chat-go"
              onClick={() => setConfirming(true)}
            >
              {deleting ? t('details.delete_locally') : t('details.leave')}
            </Button>
          </div>
        </div>
      </BaseModal>
      <BaseModal
        isOpen={isOpen && confirming}
        onClose={() => setConfirming(false)}
        title={t('choices.confirm_title')}
      >
        {chosen && (
          <div className="space-y-4">
            <p className="text-sm font-medium text-destructive">
              {chosen.label}
            </p>
            <p className="text-sm text-foreground">{chosen.body}</p>
            {fixedLine && (
              <p className="text-sm text-foreground">{fixedLine}</p>
            )}
            <div className="flex gap-3">
              <Button
                onClick={() => {
                  const a = action();
                  if (!a) return;
                  setConfirming(false);
                  onClose();
                  onAction(a);
                }}
                variant="danger"
                size="custom"
                className="flex-1 h-11 rounded-lg font-semibold"
                data-testid="leave-chat-confirm"
              >
                {t('choices.confirm')}
              </Button>
              <Button
                onClick={() => setConfirming(false)}
                variant="secondary"
                size="custom"
                className="flex-1 h-11 rounded-lg font-semibold"
              >
                {t('choices.cancel')}
              </Button>
            </div>
          </div>
        )}
      </BaseModal>
    </>
  );
};

export default LeaveChatSheet;
