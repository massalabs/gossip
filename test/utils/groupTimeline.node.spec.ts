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
        owner: 'o',
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
});
