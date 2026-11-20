import './matchMedia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import type { GossipSdk, GroupTimelineItem } from '@massalabs/gossip-sdk';
import GroupDiscussion from '../../../src/pages/GroupDiscussion';
import NewGroup from '../../../src/pages/NewGroup';
import GroupSettings from '../../../src/pages/GroupSettings';
import { useSdkStore } from '../../../src/stores/sdkStore';
import { useGroupStore } from '../../../src/stores/groupStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { useDiscussionStore } from '../../../src/stores/discussionStore';
import { flush, makeFakeGroups, summary } from '../../helpers/fakeGroups';
import { byText, click, renderAt } from './render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
// The page layout persists scroll state through localStorage, which this
// environment lacks; the pages are tested without it.
vi.mock('../../../src/components/ui/Layout/PageLayout', () => ({
  default: ({
    header,
    children,
  }: {
    header: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const message = (
  over: Partial<Extract<GroupTimelineItem, { kind: 'message' }>>
): GroupTimelineItem => ({
  kind: 'message',
  epochId: 'g1',
  syncObjId: 's1',
  author: 'me',
  createdAt: 1_000n,
  lastModifiedAt: 1_000n,
  edited: false,
  body: { type: 'text', text: 'question' },
  metadata: {},
  replyTo: [],
  reactions: [],
  ...over,
});

describe('group pages', () => {
  let fake: ReturnType<typeof makeFakeGroups>;
  let unmount: () => Promise<void> = async () => {};

  beforeEach(() => {
    fake = makeFakeGroups();
    useSdkStore.setState({ sdk: fake.sdk as unknown as GossipSdk });
    useAccountStore.setState({
      userProfile: { userId: 'me' } as never,
    });
  });

  afterEach(async () => {
    await unmount();
    useGroupStore.getState().cleanup();
    useSdkStore.setState({ sdk: null });
  });

  async function openGroup(status: 'member' | 'removed', mustResolve = false) {
    fake.state.groups = [summary({ status, mustResolve })];
    fake.state.timelines.set('g1', [
      {
        kind: 'line',
        at: 500n,
        line: { type: 'founded', epoch: 'g1', owner: 'me' },
      },
      message({}),
      message({
        syncObjId: 's2',
        author: 'bob',
        createdAt: 2_000n,
        lastModifiedAt: 2_000n,
        body: { type: 'text', text: 'answer' },
        replyTo: [{ epochId: 'g1', syncObjId: 's1' }],
      }),
    ]);
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(
      <GroupDiscussion />,
      '/group/g1',
      '/group/:groupId'
    );
    await act(flush);
    return r;
  }

  it('shows lines, messages, authors and reply previews in the timeline order', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    const timeline = r.container.querySelector(
      '[data-testid="group-timeline"]'
    )!;
    const children = Array.from(timeline.children).map(c =>
      c.getAttribute('data-testid')
    );
    expect(children).toEqual(['group-line', 'group-message', 'group-message']);
    const bobs = timeline.querySelectorAll('[data-testid="group-message"]')[1];
    expect(bobs.textContent).toContain('bob');
    expect(bobs.textContent).toContain('timeline.reply_to');
    expect(bobs.textContent).toContain('question');
    expect(r.container.querySelector('textarea')).not.toBeNull();
    expect(useGroupStore.getState().currentGroupId).toBe('g1');
  });

  it('shows the quote of a reply to a message of another chat, as the SDK gives it', async () => {
    fake.state.groups = [summary()];
    fake.state.timelines.set('g1', [
      message({
        syncObjId: 's2',
        author: 'bob',
        body: { type: 'text', text: 'about that' },
        replyTo: [
          {
            epochId: 'other',
            syncObjId: 'sx',
            message: message({
              epochId: 'other',
              syncObjId: 'sx',
              body: { type: 'text', text: 'over there' },
            }) as never,
          },
          { epochId: null, syncObjId: 'sy', message: null },
        ] as never,
      }),
    ]);
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(
      <GroupDiscussion />,
      '/group/g1',
      '/group/:groupId'
    );
    unmount = r.unmount;
    await act(flush);
    const text = r.container.querySelector(
      '[data-testid="group-message"]'
    )!.textContent;
    expect(text).toContain('over there');
    // A target not held yet says so; displaying it asks for nothing.
    expect(text).toContain('timeline.reply_unavailable');
  });

  it('shows the chats a chat replaced before its timeline, read only, and asks to continue in a new one', async () => {
    fake.state.groups = [
      summary({ groupId: 'g0', status: 'superseded', supersededBy: 'g1' }),
      summary({ earlier: ['g0'] }),
    ];
    fake.state.timelines.set('g0', [
      message({
        epochId: 'g0',
        syncObjId: 's0',
        body: { type: 'text', text: 'old' },
      }),
    ]);
    fake.state.timelines.set('g1', [message({})]);
    fake.state.invitations = [
      {
        epochId: 'g2',
        name: '',
        members: ['me', 'bob'],
        owner: 'bob',
        receivedFrom: null,
        closedBefore: false,
        rejoins: null,
        migrateFrom: 0,
        migrationOf: null,
        continues: 'g1',
      },
    ];
    useGroupStore.getState().init();
    await act(flush);
    expect(useGroupStore.getState().groups.map(g => g.summary.groupId)).toEqual(
      ['g1']
    );
    expect(useGroupStore.getState().supersededBy).toEqual({ g0: 'g1' });
    const r = await renderAt(
      <GroupDiscussion />,
      '/group/g1',
      '/group/:groupId'
    );
    unmount = r.unmount;
    await act(flush);
    const earlier = r.container.querySelector('[data-testid="earlier-chats"]')!;
    expect(earlier.textContent).toContain('old');
    expect(
      earlier.querySelector('[data-testid="earlier-junction"]')
    ).not.toBeNull();
    const prompt = r.container.querySelector(
      '[data-testid="continuation-prompt"]'
    )!;
    expect(prompt.textContent).toContain('archive.continue_invitation');
    expect(
      prompt.querySelector('[data-testid="continuation-accept"]')
    ).not.toBeNull();
    // Still writable: declining changes nothing.
    expect(r.container.querySelector('textarea')).not.toBeNull();
  });

  it('says its status rather than a member count once removed, and a neutral placeholder in a chat of two', async () => {
    const r = await openGroup('removed');
    unmount = r.unmount;
    const header = r.container.querySelector('h1')!.parentElement!;
    expect(header.textContent).toContain('details.status_removed');
    expect(header.textContent).not.toContain('list.members_count');
    await unmount();
    useGroupStore.getState().cleanup();
    const m = await openGroup('member');
    unmount = m.unmount;
    expect(
      m.container.querySelector('textarea')!.getAttribute('placeholder')
    ).toBe('message_input.placeholder');
  });

  it('disables the composer with its reason when read only', async () => {
    const r = await openGroup('removed');
    unmount = r.unmount;
    const blocked = r.container.querySelector(
      '[data-testid="composer-blocked"]'
    );
    expect(blocked?.textContent).toContain('composer.disabled_removed');
    expect(r.container.querySelector('textarea')).toBeNull();
  });

  it('points the owner to the resolution when competing ends wait', async () => {
    const r = await openGroup('member', true);
    unmount = r.unmount;
    const blocked = r.container.querySelector(
      '[data-testid="composer-blocked"]'
    );
    expect(blocked?.textContent).toContain('composer.disabled_resolve');
    expect(blocked?.textContent).toContain('details.resolve_open');
  });

  it("offers only local actions on someone else's message, and confirms them", async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    const bubble = r.container
      .querySelectorAll('[data-testid="group-message"]')[1]
      .querySelector('[role="button"]');
    await click(bubble);
    expect(byText('message_menu.edit')).toBeUndefined();
    expect(byText('message_menu.delete_everyone')).toBeUndefined();
    await click(byText('message_menu.delete_locally'));
    expect(fake.service.deleteMessageLocally).not.toHaveBeenCalled();
    expect(byText('message_menu.delete_locally_body')).toBeDefined();
    await click(byText('choices.confirm'));
    expect(fake.service.deleteMessageLocally).toHaveBeenCalledWith('g1', 's2');
  });

  it('lets the author delete for everyone after a confirmation', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    const bubble = r.container
      .querySelectorAll('[data-testid="group-message"]')[0]
      .querySelector('[role="button"]');
    await click(bubble);
    await click(byText('message_menu.delete_everyone'));
    await click(byText('choices.confirm'));
    expect(fake.service.deleteMessage).toHaveBeenCalledWith('g1', 's1');
  });

  it('keeps the text of a message the group refuses, and says it is too long', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    fake.service.sendMessage.mockRejectedValueOnce(
      new Error('groups:change: does not fit one empty container')
    );
    const textarea = r.container.querySelector(
      'textarea'
    ) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )!.set!;
      setter.call(textarea, 'a very long text');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    await act(flush);
    expect(fake.service.sendMessage).toHaveBeenCalledWith(
      'g1',
      'a very long text',
      { replyTo: undefined }
    );
    const toast = (await import('react-hot-toast')).default;
    expect(toast.error).toHaveBeenCalledWith('composer.too_long');
    expect(
      (r.container.querySelector('textarea') as HTMLTextAreaElement).value
    ).toBe('a very long text');
  });

  /** Types `text` into `textarea` as a paste would. */
  async function typeInto(textarea: HTMLTextAreaElement, text: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )!.set!;
      setter.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  /** The toast errors shown since the last call. */
  async function toastErrors(): Promise<unknown[]> {
    const toast = vi.mocked((await import('react-hot-toast')).default);
    const shown = toast.error.mock.calls.map(c => c[0]);
    toast.error.mockClear();
    return shown;
  }

  async function pressEnter(textarea: HTMLTextAreaElement) {
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    await act(flush);
  }

  it('counts the composer text in UTF-8 bytes and keeps a text over the limit', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    const textarea = r.container.querySelector(
      'textarea'
    ) as HTMLTextAreaElement;
    const counter = () =>
      r.container.querySelector('[data-testid="message-size-counter"]');
    // 8,193 characters of one byte each: far from the limit, no counter.
    await typeInto(textarea, 'x'.repeat(8_193));
    expect(counter()).toBeNull();
    // 14,800 bytes: near the limit.
    await typeInto(textarea, '\u00e9'.repeat(7_400));
    expect(counter()?.textContent).toBe('message_input.size_counter');
    expect(counter()?.className).not.toContain('text-destructive');
    // The same 8,193 characters at two bytes each: over the limit. A paste
    // over it is kept, and sending says it is too long.
    const long = '\u00e9'.repeat(8_193);
    await typeInto(textarea, long);
    expect(counter()?.className).toContain('text-destructive');
    await toastErrors();
    await pressEnter(textarea);
    expect(fake.service.sendMessage).not.toHaveBeenCalled();
    expect(await toastErrors()).toEqual(['composer.too_long']);
    expect(textarea.value).toBe(long);
    // At the limit exactly, it is sent.
    await typeInto(textarea, '\u00e9'.repeat(8_192));
    await pressEnter(textarea);
    expect(fake.service.sendMessage).toHaveBeenCalledWith(
      'g1',
      '\u00e9'.repeat(8_192),
      { replyTo: undefined }
    );
  });

  it('keeps an edit over the limit in the input', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    const bubble = r.container
      .querySelectorAll('[data-testid="group-message"]')[0]
      .querySelector('[role="button"]');
    await click(bubble);
    await click(byText('message_menu.edit'));
    const textarea = r.container.querySelector(
      'textarea'
    ) as HTMLTextAreaElement;
    const long = 'y'.repeat(16_385);
    await typeInto(textarea, long);
    await toastErrors();
    await pressEnter(textarea);
    expect(fake.service.editMessage).not.toHaveBeenCalled();
    expect(await toastErrors()).toEqual(['composer.too_long']);
    expect(textarea.value).toBe(long);
    expect(byText('message_input.editing')).toBeDefined();
  });

  it('does not save a local edit over the limit, and keeps its text', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    const bubble = r.container
      .querySelectorAll('[data-testid="group-message"]')[1]
      .querySelector('[role="button"]');
    await click(bubble);
    await click(byText('message_menu.edit_locally'));
    const field = document.getElementById('local-edit') as HTMLTextAreaElement;
    expect(field.value).toBe('answer');
    const long = '\u00e9'.repeat(8_193);
    await typeInto(field, long);
    expect(byText('composer.edit_too_long')).toBeDefined();
    const save = byText('common:save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await click(save);
    expect(fake.service.editMessageLocally).not.toHaveBeenCalled();
    expect(field.value).toBe(long);
    // Near the limit the size shows; within it, it saves.
    await typeInto(field, '\u00e9'.repeat(8_000));
    expect(byText('composer.edit_too_long')).toBeUndefined();
    expect(byText('discussions:message_input.size_counter')).toBeDefined();
    await click(byText('common:save'));
    expect(fake.service.editMessageLocally).toHaveBeenCalledWith('g1', 's2', {
      body: { type: 'text', text: '\u00e9'.repeat(8_000) },
    });
  });

  it('creates a group with contacts that have an active session only', async () => {
    fake.sdk.contacts.list.mockResolvedValue([
      { userId: 'alice', name: 'Alice' },
      { userId: 'carl', name: 'Carl' },
    ] as never);
    fake.sdk.discussions.getStatus.mockImplementation(((id: string) =>
      id === 'alice' ? 0 : 2) as never);
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(<NewGroup />);
    unmount = r.unmount;
    await act(async () => {});
    const boxes = r.container.querySelectorAll('[role="checkbox"]');
    expect(boxes).toHaveLength(1);
    expect(boxes[0].textContent).toContain('Alice');
    const input = r.container.querySelector(
      'input#group-name'
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )!.set!;
      setter.call(input, 'Trip');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(boxes[0]);
    await click(byText('new_group.create'));
    await act(flush);
    // The creator's default timer, pre-selected: the earlier 1 month as 28 days.
    expect(fake.service.createGroup).toHaveBeenCalledWith('Trip', ['alice'], {
      messageTimer: 2_419_200_000,
    });
    expect(
      r.container.querySelector('[data-testid="elsewhere"]')
    ).not.toBeNull();
  });

  it('picks a contact to add by tapping its name', async () => {
    useDiscussionStore.setState({
      contacts: [{ userId: 'carl', name: 'Carl' }] as never,
    });
    fake.state.groups = [summary()];
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(
      <GroupSettings />,
      '/group/g1/settings',
      '/group/:groupId/settings'
    );
    unmount = r.unmount;
    await act(flush);
    await click(byText('details.add_members'));
    // the name, not the box
    await click(
      Array.from(document.querySelectorAll('span')).find(
        e => e.textContent === 'Carl'
      )
    );
    const box = document.querySelector(
      'input[type="checkbox"][aria-label="Carl"]'
    ) as HTMLInputElement;
    expect(box.checked).toBe(true);
    const adds = Array.from(document.querySelectorAll('button')).filter(
      b => b.textContent?.trim() === 'details.add_members'
    );
    await click(adds[adds.length - 1]);
    await act(flush);
    expect(fake.service.changeMembers).toHaveBeenCalledWith('g1', {
      add: ['carl'],
    });
  });

  it("shows former owners' branches as information and lets the owner merge them", async () => {
    fake.state.groups = [
      summary({ members: ['me', 'bob', 'old'], formerOwnerBranches: ['f1'] }),
    ];
    fake.service.epoch.mockImplementation((async (e: string) => ({
      epoch: e,
      name: '',
      members: e === 'f1' ? ['old', 'bob'] : ['me', 'bob'],
      owner: e === 'f1' ? 'old' : 'me',
      createdAt: e === 'f1' ? 1n : 2n,
    })) as never);
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(
      <GroupSettings />,
      '/group/g1/settings',
      '/group/:groupId/settings'
    );
    unmount = r.unmount;
    await act(flush);
    const section = r.container.querySelector(
      '[data-testid="former-owner-branches"]'
    );
    expect(section?.textContent).toContain('details.former_branches_hint');
    // Nothing is blocked: no resolution is required of the owner.
    expect(
      r.container.querySelector('[data-testid="resolve-fork"]')
    ).toBeNull();
    await click(byText('details.former_branches_resolve'));
    expect(
      r.container.querySelector('[data-testid="resolve-fork"]')
    ).not.toBeNull();
  });
});
