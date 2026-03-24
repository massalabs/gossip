// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import {
  MessageDirection,
  MessageStatus,
  MessageType,
} from '@massalabs/gossip-sdk';
import type { Message } from '@massalabs/gossip-sdk';

vi.mock('../../../src/hooks/useGossipSdk', () => ({
  useGossipSdk: () => ({ isSessionOpen: false }),
}));

import {
  useVirtualItems,
  useMessageGroups,
} from '../../../src/components/discussions/hooks/useMessageListItems';

// ---------------------------------------------------------------------------
// Helper component: renders hook results into the DOM for querying
// ---------------------------------------------------------------------------

function VirtualItemsHarness({
  messages,
  retentionInfo,
}: {
  messages: Message[];
  retentionInfo?: { setAt: number; duration: number } | null;
}) {
  const groups = useMessageGroups(messages);
  const items = useVirtualItems(messages, groups, null, retentionInfo);
  const types = items.map(i => i.type).join(',');
  const separatorCount = items.filter(
    i => i.type === 'retention-separator'
  ).length;
  const separatorIndex = items.findIndex(i => i.type === 'retention-separator');
  return (
    <div>
      <span data-testid="types">{types}</span>
      <span data-testid="separator-count">{String(separatorCount)}</span>
      <span data-testid="separator-index">{String(separatorIndex)}</span>
    </div>
  );
}

function makeMessage(id: number, timestamp: Date): Message {
  return {
    id,
    msgId: id,
    ownerUserId: 'owner',
    contactUserId: 'contact',
    content: `Message ${id}`,
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.SENT,
    type: MessageType.TEXT,
    timestamp,
    unread: false,
  } as Message;
}

async function getTypes(): Promise<string[]> {
  const text = (await page.getByTestId('types').element()).textContent ?? '';
  return text.split(',').filter(Boolean);
}
async function getSeparatorCount(): Promise<number> {
  return parseInt(
    (await page.getByTestId('separator-count').element()).textContent ?? '0',
    10
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useVirtualItems – retention separator injection', () => {
  it('injects no separator when retentionInfo is null', async () => {
    const messages = [
      makeMessage(1, new Date('2025-01-01T10:00:00Z')),
      makeMessage(2, new Date('2025-01-01T11:00:00Z')),
    ];

    render(<VirtualItemsHarness messages={messages} retentionInfo={null} />);

    expect(await getSeparatorCount()).toBe(0);
  });

  it('injects a separator between pre-policy and post-policy messages', async () => {
    const policySetAt = new Date('2025-01-01T10:30:00Z').getTime();

    const messages = [
      makeMessage(1, new Date('2025-01-01T10:00:00Z')), // before policy
      makeMessage(2, new Date('2025-01-01T11:00:00Z')), // after policy
    ];

    render(
      <VirtualItemsHarness
        messages={messages}
        retentionInfo={{ setAt: policySetAt, duration: 3600 }}
      />
    );

    expect(await getSeparatorCount()).toBe(1);

    const types = await getTypes();
    const sepIdx = types.indexOf('retention-separator');
    const lastMsgIdx = types.lastIndexOf('message');
    // Separator must appear before the last (post-policy) message
    expect(sepIdx).toBeGreaterThan(-1);
    expect(sepIdx).toBeLessThan(lastMsgIdx);
  });

  it('injects separator at the end (before spacer) when all messages predate the policy', async () => {
    const policySetAt = new Date('2025-01-01T12:00:00Z').getTime();

    const messages = [
      makeMessage(1, new Date('2025-01-01T09:00:00Z')),
      makeMessage(2, new Date('2025-01-01T10:00:00Z')),
    ];

    render(
      <VirtualItemsHarness
        messages={messages}
        retentionInfo={{ setAt: policySetAt, duration: 3600 }}
      />
    );

    expect(await getSeparatorCount()).toBe(1);

    const types = await getTypes();
    const sepIdx = types.indexOf('retention-separator');
    const spacerIdx = types.indexOf('spacer');
    // Separator should be immediately before the spacer
    expect(sepIdx).toBe(spacerIdx - 1);
  });

  it('injects separator before the first message when all messages postdate the policy', async () => {
    const policySetAt = new Date('2025-01-01T08:00:00Z').getTime();

    const messages = [
      makeMessage(1, new Date('2025-01-01T09:00:00Z')),
      makeMessage(2, new Date('2025-01-01T10:00:00Z')),
    ];

    render(
      <VirtualItemsHarness
        messages={messages}
        retentionInfo={{ setAt: policySetAt, duration: 3600 }}
      />
    );

    expect(await getSeparatorCount()).toBe(1);

    const types = await getTypes();
    const sepIdx = types.indexOf('retention-separator');
    const firstMsgIdx = types.indexOf('message');
    // Separator must come before the first message
    expect(sepIdx).toBeLessThan(firstMsgIdx);
  });

  it('injects exactly one separator with many messages spanning the boundary', async () => {
    const policySetAt = new Date('2025-01-01T10:30:00Z').getTime();

    const messages = [
      makeMessage(1, new Date('2025-01-01T09:00:00Z')),
      makeMessage(2, new Date('2025-01-01T09:30:00Z')),
      makeMessage(3, new Date('2025-01-01T11:00:00Z')),
      makeMessage(4, new Date('2025-01-01T11:30:00Z')),
    ];

    render(
      <VirtualItemsHarness
        messages={messages}
        retentionInfo={{ setAt: policySetAt, duration: 3600 }}
      />
    );

    expect(await getSeparatorCount()).toBe(1);
  });

  it('injects separator via discussion.retentionPolicySetAt (regular discussion path)', async () => {
    const policySetAt = new Date('2025-01-01T10:30:00Z').getTime();

    function WithDiscussion() {
      const messages = [
        makeMessage(1, new Date('2025-01-01T10:00:00Z')),
        makeMessage(2, new Date('2025-01-01T11:00:00Z')),
      ];
      const groups = useMessageGroups(messages);
      // Pass retention info via the discussion object (no retentionInfo prop)
      const fakeDiscussion = {
        retentionPolicySetAt: policySetAt,
        messageRetentionDuration: 3600,
        direction: 'initiated',
      } as unknown as import('@massalabs/gossip-sdk').Discussion;
      const items = useVirtualItems(messages, groups, fakeDiscussion);
      const separatorCount = items.filter(
        i => i.type === 'retention-separator'
      ).length;
      return (
        <span data-testid="separator-count">{String(separatorCount)}</span>
      );
    }

    render(<WithDiscussion />);
    expect(await getSeparatorCount()).toBe(1);
  });
});
