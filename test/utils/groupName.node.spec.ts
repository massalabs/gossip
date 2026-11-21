import { describe, expect, it } from 'vitest';
import { groupDisplayName, safeName } from '../../src/utils/groupName';

describe('safeName (§5.11)', () => {
  it('turns controls and separators into one line', () => {
    expect(safeName('a\nb c\td\u0085e')).toBe('a b c d e');
  });

  it('removes direction controls', () => {
    expect(safeName('abc‮dcba⁦x‏y؜')).toBe('abcdcbaxy');
  });

  it('removes invisible characters and trims', () => {
    expect(safeName('​ ﻿name⁠ ')).toBe('name');
    expect(safeName('​‍﻿')).toBe('');
  });

  it('keeps a joiner inside an emoji sequence and drops a stray one', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(safeName(family)).toBe(family);
    expect(safeName('a‍')).toBe('a');
  });

  it('normalises to NFC', () => {
    expect(safeName('é')).toBe('é');
  });

  it('shortens by grapheme cluster with an ellipsis', () => {
    const flag = '\u{1F1EB}\u{1F1F7}';
    expect(safeName(flag.repeat(5), 3)).toBe(`${flag.repeat(3)}…`);
  });

  it('limits stacked combining marks', () => {
    const zalgo = 'a' + '́̂̃̄̅̆';
    expect(Array.from(safeName(zalgo)).length).toBeLessThanOrEqual(4);
  });

  it('builds a name from the members when the name is empty', () => {
    const name = groupDisplayName(
      { name: ' ​', localName: null, members: ['me', 'a', 'b'] },
      id => id.toUpperCase(),
      'me'
    );
    expect(name).toBe('A, B');
    expect(
      groupDisplayName(
        { name: 'Official', localName: 'Mine', members: [] },
        id => id
      )
    ).toBe('Mine');
  });

  it('falls back when no name is set and no one else is left', () => {
    // A direct chat the other person declined or left.
    expect(
      groupDisplayName(
        { name: '', localName: null, members: ['me'] },
        id => id,
        'me',
        'Unnamed group'
      )
    ).toBe('Unnamed group');
  });
});
