import './matchMedia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import GroupListSection from '../../../src/components/groups/GroupListSection';
import { useGroupStore } from '../../../src/stores/groupStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { makeFakeGroups, summary } from '../../helpers/fakeGroups';
import { useSdkStore } from '../../../src/stores/sdkStore';
import type { GossipSdk } from '@massalabs/gossip-sdk';
import { renderAt } from './render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('GroupListSection', () => {
  let unmount: () => Promise<void> = async () => {};
  afterEach(async () => {
    await unmount();
    useSdkStore.setState({ sdk: null });
  });

  it('leaves out a group its owner dissolved and deleted', async () => {
    useSdkStore.setState({
      sdk: makeFakeGroups().sdk as unknown as GossipSdk,
    });
    useAccountStore.setState({ userProfile: { userId: 'me' } as never });
    useGroupStore.setState({
      available: true,
      invitations: [],
      groups: [
        {
          summary: summary({ groupId: 'g1', name: 'Kept' }),
          lastMessage: null,
          unread: false,
        },
        {
          summary: summary({
            groupId: 'g2',
            name: 'Archived',
            status: 'dissolved',
          }),
          lastMessage: null,
          unread: false,
        },
        {
          summary: summary({
            groupId: 'g3',
            name: 'Erased',
            status: 'dissolved-deleted',
          }),
          lastMessage: null,
          unread: false,
        },
      ],
    } as never);
    const r = await renderAt(<GroupListSection />);
    unmount = r.unmount;
    const names = Array.from(
      r.container.querySelectorAll('[data-testid="group-row"]')
    ).map(e => e.textContent ?? '');
    expect(names.some(n => n.includes('Kept'))).toBe(true);
    expect(names.some(n => n.includes('Archived'))).toBe(true);
    expect(names.some(n => n.includes('Erased'))).toBe(false);
  });

  it("shows an invitation to continue a chat on that chat's row, not among the invitations", async () => {
    useSdkStore.setState({
      sdk: makeFakeGroups().sdk as unknown as GossipSdk,
    });
    useAccountStore.setState({ userProfile: { userId: 'me' } as never });
    useGroupStore.setState({
      available: true,
      invitations: [
        {
          epochId: 'g2',
          name: '',
          members: ['me', 'bob'],
          owner: 'bob',
          receivedFrom: null,
          closedBefore: false,
          rejoins: null,
          migrateFrom: 0,
          migrationOf: 'bob',
          continues: 'g1',
        },
      ],
      groups: [
        {
          summary: summary({ groupId: 'g1', name: 'Chat' }),
          lastMessage: null,
          unread: false,
        },
      ],
    } as never);
    const r = await renderAt(<GroupListSection />);
    unmount = r.unmount;
    const rows = r.container.querySelectorAll('[data-testid="group-row"]');
    expect(rows.length).toBe(1);
    expect(
      rows[0].querySelector('[data-testid="continuation-prompt"]')?.textContent
    ).toContain('archive.continue_invitation');
    expect(r.container.textContent).not.toContain('list.invitations_title');
  });
});
