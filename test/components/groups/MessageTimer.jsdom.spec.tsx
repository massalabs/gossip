import './matchMedia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import type {
  Contact,
  Discussion,
  GossipSdk,
  GroupInvitation,
} from '@massalabs/gossip-sdk';
import GroupDiscussion from '../../../src/pages/GroupDiscussion';
import NewGroup from '../../../src/pages/NewGroup';
import GroupSettings from '../../../src/pages/GroupSettings';
import Invitation from '../../../src/pages/Invitation';
import ArchiveFooter from '../../../src/components/groups/ArchiveFooter';
import { useContactForm } from '../../../src/hooks/useContactForm';
import { useSdkStore } from '../../../src/stores/sdkStore';
import { useGroupStore } from '../../../src/stores/groupStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { useAppStore } from '../../../src/stores/appStore';
import {
  MESSAGE_TIMER_OPTIONS,
  messageTimerLabel,
} from '../../../src/constants/messageTimer';
import i18next from 'i18next';
import enGroups from '../../../src/i18n/locales/en/groups.json';
import frGroups from '../../../src/i18n/locales/fr/groups.json';
import ruGroups from '../../../src/i18n/locales/ru/groups.json';
import zhGroups from '../../../src/i18n/locales/zh-CN/groups.json';
import { flush, makeFakeGroups, summary } from '../../helpers/fakeGroups';
import { byText, click, renderAt } from './render';

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

// Keys with their count, so that each option of the list has its own text.
const tr = (key: string, o?: Record<string, unknown>) =>
  o && 'count' in o ? `${key}:${String(o.count)}` : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tr }),
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
vi.mock('../../../src/hooks/useDiscussionList', () => ({
  useDiscussionList: () => ({
    handleAcceptDiscussionRequest: vi.fn(async () => {}),
    handleRefuseDiscussionRequest: vi.fn(async () => {}),
  }),
}));
// The contact form's lookups of the user ID and of a shared file.
vi.mock('../../../src/hooks/useUserIdResolution', () => ({
  useUserIdResolution: () => ({
    userId: { value: 'bob', loading: false },
    setUserId: vi.fn(),
    publicKeys: { to_bytes: () => new Uint8Array([1]) },
    setPublicKeys: vi.fn(),
    mnsState: {},
    handleUserIdChange: vi.fn(),
    cachePublicKey: vi.fn(),
  }),
}));
vi.mock('../../../src/hooks/useFileShareContact', () => ({
  useFileShareContact: () => ({
    importFileContact: vi.fn(),
    fileState: { isLoading: false, error: null },
  }),
}));

const HOUR = 3_600_000;
const MONTH = 2_419_200_000;

const invitation = (over: Partial<GroupInvitation> = {}): GroupInvitation => ({
  epochId: 'e1',
  name: 'Trip',
  members: ['bob', 'me', 'carol'],
  owner: 'bob',
  receivedFrom: null,
  closedBefore: false,
  rejoins: null,
  migrateFrom: null,
  migrationOf: null,
  continues: null,
  messageTimer: HOUR,
  ...over,
});

/** The option of the open list with this label. */
function option(label: string): HTMLElement | undefined {
  const all = Array.from(document.querySelectorAll('button')).filter(
    b => b.textContent?.trim() === label
  );
  return all[all.length - 1];
}

describe('message timer labels', () => {
  it('names the values offered, and any other as a plain duration', () => {
    expect(MESSAGE_TIMER_OPTIONS).toEqual([
      300_000,
      900_000,
      1_800_000,
      HOUR,
      2 * HOUR,
      4 * HOUR,
      8 * HOUR,
      12 * HOUR,
      24 * HOUR,
      48 * HOUR,
      72 * HOUR,
      96 * HOUR,
      120 * HOUR,
      144 * HOUR,
      168 * HOUR,
      336 * HOUR,
      504 * HOUR,
      MONTH,
      0,
    ]);
    expect(MESSAGE_TIMER_OPTIONS.map(ms => messageTimerLabel(ms, tr))).toEqual([
      'groups:timer.minutes:5',
      'groups:timer.minutes:15',
      'groups:timer.minutes:30',
      'groups:timer.hours:1',
      'groups:timer.hours:2',
      'groups:timer.hours:4',
      'groups:timer.hours:8',
      'groups:timer.hours:12',
      'groups:timer.days:1',
      'groups:timer.days:2',
      'groups:timer.days:3',
      'groups:timer.days:4',
      'groups:timer.days:5',
      'groups:timer.days:6',
      'groups:timer.weeks:1',
      'groups:timer.weeks:2',
      'groups:timer.weeks:3',
      'groups:timer.month',
      'groups:timer.forever',
    ]);
    expect(messageTimerLabel(90 * 60_000, tr)).toBe(
      'groups:timer.hours:1 groups:timer.minutes:30'
    );
    expect(messageTimerLabel(26 * HOUR, tr)).toBe(
      'groups:timer.days:1 groups:timer.hours:2'
    );
    expect(messageTimerLabel(1_500, tr)).toBe('groups:timer.seconds:2');
  });

  it('names 15 and 30 minutes, 2 and 4 hours in every language by its plural keys', async () => {
    const choices = [15 * 60_000, 30 * 60_000, 2 * HOUR, 4 * HOUR];
    const expected: [string, unknown, string[]][] = [
      ['en', enGroups, ['15 minutes', '30 minutes', '2 hours', '4 hours']],
      ['fr', frGroups, ['15 minutes', '30 minutes', '2 heures', '4 heures']],
      ['ru', ruGroups, ['15 минут', '30 минут', '2 часа', '4 часа']],
      ['zh-CN', zhGroups, ['15 分钟', '30 分钟', '2 小时', '4 小时']],
    ];
    for (const [lng, groups, labels] of expected) {
      const i18n = i18next.createInstance();
      await i18n.init({
        lng,
        ns: ['groups'],
        resources: { [lng]: { groups } } as never,
      });
      const t = (key: string, options?: Record<string, unknown>) =>
        i18n.t(key, options) as string;
      expect(
        choices.map(ms => {
          expect(MESSAGE_TIMER_OPTIONS).toContain(ms);
          return messageTimerLabel(ms, t);
        })
      ).toEqual(labels);
    }
  });
});

describe('message timer screens', () => {
  let fake: ReturnType<typeof makeFakeGroups>;
  let unmount: () => Promise<void> = async () => {};

  beforeEach(() => {
    fake = makeFakeGroups();
    useSdkStore.setState({ sdk: fake.sdk as unknown as GossipSdk });
    useAccountStore.setState({ userProfile: { userId: 'me' } as never });
    useAppStore.setState({ defaultRetentionDuration: 2_592_000 });
  });

  afterEach(async () => {
    await unmount();
    unmount = async () => {};
    useGroupStore.getState().cleanup();
    useSdkStore.setState({ sdk: null });
  });

  it('pre-selects the creator default on the new group screen and creates with the timer chosen', async () => {
    fake.sdk.contacts.list.mockResolvedValue([
      { userId: 'alice', name: 'Alice' },
    ] as never);
    useAppStore.setState({ defaultRetentionDuration: 3600 });
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(<NewGroup />);
    unmount = r.unmount;
    await act(flush);
    const field = r.container.querySelector(
      '[data-testid="message-timer-field-value"]'
    );
    expect(field?.textContent).toBe('groups:timer.hours:1');
    await click(
      r.container.querySelector('[data-testid="message-timer-field"]')
    );
    await click(option('groups:timer.days:3'));
    expect(field?.textContent).toBe('groups:timer.days:3');
    await click(r.container.querySelector('[role="checkbox"]'));
    await click(byText('new_group.create'));
    await act(flush);
    expect(fake.service.createGroup).toHaveBeenCalledWith('', ['alice'], {
      messageTimer: 72 * HOUR,
    });
  });

  it('lets the owner change the timer in the settings, by a new root', async () => {
    fake.state.groups = [summary({ messageTimer: MONTH })];
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(
      <GroupSettings />,
      '/group/g1/settings',
      '/group/:groupId/settings'
    );
    unmount = r.unmount;
    await act(flush);
    expect(
      r.container.querySelector('[data-testid="group-timer-field-value"]')
        ?.textContent
    ).toBe('groups:timer.month');
    await click(r.container.querySelector('[data-testid="group-timer-field"]'));
    await click(option('groups:timer.forever'));
    await act(flush);
    expect(fake.service.setMessageTimer).toHaveBeenCalledWith('g1', 0);
  });

  it('shows the timer to a member who is not the owner, without a way to change it', async () => {
    fake.state.groups = [summary({ owner: 'bob', messageTimer: HOUR })];
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(
      <GroupSettings />,
      '/group/g1/settings',
      '/group/:groupId/settings'
    );
    unmount = r.unmount;
    await act(flush);
    expect(
      r.container.querySelector('[data-testid="group-timer-field"]')
    ).toBeNull();
    expect(
      r.container.querySelector('[data-testid="group-timer"]')?.textContent
    ).toBe('groups:timer.disappear_after');
    expect(r.container.textContent).toContain('timer.owner_only');
    expect(fake.service.setMessageTimer).not.toHaveBeenCalled();
  });

  it('shows the current timer in the header and a line where it changes', async () => {
    fake.state.groups = [summary({ messageTimer: HOUR })];
    fake.state.timelines.set('g1', [
      {
        kind: 'line',
        at: 500n,
        line: { type: 'messageTimer', epoch: 'g1', timer: 0 },
      },
      {
        kind: 'line',
        at: 600n,
        line: { type: 'messageTimer', epoch: 'e2', timer: HOUR },
      },
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
    const chip = r.container.querySelector('[data-testid="group-timer-chip"]');
    expect(chip?.textContent).toBe('header.auto_delete_active');
    const lines = Array.from(
      r.container.querySelectorAll('[data-testid="group-line"]')
    ).map(l => l.textContent);
    expect(lines).toEqual(['timeline.timer_off', 'timeline.timer_set']);
  });

  it('shows no timer in the header of a chat that keeps its messages', async () => {
    fake.state.groups = [summary({ messageTimer: 0 })];
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(
      <GroupDiscussion />,
      '/group/g1',
      '/group/:groupId'
    );
    unmount = r.unmount;
    await act(flush);
    expect(
      r.container.querySelector('[data-testid="group-timer-chip"]')
    ).toBeNull();
  });

  it('shows the timer on the invitation before it is accepted', async () => {
    fake.state.invitations = [invitation()];
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(
      <Invitation />,
      '/invitation/group/e1',
      '/invitation/:kind/:id'
    );
    unmount = r.unmount;
    await act(flush);
    const section = r.container.querySelector('[data-testid="invite-timer"]');
    expect(section?.textContent).toContain('timer.disappear_after');
    expect(section?.textContent).toContain('timer.owner_only');
  });

  it('says on the invitation when messages are kept', async () => {
    fake.state.invitations = [invitation({ messageTimer: 0 })];
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(
      <Invitation />,
      '/invitation/group/e1',
      '/invitation/:kind/:id'
    );
    unmount = r.unmount;
    await act(flush);
    expect(
      r.container.querySelector('[data-testid="invite-timer"]')?.textContent
    ).toContain('timer.kept');
  });

  it("confirms a migration with the conversation's timer pre-selected, or the one chosen", async () => {
    fake.sdk.conversations.migrationTimer.mockResolvedValue(MONTH);
    useGroupStore.getState().init();
    await act(flush);
    const contact = { userId: 'bob', name: 'Bob' } as Contact;
    const discussion = {
      contactUserId: 'bob',
      isArchive: true,
      archived: false,
    } as Discussion;
    const r = await renderAt(
      <ArchiveFooter contact={contact} discussion={discussion} />
    );
    unmount = r.unmount;
    await click(r.container.querySelector('[data-testid="archive-migrate"]'));
    await act(flush);
    expect(fake.sdk.conversations.migrationTimer).toHaveBeenCalledWith('bob');
    expect(fake.sdk.conversations.migrate).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="migration-message-timer-value"]')
        ?.textContent
    ).toBe('groups:timer.month');
    await click(
      document.querySelector('[data-testid="migration-message-timer"]')
    );
    await click(option('groups:timer.weeks:1'));
    await click(
      document.querySelector('[data-testid="archive-migrate-confirm"]')
    );
    await act(flush);
    expect(fake.sdk.conversations.migrate).toHaveBeenCalledWith('bob', {
      messageTimer: 168 * HOUR,
    });
  });

  it('shows the timer of a migration to accept inside the earlier conversation', async () => {
    fake.state.invitations = [
      invitation({
        members: ['bob', 'me'],
        migrateFrom: 0,
        migrationOf: 'bob',
        messageTimer: 0,
      }),
    ];
    useGroupStore.getState().init();
    await act(flush);
    const r = await renderAt(
      <ArchiveFooter
        contact={{ userId: 'bob', name: 'Bob' } as Contact}
        discussion={{ contactUserId: 'bob', isArchive: true } as Discussion}
      />
    );
    unmount = r.unmount;
    await act(flush);
    expect(
      r.container.querySelector('[data-testid="archive-invitation-timer"]')
        ?.textContent
    ).toBe('groups:timer.kept');
    expect(
      r.container.querySelector('[data-testid="archive-accept-migration"]')
    ).not.toBeNull();
  });

  it('sends a contact request with the timer chosen, the default pre-selected', async () => {
    const start = vi.fn(async () => ({ success: true }));
    Object.assign(fake.sdk, {
      contacts: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => undefined),
        add: vi.fn(async () => ({ success: true })),
      },
      discussions: { getStatus: vi.fn(() => 0), start },
    });
    let form: ReturnType<typeof useContactForm> | null = null;
    const Probe: React.FC = () => {
      form = useContactForm();
      return null;
    };
    const r = await renderAt(<Probe />);
    unmount = r.unmount;
    await act(flush);
    expect(form!.messageTimer).toBe(MONTH);
    await act(async () => {
      form!.handleNameChange('Bob');
      form!.handleShareUsernameChange(false);
    });
    await act(async () => {
      form!.handleMessageTimerChange(12 * HOUR);
    });
    expect(form!.messageTimer).toBe(12 * HOUR);
    await act(async () => {
      await form!.handleSubmit();
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'bob' }),
      expect.anything(),
      { messageTimer: 12 * HOUR }
    );
  });
});
