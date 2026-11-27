import './matchMedia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import {
  SdkEventType,
  SessionStatus,
  type GossipSdk,
} from '@massalabs/gossip-sdk';
import NewGroup from '../../../src/pages/NewGroup';
import Discussions from '../../../src/pages/Discussions';
import ArchivedChats from '../../../src/pages/ArchivedChats';
import GroupSettings from '../../../src/pages/GroupSettings';
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

    it('keeps an archived chat in the archived list when a message arrives, with a dot on the "Archived chats" row', async () => {
      fake.state.groups = [
        summary({ groupId: 'g1', currentEpoch: 'g1', name: 'Brunch' }),
        summary({ groupId: 'g2', currentEpoch: 'g2', name: 'Lisbon' }),
      ];
      fake.state.archived = ['g2'];
      useGroupStore.getState().init();
      await act(flush);
      const r = await renderAt(<Discussions />);
      unmount = r.unmount;
      await act(flush);
      const row = () =>
        r.container.querySelector('[data-testid="archived-chats-row"]');
      // The earlier chat and the archived current chat.
      expect(row()?.textContent).toContain('2');
      expect(
        r.container.querySelector('[data-testid="archived-chats-unread"]')
      ).toBeNull();
      const names = () =>
        Array.from(r.container.querySelectorAll('[data-testid="group-row"]'))
          .map(e => e.textContent ?? '')
          .join('|');
      expect(names()).toContain('Brunch');
      expect(names()).not.toContain('Lisbon');

      // A message arrives in the archived chat: it stays archived.
      await act(async () => {
        fake.sdk.emit(SdkEventType.GROUPS_CHANGED, {
          changes: [{ groupId: 'g2', kind: 'Messages' }],
        });
        await flush();
      });
      expect(names()).not.toContain('Lisbon');
      expect(
        r.container.querySelector('[data-testid="archived-chats-unread"]')
      ).not.toBeNull();
      expect(fake.service.setArchived).not.toHaveBeenCalled();
      await unmount();

      // On the archived page, the chat shows its own unread dot.
      const a = await renderAt(<ArchivedChats />);
      unmount = a.unmount;
      await act(flush);
      const archivedRows = a.container.querySelectorAll(
        '[data-testid="group-row"]'
      );
      expect(archivedRows).toHaveLength(1);
      expect(archivedRows[0].textContent).toContain('Lisbon');
      expect(
        archivedRows[0].querySelector('[data-testid="group-unread"]')
      ).not.toBeNull();
      // The earlier chat is listed below it.
      expect(a.container.textContent).toContain('Olga');
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

  describe('chat settings (screens 09 to 13)', () => {
    async function openSettings(
      over: Parameters<typeof summary>[0] = {}
    ): Promise<HTMLDivElement> {
      useDiscussionStore.setState({
        contacts: [
          { userId: 'bob', name: 'Bob' },
          { userId: 'carl', name: 'Carl' },
          { userId: 'dan', name: 'Dan' },
        ] as never,
      });
      fake.state.groups = [
        summary({ members: ['me', 'bob', 'carl'], ...over }),
      ];
      useGroupStore.getState().init();
      await act(flush);
      const r = await renderAt(
        <GroupSettings />,
        '/group/g1/settings',
        '/group/:groupId/settings'
      );
      unmount = r.unmount;
      await act(flush);
      return r.container;
    }

    it('lists the members with their avatars, the owner marked, and "Add members" once, above them', async () => {
      const c = await openSettings();
      const list = c.querySelector('[data-testid="group-members"]')!;
      expect(list.querySelectorAll('li')).toHaveLength(3);
      expect(list.querySelectorAll('[role="img"]')).toHaveLength(3);
      expect(list.querySelectorAll('li')[0].textContent).toContain(
        'details.owner'
      );
      expect(buttonsNamed('details.add_members')).toHaveLength(1);
      expect(c.textContent).toContain('details.members · 3');
      // Never the user's own row.
      expect(
        list
          .querySelectorAll('li')[0]
          .querySelector('[data-testid="member-remove"]')
      ).toBeNull();
    });

    it('adds members with the picker of a new chat', async () => {
      await openSettings();
      await click(buttonsNamed('details.add_members')[0]);
      const boxes = document.querySelectorAll('[role="checkbox"]');
      expect(Array.from(boxes).map(b => b.getAttribute('aria-label'))).toEqual([
        'Dan',
      ]);
      await click(boxes[0]);
      const adds = buttonsNamed('details.add_members');
      await click(adds[adds.length - 1]);
      await act(flush);
      expect(fake.service.changeMembers).toHaveBeenCalledWith('g1', {
        add: ['dan'],
      });
    });

    it('removes a member only after the confirmation', async () => {
      const c = await openSettings();
      await click(c.querySelectorAll('[data-testid="member-remove"]')[0]);
      expect(document.body.textContent).toContain(
        'details.remove_title:\u2068Bob\u2069'
      );
      expect(fake.service.changeMembers).not.toHaveBeenCalled();
      await click(buttonsNamed('choices.cancel')[0]);
      expect(fake.service.changeMembers).not.toHaveBeenCalled();
      await click(c.querySelectorAll('[data-testid="member-remove"]')[0]);
      const confirm = buttonsNamed('details.remove');
      await click(confirm[confirm.length - 1]);
      await act(flush);
      expect(fake.service.changeMembers).toHaveBeenCalledWith('g1', {
        remove: ['bob'],
      });
    });

    const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
    const checked = (id: string) => q(id)?.getAttribute('aria-checked');
    const disabled = (id: string) => (q(id) as HTMLButtonElement).disabled;

    it('makes the owner pick the next owner before leaving, then confirm', async () => {
      await openSettings();
      await click(buttonsNamed('details.leave')[0]);
      expect(q('leave-chat-sheet')).not.toBeNull();
      // Handing over is the way offered first (screen 12).
      expect(checked('leave-how-handover')).toBe('true');
      expect(document.body.textContent).toContain('choices.pick_next_owner');
      expect(disabled('leave-chat-go')).toBe(true);
      // Leaving this way closes the chat here: only "Delete it" applies.
      expect(disabled('leave-keep-keep')).toBe(true);
      expect(checked('leave-keep-delete')).toBe('true');
      expect(q('leave-keep-fixed')?.textContent).toBe(
        'choices.keep_fixed_leave'
      );
      await click(document.querySelector('[data-testid="next-owner"]'));
      expect(disabled('leave-chat-go')).toBe(false);
      await click(q('leave-chat-go'));
      // The last confirmation, as for every way of leaving.
      expect(document.body.textContent).toContain('choices.confirm_title');
      expect(fake.service.handOver).not.toHaveBeenCalled();
      await click(q('leave-chat-confirm'));
      await act(flush);
      expect(fake.service.handOver).toHaveBeenCalledWith('g1', 'bob', {
        leave: true,
      });
      expect(fake.service.leave).not.toHaveBeenCalled();
      expect(fake.service.deleteGroup).not.toHaveBeenCalled();
    });

    it('lets the owner keep or delete a dissolved chat, the only way that can keep it', async () => {
      await openSettings();
      await click(buttonsNamed('details.leave')[0]);
      await click(q('leave-how-dissolveKeep'));
      expect(disabled('leave-keep-keep')).toBe(false);
      expect(checked('leave-keep-keep')).toBe('true');
      expect(q('leave-keep-fixed')).toBeNull();
      // "Delete it" turns the choice into "Dissolve & Delete".
      await click(q('leave-keep-delete'));
      expect(checked('leave-how-dissolveDelete')).toBe('true');
      await click(q('leave-keep-keep'));
      expect(checked('leave-how-dissolveKeep')).toBe('true');
      await click(q('leave-chat-go'));
      await click(q('leave-chat-confirm'));
      await act(flush);
      expect(fake.service.dissolve).toHaveBeenCalledWith('g1', false);
      // Kept, read only: the settings stay open.
      expect(q('elsewhere')).toBeNull();
    });

    it('deletes quietly as the owner with "Ignore and Delete"', async () => {
      await openSettings();
      await click(buttonsNamed('details.leave')[0]);
      await click(q('leave-how-ownerIgnore'));
      expect(disabled('leave-keep-keep')).toBe(true);
      expect(q('leave-keep-fixed')?.textContent).toBe(
        'choices.keep_fixed_quiet'
      );
      await click(q('leave-chat-go'));
      await click(q('leave-chat-confirm'));
      await act(flush);
      expect(fake.service.leave).toHaveBeenCalledWith('g1', 'Silent');
    });

    it('gives a member who is not the owner the three ways to leave, each deleting from this device', async () => {
      await openSettings({ owner: 'bob' });
      expect(buttonsNamed('details.add_members')).toHaveLength(0);
      expect(
        document.querySelector('[data-testid="member-remove"]')
      ).toBeNull();
      await click(buttonsNamed('details.leave')[0]);
      expect(document.body.textContent).not.toContain(
        'choices.pick_next_owner'
      );
      expect(q('leave-how-dissolveKeep')).toBeNull();
      // Nothing chosen yet: nothing can be confirmed.
      expect(disabled('leave-chat-go')).toBe(true);
      for (const [how, line] of [
        ['ask', 'choices.keep_fixed_quiet'],
        ['ignore', 'choices.keep_fixed_quiet'],
        ['signed', 'choices.keep_fixed_leave'],
      ]) {
        await click(q(`leave-how-${how}`));
        expect(disabled('leave-keep-keep')).toBe(true);
        expect(checked('leave-keep-delete')).toBe('true');
        expect(q('leave-keep-fixed')?.textContent).toBe(line);
      }
      // The visibility stays in brackets in the labels.
      expect(q('leave-how-signed')?.textContent).toContain(
        'choices.leave_signed'
      );
      await click(q('leave-chat-go'));
      await click(q('leave-chat-confirm'));
      await act(flush);
      // One engine operation: the signed leave is queued before the chat
      // closes on this device, never a leave then a delete.
      expect(fake.service.leave).toHaveBeenCalledWith('g1', 'Signed');
      expect(fake.service.deleteGroup).not.toHaveBeenCalled();
      expect(q('elsewhere')).not.toBeNull();
    });

    it('offers "Delete chat" only once the user is out of the chat, after a confirmation', async () => {
      const c = await openSettings({ status: 'left' });
      expect(buttonsNamed('details.leave')).toHaveLength(0);
      await click(buttonsNamed('details.delete_locally')[0]);
      expect(document.body.textContent).toContain('details.delete_title');
      expect(fake.service.deleteGroup).not.toHaveBeenCalled();
      const del = buttonsNamed('common:delete');
      await click(del[del.length - 1]);
      await act(flush);
      expect(fake.service.deleteGroup).toHaveBeenCalledWith('g1');
      expect(c.querySelector('[data-testid="elsewhere"]')).not.toBeNull();
    });

    it('archives the chat from its settings, a mark on this device only', async () => {
      await openSettings();
      const button = document.querySelector('[data-testid="chat-archive"]');
      expect(button?.textContent).toContain('details.archive');
      expect(button?.textContent).toContain('details.archive_hint');
      await click(button);
      await act(flush);
      expect(fake.service.setArchived).toHaveBeenCalledWith('g1', true);
      expect(
        document.querySelector('[data-testid="chat-archive"]')?.textContent
      ).toContain('details.unarchive');
      expect(fake.service.changeMembers).not.toHaveBeenCalled();
    });

    it('opens the leave screen with "Delete it" chosen on "Delete chat" while the user is a member', async () => {
      await openSettings({ owner: 'bob' });
      await click(buttonsNamed('details.delete_locally')[0]);
      expect(q('leave-chat-sheet')).not.toBeNull();
      expect(document.body.textContent).toContain('details.delete_title');
      expect(document.body.textContent).toContain('choices.delete_needs_leave');
      expect(checked('leave-keep-delete')).toBe('true');
      await click(q('leave-how-ignore'));
      await click(q('leave-chat-go'));
      expect(fake.service.leave).not.toHaveBeenCalled();
      await click(q('leave-chat-confirm'));
      await act(flush);
      expect(fake.service.leave).toHaveBeenCalledWith('g1', 'Silent');
      expect(fake.service.deleteGroup).not.toHaveBeenCalled();
    });
  });

  describe('the long press on a chat (screen 03)', () => {
    async function longPress(el: Element | null) {
      await act(async () => {
        el!.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        );
      });
    }

    async function openList(status: 'member' | 'left') {
      fake.state.groups = [summary({ status })];
      useGroupStore.getState().init();
      await act(flush);
      const r = await renderAt(<GroupListSection />);
      unmount = r.unmount;
      await act(flush);
      return r.container;
    }

    it('offers "Delete chat" on a chat the user is out of, with the confirmation of the settings', async () => {
      const c = await openList('left');
      await longPress(c.querySelector('[data-testid="group-row"]'));
      const item = Array.from(
        document.querySelectorAll('[role="menuitem"]')
      ).find(e => e.textContent === 'details.delete_locally');
      await click(item);
      // The row did not open the chat.
      expect(c.querySelector('[data-testid="elsewhere"]')).toBeNull();
      expect(document.body.textContent).toContain('details.delete_title');
      expect(fake.service.deleteGroup).not.toHaveBeenCalled();
      const del = buttonsNamed('common:delete');
      await click(del[del.length - 1]);
      await act(flush);
      expect(fake.service.deleteGroup).toHaveBeenCalledWith('g1');
    });

    it('offers archiving, leaving and "Delete chat" on a chat the user is in, "Delete chat" opening the leave screen', async () => {
      const c = await openList('member');
      await longPress(c.querySelector('[data-testid="group-row"]'));
      const items = () =>
        Array.from(document.querySelectorAll('[role="menuitem"]'));
      expect(items().map(e => e.textContent)).toEqual([
        'details.archive',
        'details.leave',
        'details.delete_locally',
      ]);
      await click(
        items().find(e => e.textContent === 'details.delete_locally')
      );
      expect(
        document.querySelector('[data-testid="leave-chat-sheet"]')
      ).not.toBeNull();
      expect(
        document
          .querySelector('[data-testid="leave-keep-delete"]')
          ?.getAttribute('aria-checked')
      ).toBe('true');
      expect(fake.service.leave).not.toHaveBeenCalled();
      expect(fake.service.deleteGroup).not.toHaveBeenCalled();
    });

    it('archives a chat from its long press, and moves it back from the archived list', async () => {
      const c = await openList('member');
      await longPress(c.querySelector('[data-testid="group-row"]'));
      const archive = Array.from(
        document.querySelectorAll('[role="menuitem"]')
      ).find(e => e.textContent === 'details.archive');
      await click(archive);
      await act(flush);
      expect(fake.service.setArchived).toHaveBeenCalledWith('g1', true);
      // Nothing is sent: no engine operation ran.
      expect(fake.service.leave).not.toHaveBeenCalled();
      expect(fake.service.deleteGroup).not.toHaveBeenCalled();
      expect(c.querySelector('[data-testid="group-row"]')).toBeNull();
      await unmount();

      const r = await renderAt(<GroupListSection archived />);
      unmount = r.unmount;
      await act(flush);
      await longPress(r.container.querySelector('[data-testid="group-row"]'));
      const unarchive = Array.from(
        document.querySelectorAll('[role="menuitem"]')
      ).find(e => e.textContent === 'details.unarchive');
      await click(unarchive);
      await act(flush);
      expect(fake.service.setArchived).toHaveBeenLastCalledWith('g1', false);
      expect(r.container.querySelector('[data-testid="group-row"]')).toBeNull();
    });
  });
});
