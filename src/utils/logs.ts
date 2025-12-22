export class Logger {
  constructor(private module: string) {}

  info(functionName: string, message: string): void {
    console.log(`[INFO] ${this.module}: ${functionName}`, message);
  }

  error(functionName: string, error: unknown): void {
    if (error instanceof Error) {
      console.error(`[ERROR] ${this.module}: ${functionName}`, error.message);
    } else {
      console.error(`[ERROR] ${this.module}: ${functionName}`, error);
    }
  }

  debug(functionName: string, message: string): void {
    console.debug(`[DEBUG] ${this.module}: ${functionName}`, message);
  }

  warn(functionName: string, message: string): void {
    console.warn(`[WARN] ${this.module}: ${functionName}`, message);
  }
}
