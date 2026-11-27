// Declining a contact request (§5.12): a member of a shared chat keeps the
// connection the chat needs; anyone else goes with their contact.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Contact, Discussion } from '@massalabs/gossip-sdk';

const contacts = new Map<string, Partial<Contact>>();
const sdk = {
  contacts: {
    get: vi.fn(async (id: string) => contacts.get(id) ?? null),
    delete: vi.fn(async () => ({ success: true })),
  },
  conversations: { declineContactRequest: vi.fn(async () => {}) },
};
vi.mock('../../src/hooks/useGossipSdk', () => ({ useGossipSdk: () => sdk }));
vi.mock('../../src/stores/accountStore', () => ({
  useAccountStore: (sel: (s: unknown) => unknown) =>
    sel({ userProfile: { userId: 'me' } }),
}));
vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

import { useDiscussionList } from '../../src/hooks/useDiscussionList';

describe('useDiscussionList: declining a contact request', () => {
  let container: HTMLDivElement;
  let root: Root;
  const hook: { current: ReturnType<typeof useDiscussionList> | null } = {
    current: null,
  };

  function Harness() {
    hook.current = useDiscussionList();
    return null;
  }

  beforeEach(async () => {
    contacts.clear();
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(React.createElement(Harness)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const request = { id: 1, contactUserId: 'bob' } as Discussion;

  it('keeps the connection of a member of a shared chat', async () => {
    contacts.set('bob', { userId: 'bob', connection: 'requested' });
    await act(async () => hook.current!.handleRefuseDiscussionRequest(request));
    expect(sdk.conversations.declineContactRequest).toHaveBeenCalledWith('bob');
    expect(sdk.contacts.delete).not.toHaveBeenCalled();
  });

  it('removes anyone else with their contact, as before', async () => {
    contacts.set('bob', { userId: 'bob', connection: 'accepted' });
    await act(async () => hook.current!.handleRefuseDiscussionRequest(request));
    expect(sdk.contacts.delete).toHaveBeenCalledWith('bob');
    expect(sdk.conversations.declineContactRequest).not.toHaveBeenCalled();
  });
});
