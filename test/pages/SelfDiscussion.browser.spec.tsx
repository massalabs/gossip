// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { act } from 'react';

let latestInitialValue: string | undefined;
let latestOnSend: ((text: string) => void | Promise<void>) | null = null;
let mockLocationState: { forwardFromMessageId?: number } = {
  forwardFromMessageId: 42,
};

const mockNavigate = vi.fn();
const mockGetMessage = vi.fn();
const mockSendSelfMessage = vi.fn().mockResolvedValue(undefined);
const mockGetSelfRetentionInfo = vi
  .fn()
  .mockResolvedValue({ duration: null, setAt: null });
const mockSetSelfRetentionPolicy = vi.fn().mockResolvedValue(undefined);

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ state: mockLocationState }),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../src/stores/sdkStore', () => ({
  getSdk: () => ({
    isSessionOpen: true,
    messages: {
      get: mockGetMessage,
    },
    selfMessages: {
      getRetentionInfo: mockGetSelfRetentionInfo,
      setRetentionPolicy: mockSetSelfRetentionPolicy,
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
    t: (key: string, options?: { duration?: string }) =>
      options?.duration ? `${key}:${options.duration}` : key,
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
    mockLocationState = { forwardFromMessageId: 42 };
    latestInitialValue = undefined;
    latestOnSend = null;
    mockGetMessage.mockResolvedValue({
      id: 42,
      content: 'Forwarded note content',
    });
    mockSendSelfMessage.mockResolvedValue(undefined);
    mockGetSelfRetentionInfo.mockResolvedValue({ duration: null, setAt: null });
    mockSetSelfRetentionPolicy.mockResolvedValue(undefined);
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

  it('loads and updates self retention duration from settings', async () => {
    mockLocationState = {};
    mockGetSelfRetentionInfo.mockResolvedValue({
      duration: 3600,
      setAt: Date.now() - 1000,
    });

    render(<SelfDiscussion />);
    await act(async () => {});

    expect(mockGetSelfRetentionInfo).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      'header.auto_delete_active:settings.auto_delete_1h'
    );

    const settingsButton = document.querySelector(
      'button[aria-label="settings.auto_delete"]'
    ) as HTMLButtonElement | null;
    expect(settingsButton).toBeTruthy();

    settingsButton?.click();
    await act(async () => {});

    const oneDayButton = Array.from(document.querySelectorAll('button')).find(
      button => button.textContent?.trim() === 'settings.auto_delete_1d'
    );
    expect(oneDayButton).toBeTruthy();

    (oneDayButton as HTMLButtonElement).click();
    await act(async () => {});

    expect(mockSetSelfRetentionPolicy).toHaveBeenCalledWith(86400);
    expect(document.body.textContent).toContain(
      'header.auto_delete_active:settings.auto_delete_1d'
    );
  });
});
