/**
 * The group engine's debug events reach the debug log only in the full debug
 * build: there the wasm bundle has `GroupsNode.set_debug_sink` and a debug
 * sink is installed. The normal bundle has no such method.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GroupsNode } from '../../src/wasm/bindings';
import { installEngineDebugSink } from '../../src/services/groups';
import { setDebugLogSink, type DebugLogEvent } from '../../src/utils/debugLog';

type Setter = (cb: ((json: string) => void) | null) => void;
const node = GroupsNode as unknown as { set_debug_sink?: Setter };

afterEach(() => {
  delete node.set_debug_sink;
  setDebugLogSink(null);
});

describe('installEngineDebugSink', () => {
  it('the normal bundle has no debug sink, and nothing breaks', () => {
    expect(typeof node.set_debug_sink).toBe('undefined');
    setDebugLogSink(() => {});
    expect(() => installEngineDebugSink()).not.toThrow();
  });

  it('installs nothing without a debug log', () => {
    let installed = false;
    node.set_debug_sink = () => {
      installed = true;
    };
    installEngineDebugSink();
    expect(installed).toBe(false);
  });

  it('forwards each engine event to the debug log', () => {
    let cb: ((json: string) => void) | null = null;
    node.set_debug_sink = next => {
      cb = next;
    };
    const seen: DebugLogEvent[] = [];
    setDebugLogSink(e => seen.push(e));
    installEngineDebugSink();
    expect(cb).not.toBeNull();
    cb!(
      JSON.stringify({
        ev: 'engine.event.in',
        lvl: 'warn',
        f: { type: 'plaintext', verdict: 'malformed' },
        c: { raw: '001337' },
      })
    );
    cb!('not json');
    expect(seen).toEqual([
      {
        src: 'engine',
        ev: 'engine.event.in',
        lvl: 'warn',
        f: { type: 'plaintext', verdict: 'malformed', c: { raw: '001337' } },
      },
    ]);
  });
});
