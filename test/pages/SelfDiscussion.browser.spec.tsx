// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { act } from 'react';

let latestInitialValue: string | undefined;
let latestOnSend: ((text: string) => void | Promise<void>) | null = null;

const mockNavigate = vi.fn();
const mockGetMessage = vi.fn();
const mockSendSelfMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ state: { forwardFromMessageId: 42 } }),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../src/stores/sdkStore', () => ({
  getSdk: () => ({
    messages: {
      get: mockGetMessage,
    },
  }),
}));

vi.mock('../../src/stores/selfMessageStore', () => ({
  useSelfMessageStore: {
    use: {
      messages: () => [],
      reactions: () => new Map(),
      isLoading: () => false,
      loadMessages: () => vi.fn(),
      sendMessage: () => mockSendSelfMessage,
      editMessage: () => vi.fn(),
      deleteMessage: () => vi.fn(),
      sendReaction: () => vi.fn(),
      removeReaction: () => vi.fn(),
      loadReactions: () => vi.fn(),
    },
  },
}));

vi.mock('../../src/components/discussions/MessageList', () => ({
  default: () => <div>MessageList</div>,
}));

vi.mock('../../src/components/ui/BackButton', () => ({
  default: () => <button type="button">Back</button>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../src/components/discussions/MessageInput', () => ({
  default: ({
    initialValue,
    onSend,
  }: {
    initialValue?: string;
    onSend: (text: string) => void;
  }) => {
    latestInitialValue = initialValue;
    latestOnSend = onSend;
    return (
      <div data-testid="mock-message-input">
        <span data-testid="initial-value">{initialValue ?? ''}</span>
        <button
          type="button"
          aria-label="mock send self"
          onClick={() => onSend(initialValue ?? '')}
        >
          Send
        </button>
      </div>
    );
  },
}));

import SelfDiscussion from '../../src/pages/SelfDiscussion';

describe('SelfDiscussion forward to self notes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestInitialValue = undefined;
    latestOnSend = null;
    mockGetMessage.mockResolvedValue({
      id: 42,
      content: 'Forwarded note content',
    });
    mockSendSelfMessage.mockResolvedValue(undefined);
  });

  it('prefills the input with forwarded message content', async () => {
    render(<SelfDiscussion />);
    await act(async () => {});

    expect(mockGetMessage).toHaveBeenCalledWith(42);
    expect(latestInitialValue).toBe('Forwarded note content');
  });

  it('sends the forwarded content as a self note when sending', async () => {
    render(<SelfDiscussion />);
    await act(async () => {});

    expect(latestOnSend).toBeTruthy();
    await latestOnSend?.('Forwarded note content');

    expect(mockSendSelfMessage).toHaveBeenCalledWith('Forwarded note content');
  });
});
