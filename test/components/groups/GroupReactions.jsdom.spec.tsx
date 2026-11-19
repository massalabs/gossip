import './matchMedia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import type {
  GossipSdk,
  GroupMemberStatus,
  GroupTimelineItem,
} from '@massalabs/gossip-sdk';
import GroupDiscussion from '../../../src/pages/GroupDiscussion';
import { useSdkStore } from '../../../src/stores/sdkStore';
import { useGroupStore } from '../../../src/stores/groupStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { flush, makeFakeGroups, summary } from '../../helpers/fakeGroups';
import { byText, click, renderAt } from './render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
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
// The full picker, reduced to one emoji.
vi.mock('emoji-picker-react', () => ({
  default: ({
    onEmojiClick,
  }: {
    onEmojiClick: (d: { emoji: string }) => void;
  }) => (
    <button type="button" onClick={() => onEmojiClick({ emoji: '🦊' })}>
      picker-fox
    </button>
  ),
  Theme: { DARK: 'dark', LIGHT: 'light' },
  EmojiStyle: { NATIVE: 'native' },
}));

const message = (
  over: Partial<Extract<GroupTimelineItem, { kind: 'message' }>>
): GroupTimelineItem => ({
  kind: 'message',
  epochId: 'e1',
  syncObjId: 's1',
  author: 'bob',
  createdAt: 1_000n,
  lastModifiedAt: 1_000n,
  edited: false,
  body: { type: 'text', text: 'tent?' },
  metadata: {},
  replyTo: [],
  reactions: [],
  ...over,
});

describe('group reactions', () => {
  let fake: ReturnType<typeof makeFakeGroups>;
  let unmount: () => Promise<void> = async () => {};

  beforeEach(() => {
    fake = makeFakeGroups();
    useSdkStore.setState({ sdk: fake.sdk as unknown as GossipSdk });
    useAccountStore.setState({ userProfile: { userId: 'me' } as never });
  });

  afterEach(async () => {
    await unmount();
    useGroupStore.getState().cleanup();
    useSdkStore.setState({ sdk: null });
  });

  async function open(status: GroupMemberStatus = 'member') {
    fake.state.groups = [summary({ status })];
    fake.state.timelines.set('g1', [
      message({
        reactions: [
          { emoji: '👍', authors: ['me', 'bob'], mine: true },
          { emoji: '🎉', authors: ['bob'], mine: false },
        ],
      }),
      message({
        syncObjId: 's2',
        createdAt: 2_000n,
        body: { type: 'media', mimetype: 'image/png', dataLength: 10 },
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
    unmount = r.unmount;
    return r;
  }

  const chips = (root: ParentNode) =>
    Array.from(
      root.querySelectorAll<HTMLButtonElement>('[data-testid="reaction-chip"]')
    );

  it('shows a chip per emoji under the bubble, with its count, highlighted when this account reacted', async () => {
    const r = await open();
    const [first, second] = Array.from(
      r.container.querySelectorAll('[data-testid="group-message"]')
    );
    const c = chips(first);
    expect(c.map(b => b.textContent)).toEqual(['👍2', '🎉']);
    expect(c.map(b => b.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
    ]);
    expect(chips(second)).toEqual([]);
    // A media message shows a neutral placeholder, never its data.
    expect(second.textContent).toContain('timeline.media');
  });

  it("toggles this account's reaction by tapping a chip", async () => {
    const r = await open();
    const [mine, theirs] = chips(r.container);
    await click(mine);
    expect(fake.service.unreact).toHaveBeenCalledWith('g1', 's1', '👍');
    await click(theirs);
    expect(fake.service.react).toHaveBeenCalledWith('g1', 's1', '🎉');
  });

  it('reacts from the menu, with the quick emojis or the picker', async () => {
    const r = await open();
    const bubble = r.container
      .querySelectorAll('[data-testid="group-message"]')[1]
      .querySelector('[role="button"]');
    await click(bubble);
    // The quick emojis of the one-to-one menu.
    await click(
      Array.from(document.querySelectorAll('[role="button"]')).find(
        e => e.textContent === '❤️'
      )
    );
    expect(fake.service.react).toHaveBeenCalledWith('g1', 's2', '❤️');
    // "React" opens the full picker.
    await click(bubble);
    await click(byText('message_menu.react'));
    await act(flush);
    await click(byText('picker-fox'));
    expect(fake.service.react).toHaveBeenCalledWith('g1', 's2', '🦊');
  });

  it('shows who reacted on a long press of a chip', async () => {
    const r = await open();
    const [mine] = chips(r.container);
    await act(async () => {
      mine.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      );
    });
    const list = document.querySelector('[data-testid="reactors"]');
    expect(list?.textContent).toContain('list.you');
    expect(list?.textContent).toContain('bob');
    expect(fake.service.unreact).not.toHaveBeenCalled();
  });

  it('only shows reactions in a read-only chat: a tap lists who reacted', async () => {
    const r = await open('removed');
    const [mine] = chips(r.container);
    await click(mine);
    expect(fake.service.react).not.toHaveBeenCalled();
    expect(fake.service.unreact).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="reactors"]')?.textContent
    ).toContain('bob');
    const bubble = r.container
      .querySelectorAll('[data-testid="group-message"]')[0]
      .querySelector('[role="button"]');
    await click(bubble);
    expect(byText('message_menu.react')).toBeUndefined();
    expect(
      Array.from(document.querySelectorAll('[role="button"]')).some(
        e => e.textContent === '❤️'
      )
    ).toBe(false);
  });
});
