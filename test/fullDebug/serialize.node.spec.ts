import { describe, expect, it } from 'vitest';
import {
  logCallToEvent,
  serializeEvent,
  stripLine,
  toJsonValue,
  MAX_BYTES_HEX,
} from '../../src/fullDebug/serialize';
import { dlog, dtime, setDebugLogSink } from '../../gossip-sdk/src/utils/debugLog';

describe('full debug line serialiser', () => {
  it('writes the fields of the line format', () => {
    const line = JSON.parse(
      serializeEvent({ src: 'engine', ev: 'x.y', lvl: 'debug', dur: 3, f: { a: 1 } })
    );
    expect(line).toMatchObject({ src: 'engine', ev: 'x.y', lvl: 'debug', dur: 3, f: { a: 1 } });
    expect(typeof line.t).toBe('number');
    expect(typeof line.up).toBe('number');
    expect(line.n).toBeUndefined();
  });

  it('never throws on odd inputs', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const hostile = {
      get boom() {
        throw new Error('getter');
      },
    };
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('keys');
        },
      }
    );
    const err = new Error('bad', { cause: new TypeError('inner') });
    const odd: unknown[] = [
      circular,
      hostile,
      proxy,
      err,
      10n,
      Symbol('s'),
      () => 1,
      undefined,
      NaN,
      Infinity,
      new Date('invalid'),
      new Map([[1, { b: 2 }]]),
      new Set([1, 2]),
      new Uint8Array([1, 2, 255]),
      new ArrayBuffer(4),
      'x'.repeat(300_000),
    ];
    for (const value of odd) {
      const s = serializeEvent({ src: 'app', ev: 'log', lvl: 'info', f: { value } });
      expect(() => JSON.parse(s)).not.toThrow();
    }
    const c = JSON.parse(serializeEvent({ src: 'app', ev: 'log', lvl: 'info', f: { circular } }));
    expect(c.f.circular.self).toBe('[circular]');
    const e = toJsonValue(err) as Record<string, unknown>;
    expect(e.name).toBe('Error');
    expect(e.message).toBe('bad');
    expect(typeof e.stack).toBe('string');
    expect((e.cause as Record<string, unknown>).name).toBe('TypeError');
  });

  it('writes bytes as hex, capped, with the real length', () => {
    expect(toJsonValue(new Uint8Array([0, 15, 255]))).toEqual({ hex: '000fff', length: 3 });
    const big = toJsonValue(new Uint8Array(MAX_BYTES_HEX + 10)) as {
      hex: string;
      length: number;
      cut: boolean;
    };
    expect(big.hex.length).toBe(MAX_BYTES_HEX * 2);
    expect(big.length).toBe(MAX_BYTES_HEX + 10);
    expect(big.cut).toBe(true);
  });

  it('keeps a value seen twice (not a cycle)', () => {
    const shared = { x: 1 };
    expect(toJsonValue({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it('maps an existing logger call to ev:"log"', () => {
    const ev = logCallToEvent('error', ['[GossipSdk] failed', new Error('e'), 3]);
    expect(ev).toMatchObject({ src: 'sdk', ev: 'log', lvl: 'error', f: { msg: '[GossipSdk] failed' } });
    expect((ev.f.args as unknown[]).length).toBe(2);
    expect(logCallToEvent('info', ['plain']).src).toBe('app');
    expect(logCallToEvent('info', [new Error('only')]).f.msg).toBe('only');
  });
});

describe('strip of content and secrets', () => {
  it('removes f.c and f.s and keeps the rest', () => {
    const line = '{"n":1,"src":"a","ev":"b","f":{"id":"x","c":{"text":"hi"},"s":{"key":"k"}}}';
    expect(JSON.parse(stripLine(line))).toEqual({ n: 1, src: 'a', ev: 'b', f: { id: 'x' } });
  });
  it('leaves other lines unchanged, and lines that do not parse', () => {
    const plain = '{"n":2,"f":{"msg":"\\"c\\": not a field"}}';
    expect(stripLine('{"n":2,"f":{"a":1}}')).toBe('{"n":2,"f":{"a":1}}');
    expect(stripLine(plain)).toBe(plain);
    expect(stripLine('{"c": broken')).toBe('{"c": broken');
  });
});

describe('dlog / dtime', () => {
  it('do nothing without a sink and record with one', async () => {
    setDebugLogSink(null);
    dlog('app', 'x');
    expect(dtime('app', 'y', () => 5)).toBe(5);
    const seen: unknown[] = [];
    setDebugLogSink(e => seen.push(e));
    dlog('sdk', 'ev', { a: 1 }, { lvl: 'warn', c: { text: 't' }, s: { key: 'k' } });
    expect(seen[0]).toEqual({ src: 'sdk', ev: 'ev', lvl: 'warn', f: { a: 1, c: { text: 't' }, s: { key: 'k' } } });
    await expect(dtime('a', 'b', async () => 7)).resolves.toBe(7);
    await expect(
      dtime('a', 'c', async () => {
        throw new Error('no');
      })
    ).rejects.toThrow('no');
    expect(seen.length).toBe(3);
    expect((seen[2] as { lvl: string; f: { outcome: string } }).f.outcome).toBe('error');
    setDebugLogSink(() => {
      throw new Error('sink broken');
    });
    expect(() => dlog('a', 'b')).not.toThrow();
    setDebugLogSink(null);
  });
});
