import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageStatus as MessageStatusEnum } from '@massalabs/gossip-sdk';
import MessageStatusIndicator from '../../../src/components/discussions/MessageStatus';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderStatus(
  props: Partial<React.ComponentProps<typeof MessageStatusIndicator>> = {}
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root!.render(
      <MessageStatusIndicator
        status={MessageStatusEnum.SENT}
        timestamp={new Date('2026-01-01T12:00:00Z')}
        isOutgoing={true}
        isDeleted={false}
        isEdited={false}
        isSending={false}
        showTimestamp={false}
        {...props}
      />
    );
  });

  return container;
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('MessageStatusIndicator', () => {
  it('does not render optimistic sent and delivered ticks at the same time', () => {
    const el = renderStatus({
      status: MessageStatusEnum.DELIVERED,
      isOptimisticallySent: true,
    });

    expect(el.querySelectorAll('svg')).toHaveLength(2);
    expect(el.querySelector('[aria-label="message_item.sent"]')).toBeNull();
    expect(
      el.querySelector('[aria-label="message_item.delivered"]')
    ).not.toBeNull();
  });
});
