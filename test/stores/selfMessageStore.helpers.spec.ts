import { describe, it, expect } from 'vitest';
import {
  groupReactions,
  addOptimisticReaction,
  replaceReactionId,
  decrementReaction,
  findReactionById,
  restoreReactionGroup,
} from '../../src/stores/selfMessageStore.helpers';

describe('groupReactions', () => {
  it('groups duplicate emojis and sums counts', () => {
    const map = groupReactions([
      { id: 1, emoji: '👍', originalMessageId: 10 },
      { id: 2, emoji: '👍', originalMessageId: 10 },
      { id: 3, emoji: '🔥', originalMessageId: 10 },
    ]);
    const groups = map.get(10)!;
    expect(groups).toHaveLength(2);
    const thumbs = groups.find(g => g.emoji === '👍')!;
    expect(thumbs.count).toBe(2);
    expect(thumbs.myReactionId).toBe(2);
  });

  it('keys distinct messages separately', () => {
    const map = groupReactions([
      { id: 1, emoji: '👍', originalMessageId: 10 },
      { id: 2, emoji: '👍', originalMessageId: 20 },
    ]);
    expect(map.get(10)![0].count).toBe(1);
    expect(map.get(20)![0].count).toBe(1);
  });
});

describe('addOptimisticReaction', () => {
  it('adds a new group when emoji is new', () => {
    const next = addOptimisticReaction(new Map(), 10, '👍', -1);
    expect(next.get(10)).toEqual([{ emoji: '👍', count: 1, myReactionId: -1 }]);
  });

  it('increments existing group count', () => {
    const initial = new Map([
      [10, [{ emoji: '👍', count: 2, myReactionId: undefined }]],
    ]);
    const next = addOptimisticReaction(initial, 10, '👍', -1);
    expect(next.get(10)![0].count).toBe(3);
    expect(next.get(10)![0].myReactionId).toBe(-1);
  });

  it('returns a new Map (immutability)', () => {
    const initial = new Map();
    const next = addOptimisticReaction(initial, 10, '👍', -1);
    expect(next).not.toBe(initial);
    expect(initial.size).toBe(0);
  });
});

describe('replaceReactionId', () => {
  it('swaps tempId for real id on the matching group', () => {
    const initial = new Map([
      [10, [{ emoji: '👍', count: 1, myReactionId: -5 }]],
    ]);
    const next = replaceReactionId(initial, 10, -5, 42);
    expect(next.get(10)![0].myReactionId).toBe(42);
  });

  it('is a no-op when messageId not present', () => {
    const initial = new Map();
    const next = replaceReactionId(initial, 10, -5, 42);
    expect(next.has(10)).toBe(false);
  });
});

describe('decrementReaction', () => {
  it('decrements count and clears myReactionId', () => {
    const initial = new Map([
      [10, [{ emoji: '👍', count: 2, myReactionId: 42 }]],
    ]);
    const next = decrementReaction(initial, 10, g => g.myReactionId === 42);
    expect(next.get(10)![0].count).toBe(1);
    expect(next.get(10)![0].myReactionId).toBeUndefined();
  });

  it('removes the group when count drops to 0', () => {
    const initial = new Map([
      [10, [{ emoji: '👍', count: 1, myReactionId: 42 }]],
    ]);
    const next = decrementReaction(initial, 10, g => g.myReactionId === 42);
    expect(next.has(10)).toBe(false);
  });

  it('keeps other groups intact', () => {
    const initial = new Map([
      [
        10,
        [
          { emoji: '👍', count: 1, myReactionId: 42 },
          { emoji: '🔥', count: 3, myReactionId: undefined },
        ],
      ],
    ]);
    const next = decrementReaction(initial, 10, g => g.myReactionId === 42);
    const groups = next.get(10)!;
    expect(groups).toHaveLength(1);
    expect(groups[0].emoji).toBe('🔥');
  });
});

describe('findReactionById', () => {
  it('returns the containing messageId and group', () => {
    const initial = new Map([
      [10, [{ emoji: '👍', count: 1, myReactionId: 42 }]],
      [20, [{ emoji: '🔥', count: 1, myReactionId: 99 }]],
    ]);
    expect(findReactionById(initial, 99)).toEqual({
      messageId: 20,
      group: { emoji: '🔥', count: 1, myReactionId: 99 },
    });
  });

  it('returns null when reactionId not found', () => {
    expect(findReactionById(new Map(), 99)).toBeNull();
  });
});

describe('restoreReactionGroup', () => {
  it('appends a group to an existing entry', () => {
    const initial = new Map([
      [10, [{ emoji: '👍', count: 1, myReactionId: 1 }]],
    ]);
    const next = restoreReactionGroup(initial, 10, {
      emoji: '🔥',
      count: 1,
      myReactionId: 2,
    });
    expect(next.get(10)).toHaveLength(2);
  });

  it('creates a new entry when messageId not present', () => {
    const next = restoreReactionGroup(new Map(), 10, {
      emoji: '👍',
      count: 1,
      myReactionId: 1,
    });
    expect(next.get(10)).toEqual([{ emoji: '👍', count: 1, myReactionId: 1 }]);
  });
});
