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
import { toDate } from '../utils/groupTimeline';

/** The last visible message of a group, for the conversation list. */
export interface GroupLastMessage {
  author: string;
  text: string;
  at: number;
  /** A media message, shown as a placeholder (its data is never read). */
  media: boolean;
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
  /**
   * The conversations: replaced chats of two (`superseded`) are not among
   * them, they are shown as the earlier part of the chat that continues them.
   */
  groups: GroupListEntry[];
  /** Each replaced chat of two, with the chat that continues it. */
  supersededBy: Record<string, string>;
  invitations: GroupInvitation[];
  /** The group whose conversation is open, if any. */
  currentGroupId: string | null;
  /** Bumped on every change, so that an open timeline reads again. */
  version: number;
  cleanupFn: (() => void) | null;

  init: () => void;
  cleanup: () => void;
  refresh: () => Promise<void>;
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

async function lastMessageOf(
  groups: GroupService,
  groupId: string
): Promise<GroupLastMessage | null> {
  const timeline = await groups.timeline(groupId);
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.kind !== 'message') continue;
    return {
      author: item.author,
      text: item.body.type === 'text' ? item.body.text : '',
      at: toDate(item.edited ? item.lastModifiedAt : item.createdAt).getTime(),
      media: item.body.type === 'media',
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
  supersededBy: {},
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
    // A change of reactions alone (`Reactions`) is read again, never unread.
    const onChanged = ({ changes }: { changes: GroupChange[] }) => {
      const current = get().currentGroupId;
      for (const c of changes) {
        if (c.kind === 'Messages' && c.groupId !== current) {
          unread.add(c.groupId);
        }
        if (c.kind === 'Closed') unread.delete(c.groupId);
      }
      void get().refresh();
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
    void get().refresh();
  },

  cleanup: () => {
    get().cleanupFn?.();
    unread.clear();
    set({
      available: false,
      groups: [],
      supersededBy: {},
      invitations: [],
      currentGroupId: null,
      cleanupFn: null,
    });
  },

  refresh: async () => {
    const groups = getGroupService();
    if (!groups) return;
    try {
      const summaries = await groups.list();
      const entries: GroupListEntry[] = [];
      const supersededBy: Record<string, string> = {};
      for (const summary of summaries) {
        if (summary.status === 'superseded') {
          if (summary.supersededBy) {
            supersededBy[summary.groupId] = summary.supersededBy;
          }
          continue;
        }
        // A chat with nothing written yet shows the last message of the
        // chats it continues.
        let lastMessage = await lastMessageOf(groups, summary.groupId);
        for (const e of [...summary.earlier].reverse()) {
          if (lastMessage) break;
          lastMessage = await lastMessageOf(groups, e).catch(() => null);
        }
        entries.push({
          summary,
          lastMessage,
          unread:
            unread.has(summary.groupId) ||
            summary.earlier.some(e => unread.has(e)),
        });
      }
      entries.sort(
        (a, b) =>
          (b.lastMessage?.at ?? 0) - (a.lastMessage?.at ?? 0) ||
          a.summary.groupId.localeCompare(b.summary.groupId)
      );
      const invitations = await groups.invitations();
      if (!get().available) return;
      set(state => ({
        groups: entries,
        supersededBy,
        invitations,
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
    const earlier =
      get().groups.find(g => g.summary.groupId === groupId)?.summary.earlier ??
      [];
    let changed = false;
    for (const g of [groupId, ...earlier])
      changed = unread.delete(g) || changed;
    if (!changed) return;
    set(state => ({
      groups: state.groups.map(g =>
        g.summary.groupId === groupId ? { ...g, unread: false } : g
      ),
    }));
  },
}));

export const useGroupStore = createSelectors(useGroupStoreBase);
