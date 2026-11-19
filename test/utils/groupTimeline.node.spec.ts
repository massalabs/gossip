import { describe, expect, it } from 'vitest';
import type { GroupSummary } from '@massalabs/gossip-sdk';
import {
  composerBlockedReason,
  lineTexts,
} from '../../src/utils/groupTimeline';

describe('group timeline helpers', () => {
  const base: GroupSummary = {
    groupId: 'g',
    currentEpoch: 'g',
    name: 'G',
    localName: null,
    members: [],
    owner: 'o',
    status: 'member',
    sideBranches: [],
    mustResolve: false,
    formerOwnerBranches: [],
    links: [],
  };

  it('gives the reason the composer is disabled', () => {
    expect(composerBlockedReason(base)).toBeNull();
    expect(composerBlockedReason({ ...base, mustResolve: true })).toBe(
      'composer.disabled_resolve'
    );
    expect(composerBlockedReason({ ...base, status: 'removed' })).toBe(
      'composer.disabled_removed'
    );
    expect(
      composerBlockedReason({ ...base, status: 'dissolved-deleted' })
    ).toBe('composer.disabled_dissolved');
  });

  it('isolates every name in a line', () => {
    const t = (key: string, o?: Record<string, unknown>) =>
      `${key}:${JSON.stringify(o ?? {})}`;
    const texts = lineTexts(
      {
        type: 'epochChange',
        epoch: 'e',
        by: 'o',
        added: ['a'],
        removed: [],
        left: ['l'],
        renamed: '‮evil',
        newOwner: null,
      },
      id => id.toUpperCase(),
      t
    );
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('⁨O⁩');
    expect(texts[2]).toContain('⁨evil⁩');
    expect(texts.join('')).not.toContain('‮');
  });

  const keyOf = (key: string, o?: Record<string, unknown>) =>
    `${key}:${String(o?.owner ?? '')}:${String(o?.name ?? o?.names ?? '')}`;
  const plain = (s: string) => s.replace(/[\u2068\u2069]/g, '');

  it('names who handed the group over, then that it left', () => {
    const texts = lineTexts(
      {
        type: 'epochChange',
        epoch: 'e',
        by: 'alice',
        added: [],
        removed: [],
        left: ['alice'],
        renamed: null,
        newOwner: 'bob',
      },
      id => id,
      keyOf
    ).map(plain);
    expect(texts).toEqual([
      'timeline.new_owner:alice:bob',
      'timeline.left::alice',
    ]);
  });

  it('tells a member who added it, and who added it back', () => {
    expect(
      lineTexts({ type: 'joined', epoch: 'e', by: 'bob' }, id => id, keyOf).map(
        plain
      )
    ).toEqual(['timeline.joined:bob:']);
    expect(
      lineTexts(
        { type: 'addedBack', epoch: 'e', by: 'eve' },
        id => id,
        keyOf
      ).map(plain)
    ).toEqual(['timeline.added_back:eve:']);
  });
});
