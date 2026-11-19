import './matchMedia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { GroupInvitation } from '@massalabs/gossip-sdk';
import GroupInvitationCard from '../../../src/components/groups/GroupInvitationCard';
import LeaveGroupSheet from '../../../src/components/groups/LeaveGroupSheet';
import { byText, click, renderAt } from './render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const invitation: GroupInvitation = {
  epochId: 'e1',
  name: 'Trip‮\nevil',
  members: ['owner', 'carol'],
  owner: 'owner',
  receivedFrom: 'carol',
  closedBefore: true,
  rejoins: null,
};

describe('GroupInvitationCard', () => {
  let unmount: () => Promise<void> = async () => {};
  afterEach(() => unmount());

  it('shows the verified owner, the members, who delivered it and the warning', async () => {
    const r = await renderAt(
      <GroupInvitationCard
        invitation={invitation}
        memberName={id => id.toUpperCase()}
        onAccept={vi.fn(async () => {})}
        onDecline={vi.fn(async () => {})}
      />
    );
    unmount = r.unmount;
    const text = r.container.textContent ?? '';
    expect(text).toContain('invitation.owner_verified');
    expect(text).toContain('OWNER');
    expect(text).toContain('invitation.received_from');
    expect(text).toContain('CAROL');
    expect(text).toContain('invitation.closed_before');
    // The untrusted name is one line, without its direction override.
    expect(text).toContain('Trip evil');
    expect(text).not.toContain('‮');
    expect(r.container.querySelector('bdi[dir="auto"]')).not.toBeNull();
  });

  it('accepts, and declines with the chosen way', async () => {
    const onAccept = vi.fn(async () => {});
    const onDecline = vi.fn(async () => {});
    const r = await renderAt(
      <GroupInvitationCard
        invitation={{ ...invitation, closedBefore: false }}
        memberName={id => id}
        onAccept={onAccept}
        onDecline={onDecline}
      />
    );
    unmount = r.unmount;
    await click(byText('invitation.accept'));
    expect(onAccept).toHaveBeenCalledWith('e1');
    await click(byText('invitation.decline'));
    for (const choice of [
      'choices.decline_signed',
      'choices.ask_kick',
      'choices.ignore',
      'choices.cancel',
    ]) {
      expect(byText(choice)).toBeDefined();
    }
    await click(byText('choices.ask_kick')?.closest('button'));
    expect(onDecline).toHaveBeenCalledWith('e1', 'AskToBeKicked');
  });
});

describe('LeaveGroupSheet', () => {
  let unmount: () => Promise<void> = async () => {};
  afterEach(() => unmount());

  it('gives the owner the hand-over and the danger zone, which asks again', async () => {
    const onAction = vi.fn();
    const r = await renderAt(
      <LeaveGroupSheet
        isOpen
        mode="leave"
        isOwner
        otherMembers={['bob']}
        onAction={onAction}
        onClose={vi.fn()}
      />
    );
    unmount = r.unmount;
    expect(byText('choices.handover_leave')).toBeDefined();
    expect(byText('choices.danger_zone')).toBeDefined();
    await click(byText('choices.dissolve_delete')?.closest('button'));
    expect(onAction).not.toHaveBeenCalled();
    await click(byText('choices.confirm'));
    expect(onAction).toHaveBeenCalledWith({
      type: 'dissolve',
      deleteMessages: true,
    });
  });

  it('asks the owner for the next owner on "hand over and leave"', async () => {
    const onAction = vi.fn();
    const r = await renderAt(
      <LeaveGroupSheet
        isOpen
        mode="leave"
        isOwner
        otherMembers={['bob']}
        memberName={id => `name-${id}`}
        onAction={onAction}
        onClose={vi.fn()}
      />
    );
    unmount = r.unmount;
    await click(byText('choices.handover_leave')?.closest('button'));
    await click(byText('name-bob')?.closest('button'));
    expect(onAction).toHaveBeenCalledWith({
      type: 'handoverLeave',
      newOwner: 'bob',
    });
  });

  it('offers only "Delete group" to an owner alone in the group', async () => {
    const r = await renderAt(
      <LeaveGroupSheet
        isOpen
        mode="leave"
        isOwner
        otherMembers={[]}
        onAction={vi.fn()}
        onClose={vi.fn()}
      />
    );
    unmount = r.unmount;
    expect(byText('choices.delete_group')).toBeDefined();
    expect(byText('choices.handover_leave')).toBeUndefined();
  });

  it('gives a member the three ways to leave', async () => {
    const onAction = vi.fn();
    const r = await renderAt(
      <LeaveGroupSheet
        isOpen
        mode="leave"
        onAction={onAction}
        onClose={vi.fn()}
      />
    );
    unmount = r.unmount;
    await click(byText('choices.leave_signed')?.closest('button'));
    expect(onAction).toHaveBeenCalledWith({ type: 'leave', choice: 'Signed' });
    expect(byText('choices.cancel_stay')).toBeDefined();
  });
});
