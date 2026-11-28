import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recentSends,
  rememberSend,
  uploadRef,
} from '../../src/fullDebug/sentRefs';

describe('send references', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is the upload path on the backend: <install>/<upload>', () => {
    expect(uploadRef('GX0O7RdgWLtfxflcfAEUmA', '8f3ee592a91eabe9')).toBe(
      'GX0O7RdgWLtfxflcfAEUmA/8f3ee592a91eabe9'
    );
  });

  it('keeps the last five, newest first', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    for (let i = 1; i <= 7; i++) rememberSend(`i/u${i}`, new Date(i * 1000));
    expect(recentSends().map(s => s.ref)).toEqual([
      'i/u7',
      'i/u6',
      'i/u5',
      'i/u4',
      'i/u3',
    ]);
  });

  it('survives a storage that throws or holds junk', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => '{"not":"a list"}',
      setItem: () => {
        throw new Error('full');
      },
    });
    expect(recentSends()).toEqual([]);
    expect(() => rememberSend('a/b')).not.toThrow();
  });
});
