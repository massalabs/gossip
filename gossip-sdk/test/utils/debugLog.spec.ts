import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  debugLogEnabled,
  dlog,
  dtime,
  setDebugLogSink,
} from '../../src/utils/debugLog';
import { RestMessageProtocol } from '../../src/api/messageProtocol/rest';

describe('debug log', () => {
  afterEach(() => {
    setDebugLogSink(null);
    vi.unstubAllGlobals();
  });

  it('calls nothing without a sink', async () => {
    const sink = vi.fn();
    setDebugLogSink(sink);
    setDebugLogSink(null);
    expect(debugLogEnabled()).toBe(false);
    dlog('sdk', 'x.y', { a: 1 }, { c: { text: 'secret' } });
    expect(dtime('sdk', 'x.z', () => 3)).toBe(3);
    expect(await dtime('sdk', 'x.z', async () => 4)).toBe(4);
    expect(sink).not.toHaveBeenCalled();
  });

  it('never throws, even when the sink does', () => {
    setDebugLogSink(() => {
      throw new Error('broken sink');
    });
    expect(() => dlog('sdk', 'x.y')).not.toThrow();
  });

  it('keeps content and secrets apart from the fields', () => {
    const sink = vi.fn();
    setDebugLogSink(sink);
    dlog('sdk', 'x.y', { size: 2 }, { c: { text: 'hi' }, s: { key: 'k' } });
    expect(sink).toHaveBeenCalledWith({
      src: 'sdk',
      ev: 'x.y',
      lvl: 'debug',
      f: { size: 2, c: { text: 'hi' }, s: { key: 'k' } },
    });
  });

  it('writes one api.request line per backend request', async () => {
    const sink = vi.fn();
    setDebugLogSink(sink);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ counter: '7' }), { status: 200 })
      )
    );
    const api = new RestMessageProtocol('http://127.0.0.1:9', 1000, 1);
    expect(await api.fetchBulletinCounter()).toBe('7');
    expect(sink).toHaveBeenCalledTimes(1);
    const line = sink.mock.calls[0][0];
    expect(line).toMatchObject({
      src: 'api',
      ev: 'api.request',
      f: {
        method: 'GET',
        path: '/bulletin/counter',
        status: 200,
        attempt: 1,
        in: 15,
      },
    });
    expect(line.dur).toEqual(expect.any(Number));
  });
});
