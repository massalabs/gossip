/* These type declaration where initialiy in useDebugLogs.tsx file. We moved them in a specific file to avoid the lint warning:
"warning  Fast refresh only works when a file only exports components. Use a new file to share constants or functions between components  
react-refresh/only-export-components"
*/
export const LOG_LIMIT_OPTIONS = [20, 50, 100, 200, 500] as const;
export type LogLimit = (typeof LOG_LIMIT_OPTIONS)[number];
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ErrorLogData {
  name: string;
  message: string;
  stack?: string;
  args: unknown[];
}

export type LogData =
  | ErrorLogData
  | string
  | undefined
  | Record<string, unknown>
  | unknown[];

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  msg: string;
  data?: LogData;
  repeatCount?: number; // Number of times this log was repeated consecutively
}
