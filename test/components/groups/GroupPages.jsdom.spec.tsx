import './matchMedia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import type { GossipSdk, GroupTimelineItem } from '@massalabs/gossip-sdk';
import GroupDiscussion from '../../../src/pages/GroupDiscussion';
import NewGroup from '../../../src/pages/NewGroup';
import { useSdkStore } from '../../../src/stores/sdkStore';
import { useGroupStore } from '../../../src/stores/groupStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { makeFakeGroups, summary } from '../../helpers/fakeGroups';
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
  createdAt: 1_000,
  lastModifiedAt: 1_000,
  edited: false,
  body: { type: 'text', text: 'question' },
  metadata: {},
  replyTo: [],
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

  function openGroup(status: 'member' | 'removed', mustResolve = false) {
    fake.state.groups = [summary({ status, mustResolve })];
    fake.state.timelines.set('g1', [
      {
        kind: 'line',
        at: 500,
        line: { type: 'founded', epoch: 'g1', owner: 'me' },
      },
      message({}),
      message({
        syncObjId: 's2',
        author: 'bob',
        createdAt: 2_000,
        lastModifiedAt: 2_000,
        body: { type: 'text', text: 'answer' },
        replyTo: [{ epochId: 'g1', syncObjId: 's1' }],
      }),
    ]);
    useGroupStore.getState().init();
    return renderAt(<GroupDiscussion />, '/group/g1', '/group/:groupId');
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

  it('creates a group with contacts that have an active session only', async () => {
    fake.sdk.contacts.list.mockResolvedValue([
      { userId: 'alice', name: 'Alice' },
      { userId: 'carl', name: 'Carl' },
    ] as never);
    fake.sdk.discussions.getStatus.mockImplementation(((id: string) =>
      id === 'alice' ? 0 : 2) as never);
    useGroupStore.getState().init();
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
    expect(fake.service.createGroup).toHaveBeenCalledWith('Trip', ['alice']);
    expect(
      r.container.querySelector('[data-testid="elsewhere"]')
    ).not.toBeNull();
  });
});
