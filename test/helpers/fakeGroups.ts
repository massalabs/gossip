import { vi } from 'vitest';
import type {
  GroupInvitation,
  GroupSummary,
  GroupTimelineItem,
} from '@massalabs/gossip-sdk';

/** A group service with canned reads and spied actions, and an SDK around it. */
export function makeFakeGroups() {
  const state = {
    groups: [] as GroupSummary[],
    invitations: [] as GroupInvitation[],
    timelines: new Map<string, GroupTimelineItem[]>(),
  };
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const service = {
    list: vi.fn(async () => state.groups),
    get: vi.fn(
      async (id: string) => state.groups.find(g => g.groupId === id) ?? null
    ),
    invitations: vi.fn(async () => state.invitations),
    timeline: vi.fn(async (id: string) => state.timelines.get(id) ?? []),
    epoch: vi.fn(async () => null),
    createGroup: vi.fn(async () => 'g1'),
    changeMembers: vi.fn(async () => 'e2'),
    handOver: vi.fn(async () => 'e2'),
    resolveFork: vi.fn(async () => 'e3'),
    setMessageTimer: vi.fn(async () => 'e4'),
    dissolve: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    deleteGroup: vi.fn(async () => {}),
    acceptInvitation: vi.fn(async (e: string) => e),
    declineInvitation: vi.fn(async () => {}),
    resendRoot: vi.fn(async () => {}),
    setLocalName: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => ({
      eventId: 'ev',
      syncObjId: 's',
      merge: 'Won',
    })),
    sendMessageLocally: vi.fn(async () => ({ syncObjId: 'local' })),
    editMessage: vi.fn(async () => ({}) as never),
    deleteMessage: vi.fn(async () => ({}) as never),
    deleteMessageLocally: vi.fn(async () => {}),
    editMessageLocally: vi.fn(async () => {}),
    retryMessage: vi.fn(async () => ({}) as never),
    react: vi.fn(async () => ({}) as never),
    unreact: vi.fn(async () => ({}) as never),
    messageLimits: { textBytes: 16_384, metadataBytes: 16_384 },
  };
  const sdk = {
    isSessionOpen: true,
    groups: service,
    on: vi.fn((event: string, h: (p: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(h);
    }),
    off: vi.fn((event: string, h: (p: unknown) => void) => {
      handlers.get(event)?.delete(h);
    }),
    emit(event: string, payload: unknown) {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
    handlers,
    discussions: { getStatus: vi.fn(() => 0) },
    contacts: { list: vi.fn(async () => []) },
    conversations: {
      migrationTimer: vi.fn(async () => 0),
      migrate: vi.fn(async () => 'g9'),
      startDirectChat: vi.fn(async () => 'g8'),
      directChatWith: vi.fn(async () => null),
      acceptInvitation: vi.fn(async (e: string) => e),
      declineInvitation: vi.fn(async () => {}),
      setArchived: vi.fn(async () => {}),
      addAsContact: vi.fn(async () => ({ success: true })),
    },
  };
  return { state, service, sdk };
}

export function summary(over: Partial<GroupSummary> = {}): GroupSummary {
  return {
    groupId: 'g1',
    currentEpoch: 'g1',
    name: 'Trip',
    localName: null,
    members: ['me', 'bob'],
    owner: 'me',
    status: 'member',
    sideBranches: [],
    formerOwnerBranches: [],
    mustResolve: false,
    links: [],
    supersededBy: null,
    earlier: [],
    tookPart: null,
    messageTimer: 0,
    timers: [],
    ...over,
  };
}

/** Lets pending promises and effects run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}
