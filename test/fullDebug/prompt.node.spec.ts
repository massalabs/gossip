import { describe, expect, it } from 'vitest';
import { PromptGate } from '../../src/fullDebug/promptGate';
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
    const r = new Recorder({ writer: w, maxLines: 3, setTimer: fn => timers.push(fn) });
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
    expect(() => r.record({ src: 'app', ev: 'x', lvl: 'error', f: {} })).not.toThrow();
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
