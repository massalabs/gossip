// The new-contact form with a member of a shared chat who is no contact
// (§5.12): typed ID, scanned code, invite link, Bluetooth exchange and file
// import all end in this hook. Runs in jsdom (unit project).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Contact } from '@massalabs/gossip-sdk';

const keys = {
  to_bytes: () => new Uint8Array([1, 2, 3]),
  derive_id: () => new Uint8Array([9]),
};

vi.mock('@massalabs/gossip-sdk', () => ({
  canonicalUserId: (id: string) => id,
  validateUserIdFormat: () => ({ valid: true }),
  encodeUserId: () => 'bob',
  UserPublicKeys: { from_bytes: vi.fn(() => keys) },
}));

const contacts = new Map<string, Contact>();
const sdk = {
  isInitialized: true,
  isSessionOpen: true,
  auth: { fetchPublicKeyByUserId: vi.fn(async () => keys) },
  contacts: {
    get: vi.fn(async (id: string) => contacts.get(id) ?? null),
    list: vi.fn(async () => [...contacts.values()]),
    add: vi.fn(async () => ({ success: true })),
  },
  discussions: { start: vi.fn(async () => ({ success: true })) },
  conversations: {
    addAsContact: vi.fn(async () => ({ success: true })),
  },
};
vi.mock('../../src/hooks/useGossipSdk', () => ({ useGossipSdk: () => sdk }));
vi.mock('../../src/stores/accountStore', () => ({
  useAccountStore: (sel: (s: unknown) => unknown) =>
    sel({ userProfile: { userId: 'me', username: 'alice_tester' } }),
}));
vi.mock('../../src/stores/appStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({ mnsEnabled: false, defaultRetentionDuration: null }),
}));
vi.mock('../../src/hooks/useDefaultMessageTimer', () => ({
  useDefaultMessageTimer: () => 0,
}));
const importFileContact = vi.fn();
vi.mock('../../src/hooks/useFileShareContact', () => ({
  useFileShareContact: () => ({
    importFileContact,
    fileState: { isLoading: false, error: null },
  }),
}));
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
const toastError = vi.fn();
vi.mock('react-hot-toast', () => ({
  default: { error: (m: string) => toastError(m), success: vi.fn() },
}));

import { useContactForm } from '../../src/hooks/useContactForm';

type Form = ReturnType<typeof useContactForm>;

function contact(over: Partial<Contact>): Contact {
  return {
    ownerUserId: 'me',
    userId: 'bob',
    name: '',
    publicKeys: new Uint8Array([1, 2, 3]),
    isOnline: false,
    lastSeen: new Date(0),
    createdAt: new Date(0),
    ...over,
  };
}

describe('useContactForm with a member of a shared chat', () => {
  let container: HTMLDivElement;
  let root: Root;
  const form: { current: Form | null } = { current: null };

  function Harness() {
    form.current = useContactForm();
    return null;
  }

  const f = () => form.current!;

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

  it('lets a hidden automatic contact be added, from the keys held, and adds it without sending anything', async () => {
    contacts.set('bob', contact({ connection: 'automatic' }));
    await act(async () => f().handleUserIdChange('bob'));
    expect(f().userId.error).toBeUndefined();
    expect(f().connectedNonContact).toBe(true);
    // Keys held already: the backend is not asked.
    expect(sdk.auth.fetchPublicKeyByUserId).not.toHaveBeenCalled();

    await act(async () => f().handleNameChange('Bobby'));
    expect(f().canSubmit).toBe(true);
    await act(async () => f().handleSubmit());

    expect(sdk.conversations.addAsContact).toHaveBeenCalledWith('bob', 'Bobby');
    expect(sdk.contacts.add).not.toHaveBeenCalled();
    expect(sdk.discussions.start).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalled();
  });

  it('lets a member whose request waits be added the same way', async () => {
    contacts.set('bob', contact({ name: 'Bob', connection: 'requested' }));
    await act(async () => f().handleUserIdChange('bob'));
    expect(f().userId.error).toBeUndefined();
    expect(f().connectedNonContact).toBe(true);
    // Its own name is not taken by itself.
    await act(async () => f().handleNameChange('Bob'));
    await act(async () => f().handleSubmit());
    expect(sdk.conversations.addAsContact).toHaveBeenCalledWith('bob', 'Bob');
  });

  it('still refuses a contact the user accepted', async () => {
    contacts.set('bob', contact({ name: 'Bob', connection: 'accepted' }));
    await act(async () => f().handleUserIdChange('bob'));
    expect(f().userId.error).toBe('This user is already in your contacts');
    expect(f().connectedNonContact).toBe(false);
    expect(f().canSubmit).toBe(false);
  });

  it('sends a contact request to someone it is not connected to, as before', async () => {
    await act(async () => f().handleUserIdChange('bob'));
    expect(f().connectedNonContact).toBe(false);
    await act(async () => f().handleNameChange('Bobby'));
    await act(async () => f().handleSubmit());
    expect(sdk.contacts.add).toHaveBeenCalled();
    expect(sdk.discussions.start).toHaveBeenCalled();
    expect(sdk.conversations.addAsContact).not.toHaveBeenCalled();
  });

  it('imports the file of a hidden automatic contact, and refuses a contact with a translated message', async () => {
    importFileContact.mockResolvedValue({
      userPubKeys: new Uint8Array([1]),
      userName: 'Bob',
    });
    const event = {
      target: { files: [new File(['x'], 'bob.yaml')] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    contacts.set('bob', contact({ connection: 'automatic' }));
    await act(async () => f().handleFileImport(event));
    expect(toastError).not.toHaveBeenCalled();
    expect(f().userId.value).toBe('bob');
    expect(f().connectedNonContact).toBe(true);

    contacts.set('bob', contact({ name: 'Bob', connection: 'accepted' }));
    await act(async () => f().handleFileImport(event));
    expect(toastError).toHaveBeenCalledWith('new_contact.already_contact');
  });
});
