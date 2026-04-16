// Pure helpers for selfMessageStore's ReactionGroup map manipulations.
// Reactions in self-discussions are stored pre-grouped as
// Map<messageDbId, ReactionGroup[]>, indexed by the original message id.

import type { ReactionGroup } from './messageStore';

export type ReactionsMap = Map<number, ReactionGroup[]>;

export function groupReactions(
  raw: Array<{ id: number; emoji: string; originalMessageId: number }>
): ReactionsMap {
  const map: ReactionsMap = new Map();
  for (const { id, emoji, originalMessageId } of raw) {
    const existing: ReactionGroup[] = map.get(originalMessageId) ?? [];
    const idx = existing.findIndex(g => g.emoji === emoji);
    if (idx >= 0) {
      existing[idx] = {
        ...existing[idx],
        count: existing[idx].count + 1,
        myReactionId: id,
      };
    } else {
      existing.push({ emoji, count: 1, myReactionId: id });
    }
    map.set(originalMessageId, existing);
  }
  return map;
}

export function addOptimisticReaction(
  reactions: ReactionsMap,
  messageId: number,
  emoji: string,
  tempId: number
): ReactionsMap {
  const next = new Map(reactions);
  const existing: ReactionGroup[] = next.get(messageId) ?? [];
  const idx = existing.findIndex(g => g.emoji === emoji);
  if (idx >= 0) {
    const updated = [...existing];
    updated[idx] = {
      ...updated[idx],
      count: updated[idx].count + 1,
      myReactionId: tempId,
    };
    next.set(messageId, updated);
  } else {
    next.set(messageId, [
      ...existing,
      { emoji, count: 1, myReactionId: tempId },
    ]);
  }
  return next;
}

export function replaceReactionId(
  reactions: ReactionsMap,
  messageId: number,
  tempId: number,
  realId: number
): ReactionsMap {
  const next = new Map(reactions);
  const groups = next.get(messageId);
  if (!groups) return next;
  next.set(
    messageId,
    groups.map(g =>
      g.myReactionId === tempId ? { ...g, myReactionId: realId } : g
    )
  );
  return next;
}

export function decrementReaction(
  reactions: ReactionsMap,
  messageId: number,
  matcher: (g: ReactionGroup) => boolean
): ReactionsMap {
  const next = new Map(reactions);
  const groups = next.get(messageId);
  if (!groups) return next;
  const updated = groups
    .map(g =>
      matcher(g) ? { ...g, count: g.count - 1, myReactionId: undefined } : g
    )
    .filter(g => g.count > 0);
  if (updated.length === 0) next.delete(messageId);
  else next.set(messageId, updated);
  return next;
}

export function findReactionById(
  reactions: ReactionsMap,
  reactionId: number
): { messageId: number; group: ReactionGroup } | null {
  for (const [msgId, groups] of reactions) {
    const group = groups.find(g => g.myReactionId === reactionId);
    if (group) return { messageId: msgId, group };
  }
  return null;
}

export function restoreReactionGroup(
  reactions: ReactionsMap,
  messageId: number,
  group: ReactionGroup
): ReactionsMap {
  const next = new Map(reactions);
  const existing: ReactionGroup[] = next.get(messageId) ?? [];
  next.set(messageId, [...existing, group]);
  return next;
}
