/**
 * Structured debug log for the full debug build.
 *
 * Inert unless a sink is installed: `dlog` returns at once when no sink is
 * set, and callers guard costly field building with `debugLogEnabled()`.
 * Release builds install no sink. Content goes under `opts.c`, secrets under
 * `opts.s`, so that both can be removed from a send without touching the rest.
 */

export type DebugLogOpts = {
  lvl?: 'debug' | 'info' | 'warn' | 'error';
  dur?: number;
  c?: Record<string, unknown>;
  s?: Record<string, unknown>;
};

type DebugLogLine = {
  src: string;
  ev: string;
  lvl: string;
  dur?: number;
  f?: Record<string, unknown>;
};

type DebugLogSink = (line: DebugLogLine) => void;

let sink: DebugLogSink | null = null;

export function setDebugLogSink(next: DebugLogSink | null): void {
  sink = next;
}

export function debugLogEnabled(): boolean {
  return sink !== null;
}

const MAX_VALUE = 64 * 1024;

function capValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && value.length > MAX_VALUE) {
      out[key] = value.slice(0, MAX_VALUE);
      out[`${key}_len`] = value.length;
    } else if (value instanceof Uint8Array && value.length > MAX_VALUE) {
      out[key] = value.subarray(0, MAX_VALUE);
      out[`${key}_len`] = value.length;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function dlog(
  src: string,
  ev: string,
  fields?: Record<string, unknown>,
  opts?: DebugLogOpts
): void {
  const current = sink;
  if (current === null) return;
  try {
    const f: Record<string, unknown> = { ...(fields ?? {}) };
    if (opts?.c) f.c = capValues(opts.c);
    if (opts?.s) f.s = capValues(opts.s);
    current({
      src,
      ev,
      lvl: opts?.lvl ?? 'debug',
      ...(opts?.dur !== undefined && { dur: opts.dur }),
      f,
    });
  } catch {
    // A debug log must never change what the caller does.
  }
}

export function dtime<T>(
  src: string,
  ev: string,
  fn: () => T | Promise<T>,
  fields?: Record<string, unknown>
): T | Promise<T> {
  if (sink === null) return fn();
  const start = performance.now();
  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (error) {
    dlog(
      src,
      ev,
      { ...fields, ...errorFields(error) },
      {
        lvl: 'error',
        dur: performance.now() - start,
      }
    );
    throw error;
  }
  if (result instanceof Promise) {
    return result.then(
      value => {
        dlog(src, ev, fields, { dur: performance.now() - start });
        return value;
      },
      (error: unknown) => {
        dlog(
          src,
          ev,
          { ...fields, ...errorFields(error) },
          {
            lvl: 'error',
            dur: performance.now() - start,
          }
        );
        throw error;
      }
    );
  }
  dlog(src, ev, fields, { dur: performance.now() - start });
  return result;
}

function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { err: error.name, msg: error.message, stack: error.stack };
  }
  return { err: typeof error, msg: String(error) };
}
