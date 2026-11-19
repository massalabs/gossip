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
});
