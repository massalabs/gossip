import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LeaveChoice } from '@massalabs/gossip-sdk';
import ChoiceSheet, { type Choice } from './ChoiceSheet';
import BaseModal from '../ui/BaseModal';
import Button from '../ui/Button';
import SafeName from './SafeName';

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

type Pending =
  | { kind: 'danger'; action: LeaveAction; label: string; body: string }
  | { kind: 'pickOwner' }
  | null;

/**
 * The popups of §5.2 (decline, leave) and §5.8 (the owner's leave), in the
 * order and wording of the specification. Danger-zone choices ask once more.
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
  const onlyMember = otherMembers.length === 0;

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
      return [
        {
          key: 'handover',
          label: t('choices.handover_leave'),
          description: t('choices.handover_leave_body'),
        },
        { key: 'cancel', label: t('choices.cancel_stay') },
        {
          key: 'dissolveKeep',
          label: t('choices.dissolve_keep'),
          description: t('choices.dissolve_keep_body'),
          danger: true,
          sectionTitle: t('choices.danger_zone'),
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
      case 'handover':
        setPending({ kind: 'pickOwner' });
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
        isOpen={isOpen && pending === null}
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
        isOpen={isOpen && pending?.kind === 'pickOwner'}
        onClose={() => setPending(null)}
        title={t('choices.pick_next_owner')}
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('choices.handover_leave_body')}
          </p>
          <ul className="max-h-[50vh] overflow-y-auto divide-y divide-border">
            {otherMembers.map(m => (
              <li key={m}>
                <button
                  type="button"
                  className="w-full text-left px-2 py-3 text-sm text-foreground hover:bg-muted rounded"
                  onClick={() => {
                    closeAll();
                    onAction({ type: 'handoverLeave', newOwner: m });
                  }}
                >
                  <SafeName name={memberName(m)} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </BaseModal>
    </>
  );
};

export default LeaveGroupSheet;
