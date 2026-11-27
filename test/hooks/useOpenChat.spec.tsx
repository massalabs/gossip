// Opening a contact (§5.12): the conversation list, the contact list, a
// notification all end in this hook. It never starts a chat by itself.
// Runs in jsdom (unit project).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@massalabs/gossip-sdk', () => ({ SELF_CONTACT_ID: 'self' }));

const sdk = {
  conversations: {
    directChatWith: vi.fn(async (): Promise<string | null> => null),
    startDirectChat: vi.fn(async () => 'g1'),
  },
  discussions: {
    get: vi.fn(async () => ({
      contactUserId: 'bob',
      isArchive: false,
      weAccepted: true,
      directChatOwed: false,
    })),
  },
};
vi.mock('../../src/hooks/useGossipSdk', () => ({ useGossipSdk: () => sdk }));
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

import { useOpenChat } from '../../src/hooks/useOpenChat';

describe('useOpenChat', () => {
  let container: HTMLDivElement;
  let root: Root;
  const open: { current: ReturnType<typeof useOpenChat> | null } = {
    current: null,
  };

  function Harness() {
    open.current = useOpenChat();
    return null;
  }

  beforeEach(async () => {
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

  it('opens the contact screen of a contact with no chat, and starts none', async () => {
    let to: string | null = null;
    await act(async () => {
      to = await open.current!('bob');
    });
    expect(to).toBe('/discussion/bob');
    expect(navigate).toHaveBeenCalledWith('/discussion/bob', undefined);
    expect(sdk.conversations.startDirectChat).not.toHaveBeenCalled();
  });

  it('opens the chat held with a contact', async () => {
    sdk.conversations.directChatWith.mockResolvedValueOnce('g7');
    await act(async () => {
      await open.current!('bob');
    });
    expect(navigate).toHaveBeenCalledWith('/group/g7', undefined);
    expect(sdk.conversations.startDirectChat).not.toHaveBeenCalled();
  });
});
