import React, { useEffect, useMemo, useState } from 'react';
import { Check } from 'react-feather';
import { useTranslation } from 'react-i18next';
import type { LeaveChoice } from '@massalabs/gossip-sdk';
import ChoiceSheet, { type Choice } from './ChoiceSheet';
import BaseModal from '../ui/BaseModal';
import Button from '../ui/Button';
import SafeName from './SafeName';
import ContactAvatar from '../avatar/ContactAvatar';

/** What the user chose in the leave, decline or owner popup. */
export type LeaveAction =
  | { type: 'leave'; choice: LeaveChoice }
  | { type: 'decline'; choice: LeaveChoice }
  | { type: 'handoverLeave'; newOwner: string }
  | { type: 'dissolve'; deleteMessages: boolean };

interface LeaveGroupSheetProps {
  isOpen: boolean;
  /** Declining an invitation or leaving an accepted group (§5.2). */
  mode: 'decline' | 'leave';
  /** The owner gets the popup of §5.8. */
  isOwner?: boolean;
  /** The other members, for "Hand over and leave". */
  otherMembers?: string[];
  memberName?: (userId: string) => string;
  onAction: (action: LeaveAction) => void;
  onClose: () => void;
}

type Pending = {
  kind: 'danger';
  action: LeaveAction;
  label: string;
  body: string;
} | null;

/**
 * The popups of §5.2 (decline, leave) and §5.8 (the owner's leave), with the
 * wording of the specification. Danger-zone choices ask once more.
 *
 * The owner of a chat with other members first sees "Pick the next owner"
 * (Lucas's screen 12): the members, and the hand-over button, disabled until
 * one is picked; the other choices of §5.8 follow in the danger zone below,
 * so that handing over stays the way to leave and the rest stays reachable.
 */
const LeaveGroupSheet: React.FC<LeaveGroupSheetProps> = ({
  isOpen,
  mode,
  isOwner = false,
  otherMembers = [],
  memberName = id => id,
  onAction,
  onClose,
}) => {
  const { t } = useTranslation('groups');
  const [pending, setPending] = useState<Pending>(null);
  const [nextOwner, setNextOwner] = useState<string | null>(null);
  const onlyMember = otherMembers.length === 0;
  const picksOwner = mode === 'leave' && isOwner && !onlyMember;
  useEffect(() => {
    if (isOpen) setNextOwner(null);
  }, [isOpen]);

  const choices: Choice[] = useMemo(() => {
    if (mode === 'leave' && isOwner) {
      if (onlyMember) {
        return [
          {
            key: 'delete',
            label: t('choices.delete_group'),
            description: t('choices.delete_group_body'),
            danger: true,
          },
          { key: 'cancel', label: t('choices.cancel') },
        ];
      }
      // Below the members to pick, in the danger zone.
      return [
        {
          key: 'dissolveKeep',
          label: t('choices.dissolve_keep'),
          description: t('choices.dissolve_keep_body'),
          danger: true,
        },
        {
          key: 'dissolveDelete',
          label: t('choices.dissolve_delete'),
          description: t('choices.dissolve_delete_body'),
          danger: true,
        },
        {
          key: 'ownerIgnore',
          label: t('choices.ignore'),
          description: t('choices.owner_ignore_body'),
          danger: true,
        },
      ];
    }
    const signed =
      mode === 'decline'
        ? {
            label: t('choices.decline_signed'),
            description: t('choices.decline_signed_body'),
          }
        : {
            label: t('choices.leave_signed'),
            description: t('choices.leave_signed_body'),
          };
    return [
      { key: 'signed', ...signed },
      {
        key: 'ask',
        label: t('choices.ask_kick'),
        description: t('choices.ask_kick_body'),
      },
      {
        key: 'ignore',
        label: t('choices.ignore'),
        description: t('choices.ignore_body'),
      },
      {
        key: 'cancel',
        label:
          mode === 'decline' ? t('choices.cancel') : t('choices.cancel_stay'),
      },
    ];
  }, [mode, isOwner, onlyMember, t]);

  const choose = (key: string) => {
    const leaveType = mode === 'decline' ? 'decline' : 'leave';
    switch (key) {
      case 'signed':
        onAction({ type: leaveType, choice: 'Signed' });
        return;
      case 'ask':
        onAction({ type: leaveType, choice: 'AskToBeKicked' });
        return;
      case 'ignore':
        onAction({ type: leaveType, choice: 'Silent' });
        return;
      case 'dissolveKeep':
        setPending({
          kind: 'danger',
          action: { type: 'dissolve', deleteMessages: false },
          label: t('choices.dissolve_keep'),
          body: t('choices.dissolve_keep_body'),
        });
        return;
      case 'dissolveDelete':
        setPending({
          kind: 'danger',
          action: { type: 'dissolve', deleteMessages: true },
          label: t('choices.dissolve_delete'),
          body: t('choices.dissolve_delete_body'),
        });
        return;
      case 'ownerIgnore':
        setPending({
          kind: 'danger',
          action: { type: 'leave', choice: 'Silent' },
          label: t('choices.ignore'),
          body: t('choices.owner_ignore_body'),
        });
        return;
      case 'delete':
        setPending({
          kind: 'danger',
          action: { type: 'leave', choice: 'Silent' },
          label: t('choices.delete_group'),
          body: t('choices.delete_group_body'),
        });
        return;
      default:
        onClose();
    }
  };

  const closeAll = () => {
    setPending(null);
    onClose();
  };

  return (
    <>
      <ChoiceSheet
        isOpen={isOpen && pending === null && !picksOwner}
        title={
          mode === 'decline'
            ? t('choices.decline_title')
            : t('choices.leave_title')
        }
        choices={choices}
        onSelect={choose}
        onClose={onClose}
      />
      <BaseModal
        isOpen={isOpen && pending?.kind === 'danger'}
        onClose={() => setPending(null)}
        title={t('choices.confirm_title')}
      >
        {pending?.kind === 'danger' && (
          <div className="space-y-4">
            <p className="text-sm font-medium text-destructive">
              {pending.label}
            </p>
            <p className="text-sm text-foreground">{pending.body}</p>
            <div className="flex gap-3">
              <Button
                onClick={() => {
                  const action = pending.action;
                  closeAll();
                  onAction(action);
                }}
                variant="danger"
                size="custom"
                className="flex-1 h-11 rounded-lg font-semibold"
              >
                {t('choices.confirm')}
              </Button>
              <Button
                onClick={() => setPending(null)}
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
      <BaseModal
        isOpen={isOpen && pending === null && picksOwner}
        onClose={onClose}
        title={t('choices.pick_next_owner')}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('choices.handover_leave_body')}
          </p>
          <ul
            className="max-h-[40vh] overflow-y-auto rounded-xl border border-border divide-y divide-border"
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
                    className={`w-full px-4 py-3 flex items-center gap-3 text-left text-sm text-foreground ${
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
                      className={`w-6 h-6 rounded-full border flex items-center justify-center shrink-0 ${
                        picked
                          ? 'bg-primary border-primary text-primary-foreground'
                          : 'border-border'
                      }`}
                    >
                      {picked && <Check className="w-4 h-4" />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <Button
            variant="danger"
            fullWidth
            disabled={nextOwner === null}
            data-testid="handover-leave"
            onClick={() => {
              if (nextOwner === null) return;
              const newOwner = nextOwner;
              closeAll();
              onAction({ type: 'handoverLeave', newOwner });
            }}
          >
            {t('choices.handover_leave')}
          </Button>
          <div className="pt-3 border-t border-border">
            <p className="px-4 pb-1 text-xs font-semibold uppercase tracking-wide text-destructive">
              {t('choices.danger_zone')}
            </p>
            {choices.map(choice => (
              <button
                key={choice.key}
                type="button"
                onClick={() => choose(choice.key)}
                className="w-full text-left px-4 py-3 rounded-lg transition-colors hover:bg-muted"
              >
                <span className="block text-sm font-medium text-destructive">
                  {choice.label}
                </span>
                <span className="block mt-1 text-xs text-muted-foreground">
                  {choice.description}
                </span>
              </button>
            ))}
          </div>
        </div>
      </BaseModal>
    </>
  );
};

export default LeaveGroupSheet;
