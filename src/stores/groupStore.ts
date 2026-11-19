import { logger } from '../utils/logger.ts';
import { create } from 'zustand';
import {
  SdkEventType,
  type GroupChange,
  type GroupInvitation,
  type GroupService,
  type GroupSummary,
} from '@massalabs/gossip-sdk';
import { getSdk } from './sdkStore';
import { createSelectors } from './utils/createSelectors';

/** The last visible message of a group, for the conversation list. */
export interface GroupLastMessage {
  author: string;
  text: string;
  at: number;
}

export interface GroupListEntry {
  summary: GroupSummary;
  lastMessage: GroupLastMessage | null;
  /** Messages changed while the group was not open (memory only). */
  unread: boolean;
}

interface GroupStoreState {
  /** Whether the group engine is open for this account. */
  available: boolean;
  groups: GroupListEntry[];
  invitations: GroupInvitation[];
  /** The group whose conversation is open, if any. */
  currentGroupId: string | null;
  /** Bumped on every change, so that an open timeline reads again. */
  version: number;
  cleanupFn: (() => void) | null;

  init: () => void;
  cleanup: () => void;
  refresh: () => void;
  setCurrentGroup: (groupId: string | null) => void;
  markRead: (groupId: string) => void;
}

/** The group service, or null when the engine could not be opened. */
export function getGroupService(): GroupService | null {
  try {
    return getSdk().groups;
  } catch {
    return null;
  }
}

function lastMessageOf(
  groups: GroupService,
  groupId: string
): GroupLastMessage | null {
  const timeline = groups.timeline(groupId);
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.kind !== 'message') continue;
    return {
      author: item.author,
      text: item.body.type === 'text' ? item.body.text : '',
      at: item.edited ? item.lastModifiedAt : item.createdAt,
    };
  }
  return null;
}

/**
 * Read state lives in memory only: storing it would record more about group
 * traffic than the engine's own records. It resets when the app restarts.
 */
const unread = new Set<string>();

const useGroupStoreBase = create<GroupStoreState>((set, get) => ({
  available: false,
  groups: [],
  invitations: [],
  currentGroupId: null,
  version: 0,
  cleanupFn: null,

  init: () => {
    if (get().cleanupFn) return;
    const groups = getGroupService();
    if (!groups) {
      set({ available: false });
      return;
    }
    const onChanged = ({ changes }: { changes: GroupChange[] }) => {
      const current = get().currentGroupId;
      for (const c of changes) {
        if (c.kind === 'Messages' && c.groupId !== current) {
          unread.add(c.groupId);
        }
        if (c.kind === 'Closed') unread.delete(c.groupId);
      }
      get().refresh();
    };
    const sdk = getSdk();
    sdk.on(SdkEventType.GROUPS_CHANGED, onChanged);
    set({
      available: true,
      cleanupFn: () => {
        try {
          sdk.off(SdkEventType.GROUPS_CHANGED, onChanged);
        } catch {
          // The SDK may already be gone.
        }
      },
    });
    get().refresh();
  },

  cleanup: () => {
    get().cleanupFn?.();
    unread.clear();
    set({
      available: false,
      groups: [],
      invitations: [],
      currentGroupId: null,
      cleanupFn: null,
    });
  },

  refresh: () => {
    const groups = getGroupService();
    if (!groups) return;
    try {
      const entries = groups.list().map(summary => ({
        summary,
        lastMessage: lastMessageOf(groups, summary.groupId),
        unread: unread.has(summary.groupId),
      }));
      entries.sort(
        (a, b) =>
          (b.lastMessage?.at ?? 0) - (a.lastMessage?.at ?? 0) ||
          a.summary.groupId.localeCompare(b.summary.groupId)
      );
      set(state => ({
        groups: entries,
        invitations: groups.invitations(),
        version: state.version + 1,
      }));
    } catch (error) {
      logger.error('Group list refresh failed', error);
    }
  },

  setCurrentGroup: (groupId: string | null) => {
    set({ currentGroupId: groupId });
    if (groupId) get().markRead(groupId);
  },

  markRead: (groupId: string) => {
    if (!unread.delete(groupId)) return;
    set(state => ({
      groups: state.groups.map(g =>
        g.summary.groupId === groupId ? { ...g, unread: false } : g
      ),
    }));
  },
}));

export const useGroupStore = createSelectors(useGroupStoreBase);
