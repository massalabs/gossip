import { describe, expect, it } from 'vitest';
import { PromptGate, StorageLockWindow } from '../../src/fullDebug/promptGate';
import { Recorder, type RecordWriter } from '../../src/fullDebug/recorder';

describe('error pop-up gate', () => {
  it('opens at most once a minute and never while open', () => {
    let now = 0;
    const gate = new PromptGate(() => now, 60_000);
    expect(gate.request()).toBe(true);
    expect(gate.request()).toBe(false); // open
    gate.close();
    now = 30_000;
    expect(gate.request()).toBe(false); // too soon
    now = 61_000;
    expect(gate.request()).toBe(true);
    gate.close(true); // don't ask again this session
    now = 1_000_000;
    expect(gate.request()).toBe(false);
  });
});

describe('recorder', () => {
  function writer() {
    const appended: { lines: string; urgent: boolean }[] = [];
    const w: RecordWriter = {
      append: async (lines, urgent) => {
        appended.push({ lines, urgent });
      },
      flush: async () => {},
    };
    return { w, appended };
  }

  it('batches by count and flushes at once on error', async () => {
    const { w, appended } = writer();
    const timers: (() => void)[] = [];
    const r = new Recorder({
      writer: w,
      maxLines: 3,
      setTimer: fn => timers.push(fn),
    });
    r.record({ src: 'app', ev: 'a', lvl: 'debug', f: {} });
    r.record({ src: 'app', ev: 'b', lvl: 'debug', f: {} });
    expect(appended.length).toBe(0);
    r.record({ src: 'app', ev: 'c', lvl: 'debug', f: {} });
    await r.flush();
    expect(appended[0].lines.split('\n').length).toBe(3);
    r.record({ src: 'app', ev: 'e', lvl: 'error', f: {} });
    await r.flush();
    expect(appended.at(-1)?.urgent).toBe(true);
    r.record({ src: 'app', ev: 'f', lvl: 'info', f: {} });
    timers.forEach(t => t());
    await r.flush();
    expect(appended.at(-1)?.lines).toContain('"ev":"f"');
  });

  it('does not re-enter the error listener from its own errors', () => {
    const { w } = writer();
    const r = new Recorder({ writer: w, setTimer: () => 0 });
    let calls = 0;
    r.onError(() => {
      calls++;
      // an error raised while handling an error
      r.record({ src: 'ui', ev: 'inner', lvl: 'error', f: {} });
      throw new Error('listener broken');
    });
    expect(() =>
      r.record({ src: 'app', ev: 'x', lvl: 'error', f: {} })
    ).not.toThrow();
    expect(calls).toBe(1);
    r.record({ src: 'app', ev: 'y', lvl: 'error', f: {} });
    expect(calls).toBe(2);
  });

  it('survives a broken writer', async () => {
    const r = new Recorder({
      writer: {
        append: async () => {
          throw new Error('disk gone');
        },
        flush: async () => {
          throw new Error('disk gone');
        },
      },
      setTimer: () => 0,
    });
    r.record({ src: 'app', ev: 'x', lvl: 'error', f: {} });
    await expect(r.flushAll()).resolves.toBeUndefined();
  });
});

describe('storage-lock window of the pop-up', () => {
  function setup() {
    let now = 0;
    const timers: { at: number; fn: () => void; live: boolean }[] = [];
    const w = new StorageLockWindow(
      () => now,
      (fn, ms) => {
        const t = { at: now + ms, fn, live: true };
        timers.push(t);
        return t;
      },
      t => {
        if (t) (t as { live: boolean }).live = false;
      }
    );
    const advance = (to: number) => {
      now = to;
      for (const t of timers) {
        if (t.live && t.at <= now) {
          t.live = false;
          t.fn();
        }
      }
    };
    const counts = { prompts: 0, suppressed: 0 };
    const error = () =>
      w.check(
        () => counts.prompts++,
        () => counts.suppressed++
      );
    return { w, advance, error, counts };
  }
  const lock = { src: 'storage', ev: 'storage.lock', f: {} };
  const unlock = { src: 'storage', ev: 'storage.unlock', f: { ok: true } };

  it('suppresses errors between lock and unlock, and up to 2 s after', () => {
    const s = setup();
    s.advance(1000);
    s.w.observe(lock);
    s.advance(1200);
    s.error();
    s.error();
    s.advance(1400);
    s.w.observe(unlock);
    s.advance(3000);
    s.error();
    s.advance(40_000);
    expect(s.counts).toEqual({ prompts: 0, suppressed: 3 });
  });

  it('suppresses an error just before the lock (the groups close first)', () => {
    const s = setup();
    s.advance(1000);
    s.error();
    s.advance(1046);
    s.w.observe(lock);
    s.advance(1500);
    s.w.observe(unlock);
    s.advance(5000);
    expect(s.counts).toEqual({ prompts: 0, suppressed: 1 });
  });

  it('does not suppress before the lock', () => {
    const s = setup();
    s.advance(500);
    s.error();
    s.advance(800);
    expect(s.counts.prompts).toBe(1);
    s.w.observe(lock);
    expect(s.counts).toEqual({ prompts: 1, suppressed: 0 });
  });

  it('does not suppress more than 2 s after the unlock', () => {
    const s = setup();
    s.w.observe(lock);
    s.advance(100);
    s.w.observe({ src: 'storage', ev: 'storage.open', f: { native: true } });
    s.advance(2101);
    s.error();
    s.advance(2400);
    expect(s.counts).toEqual({ prompts: 1, suppressed: 0 });
  });

  it('a failed unlock does not end the lock', () => {
    const s = setup();
    s.w.observe(lock);
    s.w.observe({ src: 'storage', ev: 'storage.unlock', f: { ok: false } });
    s.advance(10);
    s.error();
    s.advance(29_000);
    expect(s.counts.prompts).toBe(0);
  });

  it('prompts when no unlock follows within 30 s', () => {
    const s = setup();
    s.w.observe(lock);
    s.advance(5000);
    s.error();
    s.advance(29_999);
    expect(s.counts.prompts).toBe(0);
    s.advance(30_000);
    expect(s.counts.prompts).toBe(1);
    s.advance(31_000);
    s.error();
    expect(s.counts.prompts).toBe(2);
  });
});
