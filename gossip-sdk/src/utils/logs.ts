/**
 * Shared logger utility for app + SDK runtime code.
 *
 * Production safety rule: logs are emitted only through configured sinks.
 * Release builds configure no sinks, so logging calls are inert without
 * relying on minifier console stripping.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogSink = (
  level: LogLevel,
  message: unknown,
  args: readonly unknown[]
) => void;

export interface LoggerConfig {
  enabled: boolean;
  minLevel: LogLevel;
  persist: boolean;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_CONFIG: LoggerConfig = {
  enabled: false,
  minLevel: 'error',
  persist: false,
};

let config: LoggerConfig = { ...DEFAULT_CONFIG };
let sinks: LogSink[] = [];

function shouldLog(level: LogLevel): boolean {
  return config.enabled && LEVEL_RANK[level] >= LEVEL_RANK[config.minLevel];
}

function emit(level: LogLevel, args: readonly unknown[]): void {
  if (!shouldLog(level)) return;

  const message = args[0];
  for (const sink of sinks) {
    sink(level, message, args);
  }
}

export function configureLogging(next: Partial<LoggerConfig>): void {
  config = { ...config, ...next };
}

export function getLoggingConfig(): LoggerConfig {
  return { ...config };
}

export function setLogSinks(nextSinks: LogSink[]): void {
  sinks = [...nextSinks];
}

export function addLogSink(sink: LogSink): void {
  sinks = [...sinks, sink];
}

export function resetLoggingForTests(): void {
  config = { ...DEFAULT_CONFIG };
  sinks = [];
}

export const logger = {
  debug: (...args: unknown[]): void => emit('debug', args),
  info: (...args: unknown[]): void => emit('info', args),
  warn: (...args: unknown[]): void => emit('warn', args),
  error: (...args: unknown[]): void => emit('error', args),
  child: (scope: string): Logger => new Logger(scope),
};

export class Logger {
  private module: string;
  private context: string;

  constructor(module: string, context: string = '') {
    this.module = module;
    this.context = context;
  }

  private getSource(): string {
    return this.context ? `${this.module}:${this.context}` : this.module;
  }

  private formatMainMessage(message: string): string {
    const source = this.getSource();
    return `[${source}] ${message}`;
  }

  info(message: string, extra?: unknown): void {
    const main = this.formatMainMessage(message);
    if (extra !== undefined) {
      logger.info(main, extra);
    } else {
      logger.info(main);
    }
  }

  error(messageOrError: string | Error | unknown, extra?: unknown): void {
    const source = this.getSource();

    if (messageOrError instanceof Error) {
      const main = `[${source}] ${messageOrError.message}`;
      logger.error(main, messageOrError, extra);
    } else {
      const message =
        typeof messageOrError === 'string'
          ? messageOrError
          : JSON.stringify(messageOrError);
      const main = `[${source}] ${message}`;
      if (extra !== undefined) {
        logger.error(main, extra);
      } else {
        logger.error(main);
      }
    }
  }

  debug(message: string, extra?: unknown): void {
    const main = this.formatMainMessage(message);
    if (extra !== undefined) {
      logger.debug(main, extra);
    } else {
      logger.debug(main);
    }
  }

  warn(message: string, extra?: unknown): void {
    const main = this.formatMainMessage(message);
    if (extra !== undefined) {
      logger.warn(main, extra);
    } else {
      logger.warn(main);
    }
  }

  // Chainable context builder
  withContext(newContext: string): Logger {
    const fullContext = this.context
      ? `${this.context}:${newContext}`
      : newContext;
    return new Logger(this.module, fullContext);
  }

  forMethod(methodName: string): Logger {
    return this.withContext(methodName);
  }
}
