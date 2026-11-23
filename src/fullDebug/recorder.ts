/**
 * The JS side of the record: events are serialised at once, kept in a buffer
 * and handed to the writer every 250 ms or 256 lines, at once on `error`.
 * Works before login and unlock: it depends on nothing but the writer.
 */
import { serializeEvent, type RecordEvent } from './serialize';

export interface RecordWriter {
  /** Lines joined by `\n`, without `n`; `urgent` asks for a sync to disk. */
  append(lines: string, urgent: boolean): Promise<void>;
  flush(): Promise<void>;
}

export interface RecorderOptions {
  writer: RecordWriter;
  flushMs?: number;
  maxLines?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export type ErrorListener = (event: RecordEvent) => void;

export class Recorder {
  private buffer: string[] = [];
  private timer: unknown = null;
  private readonly writer: RecordWriter;
  private readonly flushMs: number;
  private readonly maxLines: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private errorListeners: ErrorListener[] = [];
  private eventListeners: ErrorListener[] = [];
  /** > 0 while an error listener runs: its own errors do not call it again. */
  private inListener = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(options: RecorderOptions) {
    this.writer = options.writer;
    this.flushMs = options.flushMs ?? 250;
    this.maxLines = options.maxLines ?? 256;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  onError(listener: ErrorListener): void {
    this.errorListeners.push(listener);
  }

  /** Every event, before the error listeners (for state such as a lock). */
  onEvent(listener: ErrorListener): void {
    this.eventListeners.push(listener);
  }

  record(event: RecordEvent): void {
    try {
      this.buffer.push(serializeEvent(event));
      for (const listener of this.eventListeners) {
        try {
          listener(event);
        } catch {
          // never into the app
        }
      }
      if (event.lvl === 'error') {
        void this.flush(true);
        this.notifyError(event);
      } else if (this.buffer.length >= this.maxLines) {
        void this.flush(false);
      } else if (this.timer === null) {
        this.timer = this.setTimer(() => {
          this.timer = null;
          void this.flush(false);
        }, this.flushMs);
      }
    } catch {
      // never into the app
    }
  }

  private notifyError(event: RecordEvent): void {
    if (this.inListener > 0) return;
    this.inListener++;
    try {
      for (const listener of this.errorListeners) {
        try {
          listener(event);
        } catch {
          // a broken listener must not loop
        }
      }
    } finally {
      this.inListener--;
    }
  }

  /** Hands the buffer to the writer; `sync` also asks for a sync to disk. */
  flush(sync = false): Promise<void> {
    const lines = this.buffer;
    this.buffer = [];
    const run = async () => {
      try {
        if (lines.length > 0) await this.writer.append(lines.join('\n'), sync);
        else if (sync) await this.writer.flush();
      } catch {
        // the writer is gone: the lines are lost, the app goes on
      }
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  /** Everything recorded so far is with the writer and on disk. */
  async flushAll(): Promise<void> {
    await this.flush(false);
    try {
      await this.writer.flush();
    } catch {
      // ignore
    }
  }
}
