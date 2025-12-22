// utils/logs.ts

export class Logger {
  private module: string;
  private context: string;

  constructor(module: string, context: string = '') {
    this.module = module;
    this.context = context;
  }

  private formatPrefix(): string {
    return this.context ? `${this.module}:${this.context}` : this.module;
  }

  info(message: string, extra?: unknown): void {
    console.log(`[INFO] ${this.formatPrefix()}`, message);
    if (extra !== undefined) {
      console.log('   ↳', extra);
    }
  }

  error(messageOrError: string | Error | unknown, extra?: unknown): void {
    const prefix = `[ERROR] ${this.formatPrefix()}`;
    if (messageOrError instanceof Error) {
      console.error(prefix, messageOrError.message);
      if (messageOrError.stack) {
        console.error(messageOrError.stack);
      }
    } else {
      console.error(prefix, messageOrError);
    }
    if (extra !== undefined) {
      console.error('   ↳', extra);
    }
  }

  debug(message: string, extra?: unknown): void {
    console.debug(`[DEBUG] ${this.formatPrefix()}`, message);
    if (extra !== undefined) {
      console.debug('   ↳', extra);
    }
  }

  warn(message: string, extra?: unknown): void {
    console.warn(`[WARN] ${this.formatPrefix()}`, message);
    if (extra !== undefined) {
      console.warn('   ↳', extra);
    }
  }

  // NEW: Create a new logger with added context (immutable, chainable)
  withContext(newContext: string): Logger {
    const fullContext = this.context
      ? `${this.context}:${newContext}`
      : newContext;
    return new Logger(this.module, fullContext);
  }

  // Optional: shortcut for method-scoped logging
  forMethod(methodName: string): Logger {
    return this.withContext(methodName);
  }
}
