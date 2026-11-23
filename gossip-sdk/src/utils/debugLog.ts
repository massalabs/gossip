/**
 * Structured debug events for the full debug build of the app.
 *
 * `dlog` and `dtime` do nothing until the app installs a sink with
 * `setDebugLogSink`, which only the full debug build does. A normal build
 * installs none, so a call costs one null check and writes nothing.
 *
 * Fields: `fields` are the event's plain fields; `opts.c` holds content
 * (message text, names, raw bytes, request bodies) and `opts.s` secrets
 * (keys, seeds, passwords). They are kept apart (`f.c`, `f.s`) so that a send
 * can remove them without touching the rest.
 */

export type DebugLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DebugLogOptions {
  lvl?: DebugLogLevel;
  /** Duration in ms, when the event ends an operation. */
  dur?: number;
  /** Content: message text, names, raw bytes, full IDs, request bodies. */
  c?: Record<string, unknown>;
  /** Secrets: keys, seeds, passwords, ratchet state. */
  s?: Record<string, unknown>;
}

export interface DebugLogEvent {
  src: string;
  ev: string;
  lvl: DebugLogLevel;
  dur?: number;
  f: Record<string, unknown>;
}

export type DebugLogSink = (event: DebugLogEvent) => void;

let sink: DebugLogSink | null = null;

/** Installs (or removes, with null) the sink of structured events. */
export function setDebugLogSink(next: DebugLogSink | null): void {
  sink = next;
}

/** True when a sink is installed: lets a caller skip building costly fields. */
export function isDebugLogEnabled(): boolean {
  return sink !== null;
}

function nowMs(): number {
  return typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Records one structured event. Never throws. */
export function dlog(
  src: string,
  ev: string,
  fields?: Record<string, unknown>,
  opts?: DebugLogOptions
): void {
  const target = sink;
  if (target === null) return;
  try {
    const f: Record<string, unknown> = fields ? { ...fields } : {};
    if (opts?.c !== undefined) f.c = opts.c;
    if (opts?.s !== undefined) f.s = opts.s;
    const event: DebugLogEvent = { src, ev, lvl: opts?.lvl ?? 'debug', f };
    if (opts?.dur !== undefined) event.dur = opts.dur;
    target(event);
  } catch {
    // A debug record must never break the app.
  }
}

/**
 * Runs `fn` and records its duration and outcome (`ok`, or `error` with the
 * error), then returns or rethrows exactly what `fn` did. Without a sink it
 * only calls `fn`.
 */
export function dtime<T>(
  src: string,
  ev: string,
  fn: () => T | Promise<T>,
  fields?: Record<string, unknown>
): T | Promise<T> {
  if (sink === null) return fn();
  const start = nowMs();
  const done = (outcome: 'ok' | 'error', error?: unknown): void => {
    const dur = Math.round((nowMs() - start) * 1000) / 1000;
    dlog(
      src,
      ev,
      outcome === 'ok'
        ? { ...fields, outcome }
        : { ...fields, outcome, error },
      { lvl: outcome === 'ok' ? 'debug' : 'error', dur }
    );
  };
  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (error) {
    done('error', error);
    throw error;
  }
  if (
    result !== null &&
    typeof result === 'object' &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    return (result as Promise<T>).then(
      value => {
        done('ok');
        return value;
      },
      (error: unknown) => {
        done('error', error);
        throw error;
      }
    );
  }
  done('ok');
  return result;
}
