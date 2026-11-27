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
import enGroups from '../../../src/i18n/locales/en/groups.json';
import frGroups from '../../../src/i18n/locales/fr/groups.json';
import ruGroups from '../../../src/i18n/locales/ru/groups.json';
import zhGroups from '../../../src/i18n/locales/zh-CN/groups.json';

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
    const children = Array.from(timeline.children).map(
      c =>
        c.getAttribute('data-testid') ??
        c.firstElementChild?.getAttribute('data-testid')
    );
    expect(children).toEqual(['group-line', 'group-message', 'group-message']);
    const bobs = timeline.querySelectorAll('[data-testid="group-message"]')[1];
    expect(bobs.textContent).toContain('bob');
    expect(bobs.textContent).toContain('list.you');
    expect(bobs.textContent).toContain('question');
    // A target in the same group names no group.
    expect(bobs.textContent).not.toContain('timeline.reply_in_group');
    expect(r.container.querySelector('textarea')).not.toBeNull();
    expect(useGroupStore.getState().currentGroupId).toBe('g1');
  });

  it('shows the quote of a reply to a message of another chat, as the SDK gives it', async () => {
    fake.state.groups = [
      summary(),
      summary({
        groupId: 'camp',
        currentEpoch: 'other',
        name: 'Camp',
        timers: [{ epochId: 'other', messageTimer: 0, startedAt: 0n }],
      }),
    ];
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
    // The group it is in (§7.6 "Display").
    const quotes = Array.from(
      r.container.querySelectorAll('[data-testid="group-reply-preview"]')
    ).map(q => q.textContent);
    expect(quotes[0]).toContain('timeline.reply_in_group');
    // A target in an epoch this device lacks has no quote (protocol limit);
    // displaying it asks for nothing.
    expect(quotes).toHaveLength(1);
  });

  it('says "in <group>" in every language', () => {
    for (const locale of [enGroups, frGroups, ruGroups, zhGroups]) {
      expect(locale.timeline.reply_in_group).toContain('{{name}}');
    }
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
    const header =
      r.container.querySelector('[role="heading"]')!.parentElement!;
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

  /** Opens the menu of the `i`-th message. */
  async function openMenu(r: { container: HTMLDivElement }, i: number) {
    const rows = r.container.querySelectorAll('[data-testid="group-message"]');
    await click(rows[i].querySelector('[role="button"]'));
  }

  it("offers one Edit and one Delete on every message, someone else's included", async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    for (const i of [0, 1]) {
      await openMenu(r, i);
      expect(byText('message_menu.edit')).toBeDefined();
      expect(byText('message_menu.delete')).toBeDefined();
      for (const gone of [
        'message_menu.delete_everyone',
        'message_menu.delete_locally',
        'message_menu.edit_locally',
      ]) {
        expect(byText(gone)).toBeUndefined();
      }
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
      await act(flush);
    }
  });

  it('asks for whom a deletion is, and each button calls its method', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    // Someone else's message, for everyone (the first, main button).
    await openMenu(r, 1);
    await click(byText('message_menu.delete'));
    expect(fake.service.deleteMessage).not.toHaveBeenCalled();
    const confirm = document.querySelector('[data-testid="delete-confirm"]')!;
    const buttons = Array.from(confirm.querySelectorAll('button')).map(b =>
      b.textContent?.trim()
    );
    expect(buttons).toEqual([
      'message_menu.delete_everyone',
      'message_menu.delete_on_device',
      'choices.cancel',
    ]);
    await click(byText('message_menu.delete_everyone'));
    await act(flush);
    expect(fake.service.deleteMessage).toHaveBeenCalledWith('g1', 's2');
    expect(fake.service.deleteMessageLocally).not.toHaveBeenCalled();
    // Only on this device.
    await openMenu(r, 0);
    await click(byText('message_menu.delete'));
    await click(byText('message_menu.delete_on_device'));
    await act(flush);
    expect(fake.service.deleteMessageLocally).toHaveBeenCalledWith('g1', 's1');
    // Cancel deletes nothing.
    await openMenu(r, 0);
    await click(byText('message_menu.delete'));
    await click(byText('choices.cancel'));
    await act(flush);
    expect(fake.service.deleteMessage).toHaveBeenCalledTimes(1);
    expect(fake.service.deleteMessageLocally).toHaveBeenCalledTimes(1);
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
    await openMenu(r, 0);
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
    expect(byText('composer.editing_own')).toBeDefined();
  });

  const sendButton = () =>
    document.querySelector('[data-testid="send-button"]') as HTMLElement;
  const textOf = (r: { container: HTMLDivElement }) =>
    (r.container.querySelector('textarea') as HTMLTextAreaElement).value;

  /** Holds the Send button down for longer than a long press. */
  async function longPress(el: Element) {
    await act(async () => {
      el.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 })
      );
      await new Promise(res => setTimeout(res, 600));
      el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
  }

  it("edits someone else's message from the text box, with its text and author, for everyone by a plain tap", async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    const textarea = r.container.querySelector(
      'textarea'
    ) as HTMLTextAreaElement;
    await typeInto(textarea, 'half typed');
    await openMenu(r, 1);
    await click(byText('message_menu.edit'));
    await act(flush);
    expect(textOf(r)).toBe('answer');
    // The author is shown, and stays the message's author.
    expect(byText('composer.editing_by')).toBeDefined();
    expect(sendButton().getAttribute('aria-label')).toBe('composer.save_edit');
    await typeInto(
      r.container.querySelector('textarea') as HTMLTextAreaElement,
      'better answer'
    );
    await click(sendButton());
    await act(flush);
    expect(fake.service.editMessage).toHaveBeenCalledWith(
      'g1',
      's2',
      'better answer'
    );
    expect(fake.service.editMessageLocally).not.toHaveBeenCalled();
    // What was typed before the edit comes back.
    expect(textOf(r)).toBe('half typed');
    expect(byText('composer.editing_by')).toBeUndefined();
  });

  it('gives the typed text back when an edit is cancelled', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    await typeInto(
      r.container.querySelector('textarea') as HTMLTextAreaElement,
      'draft'
    );
    await openMenu(r, 0);
    await click(byText('message_menu.edit'));
    await act(flush);
    expect(textOf(r)).toBe('question');
    await click(
      document.querySelector('[aria-label="message_input.cancel_edit"]')
    );
    await act(flush);
    expect(textOf(r)).toBe('draft');
    expect(fake.service.editMessage).not.toHaveBeenCalled();
  });

  it('opens the scope menu by a long press on Send without sending, and saves an edit only for me', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    await openMenu(r, 1);
    await click(byText('message_menu.edit'));
    await act(flush);
    await longPress(sendButton());
    expect(document.querySelector('[data-testid="scope-menu"]')).not.toBeNull();
    expect(fake.service.editMessage).not.toHaveBeenCalled();
    // "For everyone" is the one checked.
    expect(
      document
        .querySelector('[data-testid="scope-everyone"]')!
        .getAttribute('aria-checked')
    ).toBe('true');
    await click(document.querySelector('[data-testid="scope-me"]'));
    expect(document.querySelector('[data-testid="scope-menu"]')).toBeNull();
    expect(document.querySelector('[data-testid="send-mark"]')).not.toBeNull();
    expect(sendButton().getAttribute('aria-label')).toBe(
      'composer.save_edit_me'
    );
    await typeInto(
      r.container.querySelector('textarea') as HTMLTextAreaElement,
      'my version'
    );
    await click(sendButton());
    await act(flush);
    expect(fake.service.editMessageLocally).toHaveBeenCalledWith('g1', 's2', {
      body: { type: 'text', text: 'my version' },
      author: undefined,
    });
    expect(fake.service.editMessage).not.toHaveBeenCalled();
    // Back to "for everyone" after the send.
    expect(document.querySelector('[data-testid="send-mark"]')).toBeNull();
  });

  it('opens the scope menu by a right-click and by a button for the keyboard', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    await openMenu(r, 0);
    await click(byText('message_menu.edit'));
    await act(flush);
    await act(async () => {
      sendButton().dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      );
    });
    expect(document.querySelector('[data-testid="scope-menu"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(document.querySelector('[data-testid="scope-menu"]')).toBeNull();
    const options = document.querySelector('[data-testid="send-options"]')!;
    expect(options.getAttribute('aria-haspopup')).toBe('menu');
    expect(options.getAttribute('aria-label')).toBe('composer.scope_title');
    await click(options);
    expect(document.querySelector('[data-testid="scope-menu"]')).not.toBeNull();
    expect(fake.service.editMessage).not.toHaveBeenCalled();
  });

  it('offers "only for me" for a new message by a long press, and sends it locally', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    expect(
      document.querySelector('[data-testid="send-options"]')
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="author-button"]')
    ).not.toBeNull();
    const textarea = r.container.querySelector(
      'textarea'
    ) as HTMLTextAreaElement;
    await typeInto(textarea, 'a note to myself');
    await longPress(sendButton());
    expect(document.querySelector('[data-testid="scope-menu"]')).not.toBeNull();
    expect(fake.service.sendMessage).not.toHaveBeenCalled();
    await click(document.querySelector('[data-testid="scope-me"]'));
    expect(sendButton().getAttribute('aria-label')).toBe('composer.send_me');
    await click(sendButton());
    await act(flush);
    expect(fake.service.sendMessageLocally).toHaveBeenCalledWith(
      'g1',
      'a note to myself',
      { replyTo: undefined, author: undefined }
    );
    expect(fake.service.sendMessage).not.toHaveBeenCalled();
    // Back to "for everyone" for the next one.
    expect(document.querySelector('[data-testid="send-mark"]')).toBeNull();
    await typeInto(
      r.container.querySelector('textarea') as HTMLTextAreaElement,
      'to all'
    );
    await click(sendButton());
    await act(flush);
    expect(fake.service.sendMessage).toHaveBeenCalledWith('g1', 'to all', {
      replyTo: undefined,
      author: undefined,
    });
  });

  it('sends a message as another member chosen with the author button', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    await click(document.querySelector('[data-testid="author-button"]'));
    const bob = Array.from(
      document.querySelectorAll('[data-testid="author-option"]')
    ).find(b => b.textContent?.includes('bob'));
    await click(bob);
    await typeInto(
      r.container.querySelector('textarea') as HTMLTextAreaElement,
      'signed bob'
    );
    await click(sendButton());
    await act(flush);
    expect(fake.service.sendMessage).toHaveBeenCalledWith('g1', 'signed bob', {
      replyTo: undefined,
      author: 'bob',
    });
    // The next one is the user's again.
    await typeInto(
      r.container.querySelector('textarea') as HTMLTextAreaElement,
      'me again'
    );
    await click(sendButton());
    await act(flush);
    expect(fake.service.sendMessage).toHaveBeenLastCalledWith(
      'g1',
      'me again',
      { replyTo: undefined, author: undefined }
    );
  });

  it('edits with the author preselected, and changes it for everyone or only for me', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    // Bob's message: the selector starts on Bob.
    await openMenu(r, 1);
    await click(byText('message_menu.edit'));
    await act(flush);
    await click(document.querySelector('[data-testid="author-button"]'));
    const rows = () =>
      Array.from(document.querySelectorAll('[data-testid="author-option"]'));
    const checked = rows().find(b => b.getAttribute('aria-checked') === 'true');
    expect(checked?.textContent).toContain('bob');
    // No "Keep sending as" for an edit.
    expect(document.querySelector('[role="switch"]')).toBeNull();
    // The user takes it.
    await click(rows()[0]);
    expect(
      document.querySelector('[data-testid="edit-author-banner"]')
    ).not.toBeNull();
    await typeInto(
      r.container.querySelector('textarea') as HTMLTextAreaElement,
      'mine now'
    );
    await click(sendButton());
    await act(flush);
    expect(fake.service.editMessage).toHaveBeenCalledWith(
      'g1',
      's2',
      'mine now',
      { author: 'me' }
    );
    // The user's own message, given to Bob only for me.
    await openMenu(r, 0);
    await click(byText('message_menu.edit'));
    await act(flush);
    await click(document.querySelector('[data-testid="author-button"]'));
    await click(rows().find(b => b.textContent?.includes('bob')));
    await longPress(sendButton());
    await click(document.querySelector('[data-testid="scope-me"]'));
    await click(sendButton());
    await act(flush);
    expect(fake.service.editMessageLocally).toHaveBeenCalledWith('g1', 's1', {
      body: { type: 'text', text: 'question' },
      author: 'bob',
    });
    // The next edit starts again from the message's own author.
    await openMenu(r, 1);
    await click(byText('message_menu.edit'));
    await act(flush);
    expect(
      document.querySelector('[data-testid="edit-author-banner"]')
    ).toBeNull();
  });

  it('warns before every "Retry synchronisation", and retries only on confirmation', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    for (const i of [0, 1]) {
      await openMenu(r, i);
      await click(byText('message_menu.retry'));
      await act(flush);
      expect(document.body.textContent).toContain('message_menu.retry_title');
      expect(byText('message_menu.retry_body')).toBeDefined();
      expect(fake.service.retryMessage).not.toHaveBeenCalled();
      await click(byText('choices.cancel'));
      await act(flush);
      expect(fake.service.retryMessage).not.toHaveBeenCalled();
    }
    await openMenu(r, 1);
    await click(byText('message_menu.retry'));
    await click(byText('message_menu.retry_confirm'));
    await act(flush);
    expect(fake.service.retryMessage).toHaveBeenCalledWith('g1', 's2');
    expect(fake.service.retryMessage).toHaveBeenCalledTimes(1);
  });

  it('marks no message sent only for me, and keeps nothing that tells which one it was', async () => {
    const r = await openGroup('member');
    unmount = r.unmount;
    fake.service.sendMessageLocally.mockResolvedValueOnce({
      syncObjId: 'zz9',
    });
    await typeInto(
      r.container.querySelector('textarea') as HTMLTextAreaElement,
      'just here'
    );
    await longPress(sendButton());
    await click(document.querySelector('[data-testid="scope-me"]'));
    await click(sendButton());
    await act(flush);
    // The engine now shows it like any message: the timeline gives it back.
    fake.state.timelines.set('g1', [
      ...(fake.state.timelines.get('g1') ?? []),
      message({
        syncObjId: 'zz9',
        createdAt: 3_000n,
        lastModifiedAt: 3_000n,
        body: { type: 'text', text: 'just here' },
      }),
    ]);
    await act(async () => {
      useGroupStore.getState().refresh();
    });
    await act(flush);
    const timeline = r.container.querySelector(
      '[data-testid="group-timeline"]'
    )!;
    const rows = Array.from(
      timeline.querySelectorAll('[data-testid="group-message"]')
    );
    const local = rows.find(x => x.textContent?.includes('just here'))!;
    const other = rows.find(x => x.textContent?.includes('question'))!;
    expect(local).toBeDefined();
    // No label, no dashed outline, no attribute that differs from a message
    // sent to everyone.
    expect(local.textContent).not.toMatch(/only|scope|local|composer\./i);
    expect(local.outerHTML).not.toMatch(/dashed|only|scope_me|EyeOff/i);
    const attrs = (e: Element) =>
      Array.from(e.querySelectorAll('*'))
        .concat(e)
        .map(
          n =>
            (n.getAttribute('class') ?? '') +
            (n.getAttribute('data-testid') ?? '')
        )
        .join('|');
    expect(attrs(local)).toBe(attrs(other));
    // Nothing in the app's stores names it.
    const after = JSON.stringify(useGroupStore.getState(), (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v
    );
    // Its ID is in no store; the chat list shows it as the last message, as
    // it would any message the engine shows.
    expect(after).not.toContain('zz9');
    expect(after).not.toMatch(/only|scope|local(?!Name)/i);
  });

  it('shows no "only for you" label on an edited message', async () => {
    fake.state.groups = [summary()];
    fake.state.timelines.set('g1', [
      message({ edited: true, lastModifiedAt: 2_000n }),
      message({ syncObjId: 's2', author: 'bob', edited: true }),
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
    const timeline = r.container.querySelector(
      '[data-testid="group-timeline"]'
    )!.textContent!;
    expect(timeline).toContain('timeline.edited');
    expect(timeline).not.toMatch(/only|scope|local/i);
  });

  it('in a read-only chat, edits and deletes on this device only', async () => {
    const r = await openGroup('removed');
    unmount = r.unmount;
    expect(r.container.querySelector('textarea')).toBeNull();
    await openMenu(r, 1);
    await click(byText('message_menu.edit'));
    await act(flush);
    expect(textOf(r)).toBe('answer');
    // Nothing to choose: the mark says it stays on this device.
    expect(document.querySelector('[data-testid="send-mark"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="send-options"]')).toBeNull();
    await click(sendButton());
    await act(flush);
    expect(fake.service.editMessageLocally).toHaveBeenCalledWith('g1', 's2', {
      body: { type: 'text', text: 'answer' },
    });
    expect(fake.service.editMessage).not.toHaveBeenCalled();
    expect(r.container.querySelector('textarea')).toBeNull();
    await openMenu(r, 1);
    await click(byText('message_menu.delete'));
    const buttons = Array.from(
      document
        .querySelector('[data-testid="delete-confirm"]')!
        .querySelectorAll('button')
    ).map(b => b.textContent?.trim());
    expect(buttons).toEqual([
      'message_menu.delete_on_device',
      'choices.cancel',
    ]);
  });

  describe('a message being sent (D5)', () => {
    /** A `sendMessage` that settles when the test says so. */
    function deferSend() {
      let resolve!: (syncObjId: string) => void;
      let reject!: (e: Error) => void;
      fake.service.sendMessage.mockImplementationOnce(
        () =>
          new Promise((res, rej) => {
            resolve = syncObjId =>
              res({ eventId: 'ev', syncObjId, merge: 'Won' });
            reject = rej;
          })
      );
      return {
        resolve: (id: string) =>
          act(async () => {
            resolve(id);
            await flush();
          }),
        reject: (e: Error) =>
          act(async () => {
            reject(e);
            await flush();
          }),
      };
    }

    const rows = (r: { container: HTMLDivElement }) =>
      Array.from(
        r.container.querySelectorAll('[data-testid="group-message"]')
      ).map(e => ({
        text: e.querySelector('.whitespace-pre-wrap')?.textContent,
        sending: e.getAttribute('data-sending') === 'true',
      }));

    /** Adds an own message to the engine's timeline. */
    function record(syncObjId: string, text: string) {
      fake.state.timelines.get('g1')!.push(
        message({
          syncObjId,
          createdAt: 3_000n,
          lastModifiedAt: 3_000n,
          body: { type: 'text', text },
        })
      );
    }

    async function send(r: { container: HTMLDivElement }, text: string) {
      const textarea = r.container.querySelector(
        'textarea'
      ) as HTMLTextAreaElement;
      await typeInto(textarea, text);
      await pressEnter(textarea);
    }

    it('shows it at once with its reply, then the real one in its place', async () => {
      const r = await openGroup('member');
      unmount = r.unmount;
      const sent = deferSend();
      const bobs = r.container
        .querySelectorAll('[data-testid="group-message"]')[1]
        .querySelector('[role="button"]');
      await click(bobs);
      await click(byText('message_menu.reply'));
      await send(r, 'hello');
      expect(rows(r)).toEqual([
        { text: 'question', sending: false },
        { text: 'answer', sending: false },
        { text: 'hello', sending: true },
      ]);
      const local = r.container.querySelector('[data-sending="true"]')!;
      expect(
        local.querySelector('[data-testid="group-reply-preview"]')?.textContent
      ).toContain('answer');
      expect(
        local.querySelector('[data-testid="group-message-sending"]')
      ).not.toBeNull();
      // No menu on it while it is being sent.
      await click(local.querySelector('[role="button"]'));
      expect(byText('message_menu.reply')).toBeUndefined();
      expect(byText('message_menu.delete')).toBeUndefined();

      record('s9', 'hello');
      await sent.resolve('s9');
      expect(rows(r)).toEqual([
        { text: 'question', sending: false },
        { text: 'answer', sending: false },
        { text: 'hello', sending: false },
      ]);
    });

    it('never shows it twice when the timeline has it before the send resolves', async () => {
      const r = await openGroup('member');
      unmount = r.unmount;
      const sent = deferSend();
      await send(r, 'hello');
      record('s9', 'hello');
      await act(() => useGroupStore.getState().refresh());
      await act(flush);
      expect(rows(r).filter(x => x.text === 'hello')).toEqual([
        { text: 'hello', sending: false },
      ]);
      await sent.resolve('s9');
      expect(rows(r).filter(x => x.text === 'hello')).toEqual([
        { text: 'hello', sending: false },
      ]);
    });

    it('removes it on failure and gives the text back after what was typed since', async () => {
      const r = await openGroup('member');
      unmount = r.unmount;
      const sent = deferSend();
      await send(r, 'hello');
      expect(rows(r).at(-1)).toEqual({ text: 'hello', sending: true });
      const textarea = r.container.querySelector(
        'textarea'
      ) as HTMLTextAreaElement;
      await typeInto(textarea, 'later');
      await sent.reject(new Error('network'));
      expect(rows(r).map(x => x.text)).toEqual(['question', 'answer']);
      expect(await toastErrors()).toEqual(['message_menu.failed']);
      expect(
        (r.container.querySelector('textarea') as HTMLTextAreaElement).value
      ).toBe('later\nhello');
    });

    it('keeps several sends in their order, each replaced by its message', async () => {
      const r = await openGroup('member');
      unmount = r.unmount;
      const first = deferSend();
      const second = deferSend();
      await send(r, 'one');
      await send(r, 'two');
      expect(rows(r).slice(2)).toEqual([
        { text: 'one', sending: true },
        { text: 'two', sending: true },
      ]);
      record('s8', 'one');
      await first.resolve('s8');
      expect(rows(r).slice(2)).toEqual([
        { text: 'one', sending: false },
        { text: 'two', sending: true },
      ]);
      record('s9', 'two');
      await second.resolve('s9');
      expect(rows(r).slice(2)).toEqual([
        { text: 'one', sending: false },
        { text: 'two', sending: false },
      ]);
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
    // Members first, then the name.
    await click(boxes[0]);
    await click(byText('common:next'));
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
    // the name, not the box: the whole row picks
    await click(
      Array.from(document.querySelectorAll('bdi')).find(
        e => e.textContent === 'Carl'
      )
    );
    const box = document.querySelector(
      '[role="checkbox"][aria-label="Carl"]'
    ) as HTMLElement;
    expect(box.getAttribute('aria-checked')).toBe('true');
    const adds = Array.from(document.querySelectorAll('button')).filter(
      b => b.textContent?.trim() === 'details.add_members'
    );
    await click(adds[adds.length - 1]);
    await act(flush);
    expect(fake.service.changeMembers).toHaveBeenCalledWith('g1', {
      add: ['carl'],
    });
  });

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

  async function openSettings(members: string[]) {
    fake.state.groups = [summary({ members })];
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(
      <GroupSettings />,
      '/group/g1/settings',
      '/group/:groupId/settings'
    );
    unmount = r.unmount;
    await act(flush);
    return r;
  }

  /** The member rows that offer "Add as contact", by the name they show. */
  function addContactRows(): string[] {
    return Array.from(
      document.querySelectorAll('[data-testid="member-add-contact"]')
    ).map(b => b.closest('li')!.querySelector('span')!.textContent ?? '');
  }

  it('offers "Add as contact" only for members who are no accepted contact, and adds them under the name given', async () => {
    useDiscussionStore.setState({
      contacts: [
        { userId: 'bob', name: '', connection: 'automatic' },
        { userId: 'carl', name: 'Carl', connection: 'accepted' },
        { userId: 'dana', name: 'Dana', connection: 'requested' },
      ] as never,
    });
    await openSettings(['me', 'bob', 'carl', 'dana', 'erin']);
    // Bob (automatic), Dana (a request waiting) and Erin (no row yet); never
    // the user, never Carl.
    expect(addContactRows()).toHaveLength(3);
    const rows = Array.from(
      document.querySelectorAll('[data-testid="member-add-contact"]')
    ).map(b => b.closest('li')!.textContent ?? '');
    expect(rows.some(t => t.includes('Carl'))).toBe(false);
    expect(rows.some(t => t.includes('list.you'))).toBe(false);

    await click(document.querySelector('[data-testid="member-add-contact"]'));
    expect(document.body.textContent).toContain('details.add_as_contact_hint');
    // The name rule of the new-contact form: Carl is taken.
    await type(document.querySelector('input[type="text"]'), 'carl');
    const confirm = () =>
      Array.from(document.querySelectorAll('button')).filter(
        b => b.textContent?.trim() === 'details.add_as_contact'
      );
    await click(confirm()[confirm().length - 1]);
    expect(fake.sdk.conversations.addAsContact).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('details.contact_name_taken');

    await type(document.querySelector('input[type="text"]'), 'Bobby');
    await click(confirm()[confirm().length - 1]);
    await act(flush);
    expect(fake.sdk.conversations.addAsContact).toHaveBeenCalledWith(
      'bob',
      'Bobby'
    );
  });

  it('lists only accepted contacts to add to a chat, as "New group" does', async () => {
    useDiscussionStore.setState({
      contacts: [
        { userId: 'carl', name: 'Carl' },
        { userId: 'zed', name: 'Zed', connection: 'automatic' },
        { userId: 'yan', name: 'Yan', connection: 'requested' },
      ] as never,
    });
    await openSettings(['me', 'bob']);
    await click(byText('details.add_members'));
    const boxes = Array.from(
      document.querySelectorAll('[role="checkbox"]')
    ).map(b => b.getAttribute('aria-label'));
    expect(boxes).toEqual(['Carl']);
  });

  describe("the chat's name (UI1)", () => {
    async function settingsOf(over: Parameters<typeof summary>[0]) {
      fake.state.groups = [summary(over)];
      useGroupStore.getState().init();
      await act(flush);
      const r = await renderAt(
        <GroupSettings />,
        '/group/g1/settings',
        '/group/:groupId/settings'
      );
      unmount = r.unmount;
      await act(flush);
      return r;
    }
    const dialogButtons = () =>
      Array.from(
        document
          .querySelector('[data-testid="chat-name-dialog"]')!
          .querySelectorAll('button')
      ).map(b => b.textContent?.trim());
    const nameField = () =>
      document.querySelector('input#chat-name') as HTMLInputElement;

    it('shows the name once, with one edit button, and none of the old name rows', async () => {
      const r = await settingsOf({ owner: 'bob' });
      expect(
        r.container.querySelector('[data-testid="chat-name"]')?.textContent
      ).toBe('Trip');
      expect(
        r.container.querySelectorAll('[data-testid="chat-name-edit"]')
      ).toHaveLength(1);
      // The shared name only shows apart when the user has another one.
      expect(
        r.container.querySelector('[data-testid="chat-shared-name"]')
      ).toBeNull();
      const text = r.container.textContent ?? '';
      for (const gone of [
        'details.your_name',
        'details.group_name',
        'details.set_name',
        'details.rename',
      ]) {
        expect(text).not.toContain(gone);
      }
    });

    it("shows the user's own name first, and the shared name under it", async () => {
      const r = await settingsOf({ owner: 'bob', localName: 'Holidays' });
      expect(
        r.container.querySelector('[data-testid="chat-name"]')?.textContent
      ).toBe('Holidays');
      expect(
        r.container.querySelector('[data-testid="chat-shared-name"]')
          ?.textContent
      ).toBe('details.name_shared');
    });

    it('gives a member "Save for me" only, which stores a name on this device', async () => {
      await settingsOf({ owner: 'bob' });
      await click(document.querySelector('[data-testid="chat-name-edit"]'));
      expect(dialogButtons()).toEqual([
        'details.save_for_me',
        'choices.cancel',
      ]);
      expect(nameField().value).toBe('Trip');
      await type(nameField(), ' Holidays ');
      await click(byText('details.save_for_me'));
      await act(flush);
      expect(fake.service.setLocalName).toHaveBeenCalledWith('g1', 'Holidays');
      expect(fake.service.changeMembers).not.toHaveBeenCalled();
    });

    it('goes back to the shared name with an empty field, and says so', async () => {
      await settingsOf({ owner: 'bob', localName: 'Holidays' });
      await click(document.querySelector('[data-testid="chat-name-edit"]'));
      expect(nameField().value).toBe('Holidays');
      await type(nameField(), '  ');
      expect(dialogButtons()).toEqual([
        'details.use_shared_name',
        'choices.cancel',
      ]);
      await click(byText('details.use_shared_name'));
      await act(flush);
      expect(fake.service.setLocalName).toHaveBeenCalledWith('g1', null);
    });

    it('gives the owner "Save for everyone" too, which renames the chat', async () => {
      await settingsOf({ owner: 'me' });
      await click(document.querySelector('[data-testid="chat-name-edit"]'));
      expect(dialogButtons()).toEqual([
        'details.save_for_everyone',
        'details.save_for_me',
        'choices.cancel',
      ]);
      await type(nameField(), 'Summer trip');
      await click(byText('details.save_for_everyone'));
      await act(flush);
      expect(fake.service.changeMembers).toHaveBeenCalledWith('g1', {
        name: 'Summer trip',
      });
      expect(fake.service.setLocalName).not.toHaveBeenCalled();
    });

    it('refuses a name over 256 bytes', async () => {
      await settingsOf({ owner: 'me' });
      await click(document.querySelector('[data-testid="chat-name-edit"]'));
      await type(nameField(), '\u00e9'.repeat(129));
      expect(byText('new_group.name_too_long')).toBeDefined();
      const save = byText('details.save_for_everyone') as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      await click(save);
      await click(byText('details.save_for_me'));
      expect(fake.service.changeMembers).not.toHaveBeenCalled();
      expect(fake.service.setLocalName).not.toHaveBeenCalled();
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
