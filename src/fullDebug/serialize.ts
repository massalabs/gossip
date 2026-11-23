/**
 * Line format of the full debug record (one JSON object per line):
 * `{"t":..,"up":..,"src":..,"ev":..,"lvl":..,"dur":..,"f":{..}}`. The
 * writer (native, or the in-memory one on the web) puts `"n":<counter>` in
 * front. Nothing here may throw.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface RecordEvent {
  src: string;
  ev: string;
  lvl: Level;
  dur?: number;
  f: Record<string, unknown>;
}

/** Bytes are written as hex, at most this many bytes (the real length is kept). */
export const MAX_BYTES_HEX = 4096;
/** A string longer than this is cut (the real length is kept). */
export const MAX_STRING = 256 * 1024;
const MAX_DEPTH = 12;
const MAX_KEYS = 2000;

function hex(bytes: Uint8Array): string {
  let s = '';
  const n = Math.min(bytes.length, MAX_BYTES_HEX);
  for (let i = 0; i < n; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function errorValue(
  e: Error,
  seen: WeakSet<object>,
  depth: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: safeString(() => e.name),
    message: safeString(() => e.message),
    stack: safeString(() => e.stack ?? ''),
  };
  try {
    const cause = (e as { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = toJsonValue(cause, seen, depth + 1);
    for (const key of Object.keys(e)) {
      if (key in out) continue;
      out[key] = toJsonValue(
        (e as unknown as Record<string, unknown>)[key],
        seen,
        depth + 1
      );
    }
  } catch {
    // keep what we have
  }
  return out;
}

function safeString(get: () => unknown): string {
  try {
    const v = get();
    return typeof v === 'string' ? v : String(v);
  } catch {
    return '[unreadable]';
  }
}

/**
 * A JSON-safe copy of any value: Errors become name/message/stack, bytes
 * become hex (capped), cycles become "[circular]", BigInt a string, functions
 * and symbols a short description. Never throws.
 */
export function toJsonValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0
): unknown {
  try {
    if (value === null) return null;
    switch (typeof value) {
      case 'string':
        return value.length > MAX_STRING
          ? { cut: value.slice(0, MAX_STRING), length: value.length }
          : value;
      case 'number':
        return Number.isFinite(value) ? value : String(value);
      case 'boolean':
        return value;
      case 'undefined':
        return '[undefined]';
      case 'bigint':
        return `${value.toString()}n`;
      case 'symbol':
        return value.toString();
      case 'function':
        return `[function ${(value as { name?: string }).name || 'anonymous'}]`;
    }
    const obj = value as object;
    if (seen.has(obj)) return '[circular]';
    if (depth >= MAX_DEPTH) return '[too deep]';
    seen.add(obj);
    try {
      if (obj instanceof Error) return errorValue(obj, seen, depth);
      if (obj instanceof Uint8Array) {
        return obj.length > MAX_BYTES_HEX
          ? { hex: hex(obj), length: obj.length, cut: true }
          : { hex: hex(obj), length: obj.length };
      }
      if (obj instanceof ArrayBuffer) {
        return toJsonValue(new Uint8Array(obj), seen, depth + 1);
      }
      if (ArrayBuffer.isView(obj)) {
        const view = obj as ArrayBufferView;
        return toJsonValue(
          new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
          seen,
          depth + 1
        );
      }
      if (obj instanceof Date) {
        return Number.isNaN(obj.getTime())
          ? '[invalid date]'
          : obj.toISOString();
      }
      if (obj instanceof Map) {
        const out: unknown[] = [];
        let i = 0;
        for (const [k, v] of obj) {
          if (i++ >= MAX_KEYS) break;
          out.push([
            toJsonValue(k, seen, depth + 1),
            toJsonValue(v, seen, depth + 1),
          ]);
        }
        return { map: out, size: obj.size };
      }
      if (obj instanceof Set) {
        const out: unknown[] = [];
        let i = 0;
        for (const v of obj) {
          if (i++ >= MAX_KEYS) break;
          out.push(toJsonValue(v, seen, depth + 1));
        }
        return { set: out, size: obj.size };
      }
      if (Array.isArray(obj)) {
        const n = Math.min(obj.length, MAX_KEYS);
        const out: unknown[] = new Array(n);
        for (let i = 0; i < n; i++)
          out[i] = toJsonValue(obj[i], seen, depth + 1);
        if (obj.length > n) out.push(`[${obj.length - n} more]`);
        return out;
      }
      if (typeof Event !== 'undefined' && obj instanceof Event) {
        return { event: obj.type };
      }
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const key of Object.keys(obj)) {
        if (count++ >= MAX_KEYS) {
          out['[more]'] = true;
          break;
        }
        let v: unknown;
        try {
          v = (obj as Record<string, unknown>)[key];
        } catch {
          v = '[unreadable]';
        }
        out[key] = toJsonValue(v, seen, depth + 1);
      }
      return out;
    } finally {
      // A value seen twice on different branches is not a cycle.
      seen.delete(obj);
    }
  } catch {
    return '[unserializable]';
  }
}

function now(): number {
  return Date.now();
}

function uptime(): number {
  try {
    return Math.round(performance.now());
  } catch {
    return 0;
  }
}

/** One line (without `n`), never throws. */
export function serializeEvent(event: RecordEvent): string {
  try {
    const line: Record<string, unknown> = {
      t: now(),
      up: uptime(),
      src: String(event.src),
      ev: String(event.ev),
      lvl: event.lvl,
    };
    if (typeof event.dur === 'number' && Number.isFinite(event.dur)) {
      line.dur = event.dur;
    }
    line.f = toJsonValue(event.f);
    return JSON.stringify(line);
  } catch {
    try {
      return JSON.stringify({
        t: now(),
        up: uptime(),
        src: 'app',
        ev: 'log.unserializable',
        lvl: 'warn',
        f: {},
      });
    } catch {
      return '{"src":"app","ev":"log.unserializable","lvl":"warn","f":{}}';
    }
  }
}

/** Which source a call of the existing logger comes from. */
export function sourceOfMessage(message: unknown): 'app' | 'sdk' {
  if (typeof message !== 'string') return 'app';
  // The SDK's Logger instances prefix `[XxxService]` (gossip-sdk/src); the
  // shared logger cannot tell more, so anything else counts as the app.
  return /^\[(?:\w*Service|SeekerConflicts|GossipSdk|SdkPolling|SecureStorage|SDK)[\]:]/.test(
    message
  )
    ? 'sdk'
    : 'app';
}

/** A call of the existing logger as an event: `ev:"log"`, `f:{msg,args}`. */
export function logCallToEvent(
  level: Level,
  args: readonly unknown[],
  src?: string
): RecordEvent {
  let msg: unknown = args[0];
  let rest = args.slice(1);
  if (typeof msg !== 'string') {
    rest = args.slice();
    msg =
      msg instanceof Error
        ? `${safeString(() => msg && (msg as Error).message)}`
        : '';
  }
  const f: Record<string, unknown> = { msg };
  if (rest.length > 0) f.args = rest;
  return { src: src ?? sourceOfMessage(args[0]), ev: 'log', lvl: level, f };
}

/** Removes the content (`f.c`) and secrets (`f.s`) of a line. */
export function stripLine(line: string): string {
  if (!line.includes('"c":') && !line.includes('"s":')) return line;
  try {
    const o = JSON.parse(line) as { f?: unknown };
    if (!o || typeof o !== 'object' || !o.f || typeof o.f !== 'object') {
      return line;
    }
    const f = o.f as Record<string, unknown>;
    if (!('c' in f) && !('s' in f)) return line;
    delete f.c;
    delete f.s;
    return JSON.stringify(o);
  } catch {
    return line;
  }
}
