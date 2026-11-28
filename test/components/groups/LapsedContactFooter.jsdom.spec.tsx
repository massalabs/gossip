import './matchMedia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import type { Contact, Discussion, GossipSdk } from '@massalabs/gossip-sdk';
import { SessionStatus } from '@massalabs/gossip-sdk';
import ArchiveFooter from '../../../src/components/groups/ArchiveFooter';
import { useSdkStore } from '../../../src/stores/sdkStore';
import { useGroupStore } from '../../../src/stores/groupStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { useDiscussionStore } from '../../../src/stores/discussionStore';
import i18next from 'i18next';
import enGroups from '../../../src/i18n/locales/en/groups.json';
import frGroups from '../../../src/i18n/locales/fr/groups.json';
import ruGroups from '../../../src/i18n/locales/ru/groups.json';
import zhGroups from '../../../src/i18n/locales/zh-CN/groups.json';
import { flush, makeFakeGroups } from '../../helpers/fakeGroups';
import { click, renderAt } from './render';

// The app store persists to localStorage, which this environment lacks: an
// in-memory one, in place before the store is created.
vi.hoisted(() => {
  if (typeof globalThis.localStorage?.setItem === 'function') return;
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, String(v)),
      removeItem: (k: string) => void items.delete(k),
      clear: () => items.clear(),
      key: (i: number) => [...items.keys()][i] ?? null,
      get length() {
        return items.size;
      },
    },
  });
});

const tr = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tr }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

/**
 * The screen of a contact the user added on their own whose connection
 * lapsed (§5.12, D.100): "Send a contact request", warned, with the fields
 * of an ordinary request.
 */
describe('the screen of a contact whose connection lapsed', () => {
  let fake: ReturnType<typeof makeFakeGroups>;
  let unmount: () => Promise<void> = async () => {};
  const sendContactRequest = vi.fn(async () => ({ success: true }));
  const isCoMember = vi.fn(async () => false);
  const contact = {
    userId: 'bob',
    name: 'Bob',
    connection: 'added',
  } as Contact;
  const discussion = {
    contactUserId: 'bob',
    isArchive: false,
    archived: false,
    weAccepted: false,
    direction: 'initiated',
  } as unknown as Discussion;

  beforeEach(() => {
    fake = makeFakeGroups();
    Object.assign(fake.sdk.conversations, { sendContactRequest, isCoMember });
    sendContactRequest.mockClear();
    isCoMember.mockReset();
    isCoMember.mockResolvedValue(false);
    useSdkStore.setState({ sdk: fake.sdk as unknown as GossipSdk });
    useAccountStore.setState({
      userProfile: { userId: 'me', username: 'Alice' } as never,
    });
    useDiscussionStore.setState({
      sessionsStatuses: new Map([['bob', SessionStatus.Killed]]),
    } as never);
    useGroupStore.getState().init();
  });

  afterEach(async () => {
    await unmount();
    unmount = async () => {};
    useGroupStore.getState().cleanup();
    useSdkStore.setState({ sdk: null });
  });

  async function render(c: Contact = contact) {
    await act(flush);
    const r = await renderAt(
      <ArchiveFooter contact={c} discussion={discussion} />
    );
    unmount = r.unmount;
    await act(flush);
    return r;
  }

  it('says the two are no longer connected and sends an ordinary request only once confirmed', async () => {
    const r = await render();
    expect(r.container.textContent).toContain(
      'lapsed_contact.no_longer_connected'
    );
    expect(r.container.querySelector('[data-testid="start-chat"]')).toBeNull();
    await click(
      r.container.querySelector('[data-testid="send-contact-request"]')
    );
    await act(flush);
    expect(sendContactRequest).not.toHaveBeenCalled();
    // The warning, then the fields of an ordinary request.
    expect(
      document.querySelector('[data-testid="send-contact-request-warning"]')
        ?.textContent
    ).toBe('lapsed_contact.warning');
    expect(document.body.textContent).toContain('new_contact.share_username');
    expect(document.body.textContent).toContain(
      'new_contact.announcement_label'
    );
    await click(
      document.querySelector('[data-testid="send-contact-request-confirm"]')
    );
    await act(flush);
    expect(sendContactRequest).toHaveBeenCalledWith('bob', {
      username: 'Alice',
      message: '',
    });
  });

  it('shows nothing of it while a chat held still lists the contact, or while connected', async () => {
    isCoMember.mockResolvedValue(true);
    let r = await render();
    expect(
      r.container.querySelector('[data-testid="send-contact-request"]')
    ).toBeNull();
    await unmount();
    isCoMember.mockResolvedValue(false);
    useDiscussionStore.setState({
      sessionsStatuses: new Map([['bob', SessionStatus.Active]]),
    } as never);
    r = await render({ ...contact } as Contact);
    expect(
      r.container.querySelector('[data-testid="send-contact-request"]')
    ).toBeNull();
    await unmount();
    // A contact the user accepted is not concerned.
    useDiscussionStore.setState({
      sessionsStatuses: new Map([['bob', SessionStatus.Killed]]),
    } as never);
    r = await render({ ...contact, connection: 'accepted' } as Contact);
    expect(
      r.container.querySelector('[data-testid="send-contact-request"]')
    ).toBeNull();
  });

  it('has its texts in every language, as full sentences with no semicolon or dash', async () => {
    const keys = [
      'no_longer_connected',
      'action',
      'warning',
      'send',
      'sent',
      'failed',
    ];
    for (const [lng, groups] of [
      ['en', enGroups],
      ['fr', frGroups],
      ['ru', ruGroups],
      ['zh-CN', zhGroups],
    ] as const) {
      const i18n = i18next.createInstance();
      await i18n.init({
        lng,
        ns: ['groups'],
        defaultNS: 'groups',
        resources: { [lng]: { groups } } as never,
      });
      for (const k of keys) {
        const text = i18n.t(`lapsed_contact.${k}`, { name: 'Bob' });
        expect(text, `${lng} ${k}`).not.toBe(`lapsed_contact.${k}`);
        expect(text).not.toMatch(/[;—]/);
        expect(text.toLowerCase()).not.toContain('group');
      }
    }
  });
});
