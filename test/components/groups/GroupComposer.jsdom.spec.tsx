import './matchMedia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import GroupComposer from '../../../src/components/groups/GroupComposer';
import { click, renderAt } from './render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

/**
 * The author controls (UI5, UI6) of the chat's composer. The chat screen does
 * not show them yet: the SDK cannot publish under another member's name. They
 * are tested here, ready for when it can.
 */
describe('the author of a message (send as)', () => {
  let unmount: () => Promise<void> = async () => {};
  afterEach(async () => {
    await unmount();
  });

  const onSend = vi.fn();

  async function mount() {
    onSend.mockClear();
    const r = await renderAt(
      <GroupComposer
        me="me"
        members={['me', 'bob', 'carl']}
        memberName={id => (id === 'me' ? 'You' : id.toUpperCase())}
        canChooseAuthor
        canSendLocally={false}
        draft={null}
        replyingTo={null}
        onCancelReply={() => {}}
        editing={null}
        onCancelEdit={() => {}}
        onSend={onSend}
        onEdit={() => {}}
      />
    );
    unmount = r.unmount;
    return r;
  }

  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
  const banner = () =>
    q('sending-as-banner')?.querySelector('p')?.textContent ?? null;
  const switchOf = () =>
    document.querySelector('[role="switch"]') as HTMLButtonElement;

  async function pick(name: string) {
    await click(q('author-button'));
    const row = Array.from(
      document.querySelectorAll('[data-testid="author-option"]')
    ).find(b => b.textContent?.includes(name));
    await click(row);
  }

  async function send(text: string) {
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )!.set!;
      setter.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
  }

  it('opens the selector from the author button, with every member and the switch off', async () => {
    await mount();
    expect(q('author-button')?.getAttribute('aria-label')).toBe(
      'composer.author_button'
    );
    await click(q('author-button'));
    expect(q('author-selector')).not.toBeNull();
    const rows = Array.from(
      document.querySelectorAll('[data-testid="author-option"]')
    );
    expect(rows.map(r => r.textContent?.trim())).toEqual([
      'Youcomposer.send_as_me',
      'BOBcomposer.send_as_other',
      'CARLcomposer.send_as_other',
    ]);
    expect(rows[0].getAttribute('aria-checked')).toBe('true');
    expect(switchOf().getAttribute('aria-checked')).toBe('false');
    expect(switchOf().getAttribute('aria-label')).toBe(
      'composer.keep_sending_as'
    );
  });

  it('by default, writes one message as the member chosen, then as the user again', async () => {
    await mount();
    expect(banner()).toBeNull();
    await pick('BOB');
    expect(q('author-selector')).toBeNull();
    expect(banner()).toBe('composer.sending_as_once');
    await send('hi');
    expect(onSend).toHaveBeenLastCalledWith('hi', {
      author: 'bob',
      scope: 'everyone',
    });
    expect(banner()).toBeNull();
    await send('again');
    expect(onSend).toHaveBeenLastCalledWith('again', {
      author: 'me',
      scope: 'everyone',
    });
  });

  it('with "Keep sending as" on, keeps the author until changed, says so, and forgets it when the screen goes', async () => {
    await mount();
    await click(q('author-button'));
    await click(switchOf());
    expect(switchOf().getAttribute('aria-checked')).toBe('true');
    const bob = Array.from(
      document.querySelectorAll('[data-testid="author-option"]')
    ).find(b => b.textContent?.includes('BOB'));
    await click(bob);
    expect(banner()).toBe('composer.sending_as_kept');
    await send('one');
    await send('two');
    expect(onSend.mock.calls.map(c => c[1].author)).toEqual(['bob', 'bob']);
    expect(banner()).toBe('composer.sending_as_kept');
    // The switch is off again each time the selector opens.
    await click(q('author-button'));
    expect(switchOf().getAttribute('aria-checked')).toBe('false');
    await click(document.querySelector('[aria-label="common:close"]'));
    expect(banner()).toBe('composer.sending_as_once');
    // Leaving the screen: the user writes as themselves again.
    await unmount();
    await mount();
    expect(banner()).toBeNull();
    await send('back');
    expect(onSend).toHaveBeenLastCalledWith('back', {
      author: 'me',
      scope: 'everyone',
    });
  });

  it('goes back to the user at once from the banner', async () => {
    await mount();
    await click(q('author-button'));
    await click(switchOf());
    await click(
      Array.from(
        document.querySelectorAll('[data-testid="author-option"]')
      ).find(b => b.textContent?.includes('CARL'))
    );
    expect(banner()).toBe('composer.sending_as_kept');
    expect(q('sending-as-reset')?.getAttribute('aria-label')).toBe(
      'composer.send_as_me'
    );
    await click(q('sending-as-reset'));
    expect(banner()).toBeNull();
    await send('me again');
    expect(onSend).toHaveBeenLastCalledWith('me again', {
      author: 'me',
      scope: 'everyone',
    });
  });
});
