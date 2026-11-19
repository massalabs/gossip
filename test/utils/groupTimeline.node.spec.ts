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

  describe('in the second person', () => {
    const me = 'me';
    // A name for "me" that must never be put in a sentence.
    const memberName = (id: string) => (id === me ? 'YOU' : id);
    const texts = (line: Parameters<typeof lineTexts>[0]) => {
      const out = lineTexts(line, memberName, keyOf, me).map(plain);
      expect(out.join(' ')).not.toContain('YOU');
      return out;
    };
    const change = {
      type: 'epochChange' as const,
      epoch: 'e',
      added: [] as string[],
      removed: [] as string[],
      left: [] as string[],
      renamed: null,
      newOwner: null,
    };

    it('tells the new owner the group was handed over to it', () => {
      expect(
        texts({ ...change, by: 'alice', left: ['alice'], newOwner: me })
      ).toEqual(['timeline.new_owner_you:alice:', 'timeline.left::alice']);
    });

    it('says what this account did with strings of its own', () => {
      expect(
        texts({
          ...change,
          by: me,
          added: ['bob'],
          removed: ['carol'],
          renamed: 'x',
          newOwner: 'bob',
        })
      ).toEqual([
        'timeline.new_owner_by_you::bob',
        'timeline.added_by_you::bob',
        'timeline.removed_by_you::carol',
        'timeline.renamed_by_you::x',
      ]);
      expect(texts({ type: 'founded', epoch: 'e', owner: me })).toEqual([
        'timeline.founded_by_you::',
      ]);
    });

    it('never says that this account added itself', () => {
      expect(texts({ type: 'joined', epoch: 'e', by: me })).toEqual([
        'timeline.joined_by_you::',
      ]);
    });

    it('names this account apart among the members a root changed', () => {
      expect(
        texts({ ...change, by: 'alice', added: [me, 'bob'], left: [me] })
      ).toEqual([
        'timeline.joined:alice:',
        'timeline.added:alice:bob',
        'timeline.you_left::',
      ]);
    });
  });
});
