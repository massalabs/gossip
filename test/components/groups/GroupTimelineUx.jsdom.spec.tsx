import './matchMedia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import type { GossipSdk, GroupTimelineItem } from '@massalabs/gossip-sdk';
import GroupDiscussion from '../../../src/pages/GroupDiscussion';
import { useSdkStore } from '../../../src/stores/sdkStore';
import { useGroupStore } from '../../../src/stores/groupStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { flush, makeFakeGroups, summary } from '../../helpers/fakeGroups';
import { click, renderAt } from './render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const message = (
  over: Partial<Extract<GroupTimelineItem, { kind: 'message' }>>
): Extract<GroupTimelineItem, { kind: 'message' }> => ({
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

/** An IntersectionObserver the test drives: `show(el)` brings `el` into view. */
class FakeObserver {
  static all: FakeObserver[] = [];
  observed = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  static show(el: Element) {
    for (const o of FakeObserver.all) {
      if (!o.observed.has(el)) continue;
      o.callback(
        [{ target: el, isIntersecting: true } as IntersectionObserverEntry],
        o as unknown as IntersectionObserver
      );
    }
  }
}

describe('the timeline of a chat (G to K)', () => {
  let fake: ReturnType<typeof makeFakeGroups>;
  let unmount: () => Promise<void> = async () => {};

  beforeEach(() => {
    fake = makeFakeGroups();
    useSdkStore.setState({ sdk: fake.sdk as unknown as GossipSdk });
    useAccountStore.setState({ userProfile: { userId: 'me' } as never });
    FakeObserver.all = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(async () => {
    await unmount();
    useGroupStore.getState().cleanup();
    useSdkStore.setState({ sdk: null });
    vi.unstubAllGlobals();
  });

  async function open(items: GroupTimelineItem[], members = ['me', 'bob']) {
    fake.state.groups = [summary({ members })];
    fake.state.timelines.set('g1', items);
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(
      <GroupDiscussion />,
      '/group/g1',
      '/group/:groupId'
    );
    unmount = r.unmount;
    await act(flush);
    return r;
  }

  const rows = () =>
    Array.from(document.querySelectorAll('[data-testid="group-message"]'));

  describe('G: a reply shows what it replies to', () => {
    it('quotes the author and a line of the target, and a tap scrolls to it and marks it', async () => {
      await open([
        message({}),
        message({
          syncObjId: 's2',
          author: 'bob',
          body: { type: 'text', text: 'answer' },
          replyTo: [{ epochId: 'g1', syncObjId: 's1', message: null }],
        }),
      ]);
      const quote = rows()[1].querySelector(
        '[data-testid="group-reply-preview"]'
      ) as HTMLElement;
      expect(quote.tagName).toBe('BUTTON');
      expect(quote.textContent).toContain('list.you');
      expect(quote.textContent).toContain('question');
      await click(quote);
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
      expect(rows()[0].getAttribute('data-highlighted')).toBe('true');
      // The tap on the quote opens no menu.
      expect(document.body.textContent).not.toContain('message_menu.reply');
      await act(() => new Promise(r => setTimeout(r, 1_600)));
      expect(rows()[0].getAttribute('data-highlighted')).toBeNull();
    });

    it('shows a deleted target as not available, and a target of an epoch not held without a quote', async () => {
      await open([
        message({
          syncObjId: 's2',
          author: 'bob',
          body: { type: 'text', text: 'about the gone one' },
          replyTo: [{ epochId: 'g1', syncObjId: 'gone', message: null }],
        }),
        message({
          syncObjId: 's3',
          author: 'bob',
          body: { type: 'text', text: 'about the unknown one' },
          replyTo: [{ epochId: null, syncObjId: 'far', message: null }],
        }),
      ]);
      const gone = rows()[0].querySelector(
        '[data-testid="group-reply-preview"]'
      )!;
      expect(gone.tagName).toBe('DIV');
      expect(gone.textContent).toContain('timeline.reply_unavailable');
      expect(gone.querySelector('.italic')).not.toBeNull();
      expect(
        rows()[1].querySelector('[data-testid="group-reply-preview"]')
      ).toBeNull();
    });
  });

  describe('H: slide to reply', () => {
    function touch(el: Element, type: string, x: number, y: number) {
      const e = new Event(type, { bubbles: true, cancelable: true });
      const point = [{ clientX: x, clientY: y }];
      Object.defineProperty(e, 'touches', {
        value: type === 'touchend' ? [] : point,
      });
      Object.defineProperty(e, 'changedTouches', { value: point });
      el.dispatchEvent(e);
    }
    async function swipe(el: Element, dx: number, dy: number) {
      await act(async () => {
        touch(el, 'touchstart', 200, 200);
        touch(el, 'touchmove', 200 + dx / 2, 200 + dy / 2);
        touch(el, 'touchmove', 200 + dx, 200 + dy);
        touch(el, 'touchend', 200 + dx, 200 + dy);
      });
      await act(flush);
    }

    it('starts a reply on a horizontal swipe, never on a vertical one', async () => {
      await open([
        message({
          syncObjId: 's2',
          author: 'bob',
          body: { type: 'text', text: 'answer' },
        }),
      ]);
      const bubble = rows()[0].querySelector('[role="button"]')!;
      await swipe(bubble, 0, -120);
      expect(document.body.textContent).not.toContain(
        'message_input.replying_to'
      );
      await swipe(bubble, -120, 4);
      expect(document.body.textContent).toContain('message_input.replying_to');
      // The swipe opened no menu.
      expect(document.body.textContent).not.toContain('message_menu.delete');
    });
  });

  describe('I: the header opens the settings', () => {
    it('makes the whole title area a labelled button to the chat details', async () => {
      const r = await open([message({})]);
      const title = r.container.querySelector(
        '[data-testid="group-header-title"]'
      )!;
      expect(title.tagName).toBe('BUTTON');
      expect(title.getAttribute('aria-label')).toBe('details.open_settings');
      expect(title.textContent).toContain('Trip');
      await click(title);
      expect(
        r.container.querySelector('[data-testid="elsewhere"]')
      ).not.toBeNull();
    });
  });

  describe('J: avatars and names beside messages', () => {
    it('shows the avatar and name once per run of the same author, none on own messages', async () => {
      await open(
        [
          message({ syncObjId: 'a', author: 'bob' }),
          message({ syncObjId: 'b', author: 'bob' }),
          message({ syncObjId: 'c', author: 'carl' }),
          message({ syncObjId: 'd', author: 'me' }),
        ],
        ['me', 'bob', 'carl']
      );
      const has = (i: number, id: string) =>
        rows()[i].querySelector(`[data-testid="${id}"]`) !== null;
      expect([0, 1, 2, 3].map(i => has(i, 'group-message-avatar'))).toEqual([
        true,
        false,
        true,
        false,
      ]);
      expect([0, 1, 2, 3].map(i => has(i, 'group-message-author'))).toEqual([
        true,
        false,
        true,
        false,
      ]);
      // One colour per member.
      const color = (i: number) =>
        rows()[i].querySelector('[data-testid="group-message-author"]')!
          .className;
      expect(color(0)).not.toBe(color(2));
    });

    it('shows them in a chat of two as well, once per run', async () => {
      await open([
        message({ syncObjId: 'a', author: 'bob' }),
        message({ syncObjId: 'b', author: 'bob' }),
        message({ syncObjId: 'c', author: 'me' }),
      ]);
      const has = (i: number, id: string) =>
        rows()[i].querySelector(`[data-testid="${id}"]`) !== null;
      expect([0, 1, 2].map(i => has(i, 'group-message-avatar'))).toEqual([
        true,
        false,
        false,
      ]);
      expect([0, 1, 2].map(i => has(i, 'group-message-author'))).toEqual([
        true,
        false,
        false,
      ]);
    });
  });

  describe('K: a new message glows when it comes into view, seen locally only', () => {
    const READS = new Set(['list', 'get', 'invitations', 'timeline', 'epoch']);
    /** Calls of every SDK entry point that writes or sends. */
    function outgoing(): number {
      let n = 0;
      const count = (o: Record<string, unknown>) => {
        for (const [name, f] of Object.entries(o)) {
          if (READS.has(name)) continue;
          if (vi.isMockFunction(f)) n += f.mock.calls.length;
        }
      };
      count(fake.service as never);
      count(fake.sdk.conversations as never);
      count(fake.sdk.contacts as never);
      return n;
    }

    /**
     * Opens the chat once (it is all seen), leaves, gets a message from Bob,
     * opens it again, and brings the new message into view or not. Returns
     * the outgoing calls made from the moment it could be seen.
     */
    async function scenario(bringIntoView: boolean) {
      await open([message({})]);
      await unmount();
      fake.state.timelines.get('g1')!.push(
        message({
          syncObjId: 'new',
          author: 'bob',
          body: { type: 'text', text: 'hi' },
        })
      );
      const r = await renderAt(
        <GroupDiscussion />,
        '/group/g1',
        '/group/:groupId'
      );
      unmount = r.unmount;
      await act(flush);
      const fresh = r.container.querySelector('[data-fresh="g1:new"]');
      expect(fresh).not.toBeNull();
      const before = outgoing();
      if (bringIntoView) {
        await act(async () => FakeObserver.show(fresh!));
        await act(flush);
      }
      return { r, added: outgoing() - before };
    }

    it('glows, then fades, and is recorded as seen in memory', async () => {
      const markSeen = vi.spyOn(useGroupStore.getState(), 'markSeen');
      const { r } = await scenario(true);
      const row = r.container.querySelector(
        '[data-key="g1:new"] [data-testid="group-message"]'
      )!;
      expect(row.getAttribute('data-glow')).toBe('true');
      expect(markSeen).toHaveBeenCalledWith('g1', ['g1:new']);
      expect(useGroupStore.getState().seenOf('g1')?.has('g1:new')).toBe(true);
      expect(r.container.querySelector('[data-fresh]')).toBeNull();
      await act(() => new Promise(res => setTimeout(res, 1_300)));
      expect(row.getAttribute('data-glow')).toBeNull();
      // Own messages and those seen before never glow.
      expect(
        r.container.querySelector('[data-key="g1:s1"] [data-glow]')
      ).toBeNull();
    });

    it('sends nothing more because a message was seen', async () => {
      const seen = await scenario(true);
      await unmount();
      useGroupStore.getState().cleanup();
      fake = makeFakeGroups();
      useSdkStore.setState({ sdk: fake.sdk as unknown as GossipSdk });
      const notSeen = await scenario(false);
      // Unrelated traffic would show in both runs: only what seeing adds counts.
      expect(seen.added).toBe(notSeen.added);
    });

    it('marks as seen without calling the SDK at all', () => {
      const before = outgoing();
      const reads = fake.service.timeline.mock.calls.length;
      useGroupStore.getState().markSeen('g1', ['g1:x']);
      useGroupStore.getState().markRead('g1');
      expect(outgoing()).toBe(before);
      expect(fake.service.timeline.mock.calls.length).toBe(reads);
    });
  });
});
