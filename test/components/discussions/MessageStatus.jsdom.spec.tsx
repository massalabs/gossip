import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
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

function expectStatusIcons(
  el: HTMLElement,
  expected: {
    svgCount: number;
    sending?: boolean;
    sent?: boolean;
    delivered?: boolean;
  }
) {
  expect(el.querySelectorAll('svg')).toHaveLength(expected.svgCount);
  expect(el.querySelector('[aria-label="message_item.sending"]') !== null).toBe(
    expected.sending ?? false
  );
  expect(el.querySelector('[aria-label="message_item.sent"]') !== null).toBe(
    expected.sent ?? false
  );
  expect(
    el.querySelector('[aria-label="message_item.delivered"]') !== null
  ).toBe(expected.delivered ?? false);
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
  it.each([
    [MessageStatusEnum.WAITING_SESSION, true],
    [MessageStatusEnum.READY, true],
  ])('renders a sending clock for outgoing pending status %s', status => {
    const el = renderStatus({ status, isSending: true });

    expectStatusIcons(el, { svgCount: 1, sending: true });
  });

  it.each([[MessageStatusEnum.WAITING_SESSION], [MessageStatusEnum.READY]])(
    'renders an optimistic sent tick for pending status %s',
    status => {
      const el = renderStatus({ status, isOptimisticallySent: true });

      expectStatusIcons(el, { svgCount: 1, sent: true });
    }
  );

  it('renders a sent tick for sent outgoing messages', () => {
    const el = renderStatus({ status: MessageStatusEnum.SENT });

    expectStatusIcons(el, { svgCount: 1, sent: true });
  });

  it.each([MessageStatusEnum.DELIVERED, MessageStatusEnum.READ])(
    'renders a delivered/read double tick for outgoing status %s',
    status => {
      const el = renderStatus({ status });

      expectStatusIcons(el, { svgCount: 2, delivered: true });
    }
  );

  it('does not render delivery icons for incoming messages', () => {
    const el = renderStatus({
      status: MessageStatusEnum.DELIVERED,
      isOutgoing: false,
      showTimestamp: true,
    });

    expectStatusIcons(el, { svgCount: 0 });
  });

  it('does not render optimistic sent and delivered ticks at the same time', () => {
    const el = renderStatus({
      status: MessageStatusEnum.DELIVERED,
      isOptimisticallySent: true,
    });

    expectStatusIcons(el, { svgCount: 2, delivered: true });
  });

  it('does not render optimistic sent and read ticks at the same time', () => {
    const el = renderStatus({
      status: MessageStatusEnum.READ,
      isOptimisticallySent: true,
    });

    expectStatusIcons(el, { svgCount: 2, delivered: true });
  });

  it.each([MessageStatusEnum.DELIVERED, MessageStatusEnum.READ])(
    'does not render the sending clock once status is %s',
    status => {
      const el = renderStatus({
        status,
        isSending: true,
      });

      expectStatusIcons(el, { svgCount: 2, delivered: true });
    }
  );
});
