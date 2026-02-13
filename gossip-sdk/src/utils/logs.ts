/**
 * Logger utility for SDK
 *
 * Provides structured console logging with module and context support.
 * All output goes to the terminal via console methods.
 */

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
      console.log(main, extra);
    } else {
      console.log(main);
    }
  }

  error(messageOrError: string | Error | unknown, extra?: unknown): void {
    const source = this.getSource();

    if (messageOrError instanceof Error) {
      const main = `[${source}] ${messageOrError.message}`;
      console.error(main, messageOrError, extra);
    } else {
      const message =
        typeof messageOrError === 'string'
          ? messageOrError
          : JSON.stringify(messageOrError);
      const main = `[${source}] ${message}`;
      if (extra !== undefined) {
        console.error(main, extra);
      } else {
        console.error(main);
      }
    }
  }

  debug(message: string, extra?: unknown): void {
    const main = this.formatMainMessage(message);
    if (extra !== undefined) {
      console.debug(main, extra);
    } else {
      console.debug(main);
    }
  }

  warn(message: string, extra?: unknown): void {
    const main = this.formatMainMessage(message);
    if (extra !== undefined) {
      console.warn(main, extra);
    } else {
      console.warn(main);
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
