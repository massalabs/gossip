import './matchMedia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { SessionStatus, type GossipSdk } from '@massalabs/gossip-sdk';
import NewGroup from '../../../src/pages/NewGroup';
import Discussions from '../../../src/pages/Discussions';
import ArchivedChats from '../../../src/pages/ArchivedChats';
import GroupListSection from '../../../src/components/groups/GroupListSection';
import { useDiscussionStore } from '../../../src/stores/discussionStore';
import { useSdkStore } from '../../../src/stores/sdkStore';
import { useGroupStore } from '../../../src/stores/groupStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { flush, makeFakeGroups, summary } from '../../helpers/fakeGroups';
import { byText, click, renderAt } from './render';

// Keys with their parameters, so that the tests can tell rows apart.
const tr = (key: string, o?: Record<string, unknown>) =>
  o && 'count' in o
    ? `${key}:${String(o.count)}`
    : o && 'name' in o
      ? `${key}:${String(o.name)}`
      : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tr }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
// The page layout persists scroll state through localStorage, which this
// environment lacks; the pages are tested without it.
vi.mock('../../../src/components/ui/Layout/PageLayout', () => ({
  default: ({
    header,
    subHeader,
    children,
    onScrollContainerRef,
  }: {
    header: React.ReactNode;
    subHeader?: React.ReactNode;
    children: React.ReactNode;
    onScrollContainerRef?: (node: HTMLDivElement | null) => void;
  }) => (
    <div>
      {header}
      {subHeader}
      <div ref={onScrollContainerRef}>{children}</div>
    </div>
  ),
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

// The virtualized list measures its rows, which this environment cannot:
// every row is rendered.
vi.mock('virtua', () => ({
  Virtualizer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/** Types `value` in the input `el`, as a user would. */
async function type(el: Element | null, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )!.set!;
    setter.call(el, value);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const buttonsNamed = (text: string) =>
  Array.from(document.querySelectorAll('button')).filter(
    b => b.textContent?.trim() === text
  );

describe('chat screens', () => {
  let fake: ReturnType<typeof makeFakeGroups>;
  let unmount: () => Promise<void> = async () => {};

  beforeEach(() => {
    fake = makeFakeGroups();
    useSdkStore.setState({ sdk: fake.sdk as unknown as GossipSdk });
    useAccountStore.setState({
      userProfile: { userId: 'me', username: 'Me' } as never,
    });
  });

  afterEach(async () => {
    await unmount();
    unmount = async () => {};
    useGroupStore.getState().cleanup();
    useSdkStore.setState({ sdk: null });
  });

  describe('creating a chat (screens 01 and 02)', () => {
    async function open() {
      fake.sdk.contacts.list.mockResolvedValue([
        { userId: 'alice', name: 'Alice Martin' },
        { userId: 'bob', name: 'Bob' },
      ] as never);
      fake.sdk.discussions.getStatus.mockReturnValue(0 as never);
      useGroupStore.getState().init();
      await act(flush);
      const r = await renderAt(<NewGroup />);
      unmount = r.unmount;
      await act(flush);
      return r;
    }

    it('asks for the members first, and goes on only once one is picked', async () => {
      const r = await open();
      // No name yet: the name is the second step.
      expect(r.container.querySelector('input#group-name')).toBeNull();
      const next = byText('common:next') as HTMLButtonElement;
      expect(next.disabled).toBe(true);
      const boxes = r.container.querySelectorAll('[role="checkbox"]');
      await click(boxes[1]);
      expect(boxes[1].getAttribute('aria-checked')).toBe('true');
      expect(
        r.container.querySelector('[data-testid="picked-members"]')?.textContent
      ).toContain('Bob');
      expect(next.disabled).toBe(false);
      // The chip above the list takes a member out again.
      await click(
        r.container.querySelector(
          '[aria-label="new_group.unselect:Bob"]'
        ) as HTMLElement
      );
      expect(boxes[1].getAttribute('aria-checked')).toBe('false');
      expect(next.disabled).toBe(true);
    });

    it('then asks for the name, lists the members with the user, and creates the chat', async () => {
      const r = await open();
      const boxes = r.container.querySelectorAll('[role="checkbox"]');
      await click(boxes[0]);
      await click(boxes[1]);
      await click(byText('common:next'));
      const members = r.container.querySelector(
        '[data-testid="new-chat-members"]'
      );
      expect(members?.textContent).toContain('list.you');
      expect(members?.textContent).toContain('Alice Martin');
      expect(members?.textContent).toContain('Bob');
      expect(r.container.textContent).toContain('new_group.members_title · 3');
      // Back keeps what was picked.
      await click(r.container.querySelector('button[aria-label="Back"]'));
      expect(
        r.container
          .querySelectorAll('[role="checkbox"]')[0]
          .getAttribute('aria-checked')
      ).toBe('true');
      await click(byText('common:next'));
      await type(r.container.querySelector('input#group-name'), 'Movie night');
      await click(buttonsNamed('new_group.create')[0]);
      await act(flush);
      expect(fake.service.createGroup).toHaveBeenCalledWith(
        'Movie night',
        ['alice', 'bob'],
        expect.objectContaining({ messageTimer: expect.any(Number) })
      );
    });
  });

  describe('the list (screens 03 and 14)', () => {
    const archive = (contactUserId: string, archived: boolean) => ({
      id: contactUserId.length,
      ownerUserId: 'me',
      contactUserId,
      isArchive: true,
      archived,
      linkedGroupId: null,
      unreadCount: 0,
      pinned: false,
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });

    beforeEach(() => {
      useDiscussionStore.setState({
        contacts: [
          { userId: 'old', name: 'Olga' },
          { userId: 'kept', name: 'Kim' },
        ] as never,
        discussions: [archive('old', true), archive('kept', false)] as never,
        sessionsStatuses: new Map([
          ['old', SessionStatus.Active],
          ['kept', SessionStatus.Active],
        ]),
        filter: 'all',
      });
      useAccountStore.setState({ isLoading: false });
    });

    it('shows an "Archived chats" row with its count, which replaced the filter, and leads to the archived list', async () => {
      useGroupStore.getState().init();
      await act(flush);
      const r = await renderAt(<Discussions />);
      unmount = r.unmount;
      await act(flush);
      const row = r.container.querySelector(
        '[data-testid="archived-chats-row"]'
      );
      expect(row?.textContent).toContain('archived.title');
      expect(row?.textContent).toContain('1');
      expect(r.container.textContent).not.toContain('filter.archived');
      await click(row);
      expect(
        r.container.querySelector('[data-testid="elsewhere"]')
      ).not.toBeNull();
    });

    it('shows no "Archived chats" row when nothing is archived', async () => {
      useDiscussionStore.setState({
        discussions: [archive('kept', false)] as never,
      });
      useGroupStore.getState().init();
      await act(flush);
      const r = await renderAt(<Discussions />);
      unmount = r.unmount;
      await act(flush);
      expect(
        r.container.querySelector('[data-testid="archived-chats-row"]')
      ).toBeNull();
    });

    it('lists the archived chats only on their own page', async () => {
      useGroupStore.getState().init();
      await act(flush);
      const r = await renderAt(<ArchivedChats />);
      unmount = r.unmount;
      await act(flush);
      expect(r.container.textContent).toContain('archived.title');
      expect(r.container.textContent).toContain('Olga');
      expect(r.container.textContent).not.toContain('Kim');
    });

    it('shows a chat with its members\' avatars and its last message as "Author: text"', async () => {
      useDiscussionStore.setState({
        contacts: [
          { userId: 'alice', name: 'Alice' },
          { userId: 'bob', name: 'Bob' },
        ] as never,
      });
      fake.state.groups = [
        summary({ name: 'Brunch', members: ['me', 'alice', 'bob'] }),
      ];
      fake.state.timelines.set('g1', [
        {
          kind: 'message',
          epochId: 'g1',
          syncObjId: 's1',
          author: 'alice',
          createdAt: 1_000n,
          lastModifiedAt: 1_000n,
          edited: false,
          body: { type: 'text', text: '12 Canal Street' },
          metadata: {},
          replyTo: [],
          reactions: [],
        },
      ]);
      useGroupStore.getState().init();
      await act(flush);
      const r = await renderAt(<GroupListSection />);
      unmount = r.unmount;
      await act(flush);
      expect(r.container.textContent).toContain('list.section_title');
      const row = r.container.querySelector('[data-testid="group-row"]')!;
      expect(row.querySelector('[data-testid="group-avatar"]')).not.toBeNull();
      expect(
        row.querySelector('[data-testid="group-preview"]')?.textContent
      ).toBe('Alice: 12 Canal Street');
    });
  });
});
