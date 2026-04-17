// Tests for the useDiscussionActions hook — focus on synchronous UI-state
// resets (banners / input prefill) BEFORE the underlying send/edit promise
// resolves. Runs in jsdom.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockedFunction,
} from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import {
  Message,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '@massalabs/gossip-sdk';

type SendMessage = (
  contactUserId: string,
  text: string,
  replyToId?: number,
  forwardFromMessageId?: number
) => Promise<void>;

type EditMessage = (
  contactUserId: string,
  messageId: number,
  newContent: string
) => Promise<void>;

const sendMessageMock: MockedFunction<SendMessage> = vi.fn();
const editMessageMock: MockedFunction<EditMessage> = vi.fn();
const deleteMessageMock = vi.fn(async () => {});

vi.mock('../../src/stores/messageStore', () => ({
  useMessageStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        sendMessage: sendMessageMock,
        deleteMessage: deleteMessageMock,
        editMessage: editMessageMock,
      }),
    {
      getState: () => ({
        sendMessage: sendMessageMock,
        deleteMessage: deleteMessageMock,
        editMessage: editMessageMock,
      }),
    }
  ),
}));

vi.mock('../../src/stores/appStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      setPendingSharedContent: vi.fn(),
      setPendingForwardMessageId: vi.fn(),
    }),
}));

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn() },
}));

import { useDiscussionActions } from '../../src/hooks/useDiscussionActions';

interface HookRef {
  current: ReturnType<typeof useDiscussionActions> | null;
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    messageId: new Uint8Array(12).fill(1),
    ownerUserId: 'me',
    contactUserId: 'contact-1',
    content: 'hello',
    type: MessageType.TEXT,
    direction: MessageDirection.INCOMING,
    status: MessageStatus.DELIVERED,
    timestamp: new Date('2024-01-01T10:00:00Z'),
    ...overrides,
  };
}

interface HarnessProps {
  setReplyingTo: (msg: Message | null) => void;
  setEditingMessage: (msg: Message | null) => void;
  setInputPrefill: (text: string | undefined) => void;
  clearForward: () => void;
  forwardFromMessageId?: number;
}

function renderHook(container: HTMLDivElement, props: HarnessProps): HookRef {
  const ref: HookRef = { current: null };
  const translate = ((key: string) => key) as unknown as Parameters<
    typeof useDiscussionActions
  >[0]['t'];

  function Harness() {
    ref.current = useDiscussionActions({
      contact: { userId: 'contact-1' },
      isSelecting: false,
      t: translate,
      forwardFromMessageId: props.forwardFromMessageId,
      setReplyingTo: props.setReplyingTo,
      setEditingMessage: props.setEditingMessage,
      setInputPrefill: props.setInputPrefill,
      clearForward: props.clearForward,
    });
    return null;
  }

  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      React.createElement(MemoryRouter, null, React.createElement(Harness))
    );
  });

  // Ensure root is cleaned up after the test — attach to container node
  (container as unknown as { __root: Root }).__root = root;
  return ref;
}

describe('useDiscussionActions.handleSendMessage', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    const root = (container as unknown as { __root?: Root }).__root;
    act(() => {
      root?.unmount();
    });
    container.remove();
  });

  it('clears reply/edit/forward/prefill synchronously, before sendMessage resolves', async () => {
    let resolveSend!: () => void;
    sendMessageMock.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveSend = resolve;
      })
    );

    const setReplyingTo = vi.fn();
    const setEditingMessage = vi.fn();
    const setInputPrefill = vi.fn();
    const clearForward = vi.fn();

    const ref = renderHook(container, {
      setReplyingTo,
      setEditingMessage,
      setInputPrefill,
      clearForward,
      forwardFromMessageId: 42,
    });

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = ref.current!.handleSendMessage('hi', 7);
    });

    // All clears must have fired synchronously — before send resolves
    expect(setReplyingTo).toHaveBeenCalledWith(null);
    expect(setEditingMessage).toHaveBeenCalledWith(null);
    expect(clearForward).toHaveBeenCalledOnce();
    expect(setInputPrefill).toHaveBeenCalledWith(undefined);

    // sendMessage was called with the snapshotted forwardFromMessageId
    expect(sendMessageMock).toHaveBeenCalledWith('contact-1', 'hi', 7, 42);

    await act(async () => {
      resolveSend();
      await sendPromise;
    });
  });

  it('clears editing/prefill synchronously in handleConfirmEdit, before editMessage resolves', async () => {
    let resolveEdit!: () => void;
    editMessageMock.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveEdit = resolve;
      })
    );

    const setReplyingTo = vi.fn();
    const setEditingMessage = vi.fn();
    const setInputPrefill = vi.fn();
    const clearForward = vi.fn();

    const ref = renderHook(container, {
      setReplyingTo,
      setEditingMessage,
      setInputPrefill,
      clearForward,
    });

    const message = makeMessage({ id: 99, content: 'old' });
    let editPromise!: Promise<void>;
    act(() => {
      editPromise = ref.current!.handleConfirmEdit('new content', message);
    });

    expect(setEditingMessage).toHaveBeenCalledWith(null);
    expect(setInputPrefill).toHaveBeenCalledWith(undefined);
    expect(editMessageMock).toHaveBeenCalledWith(
      'contact-1',
      99,
      'new content'
    );

    await act(async () => {
      resolveEdit();
      await editPromise;
    });
  });
});
