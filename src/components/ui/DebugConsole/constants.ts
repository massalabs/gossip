import { LogLevel } from '../../../stores/useDebugLogs';

export const levelColor: Record<LogLevel, string> = {
  debug: 'var(--color-muted-foreground)',
  info: 'var(--color-primary)',
  warn: 'var(--color-secondary)',
  error: 'var(--color-destructive)',
};

export const levelBg: Record<LogLevel, string> = {
  debug: 'bg-muted',
  info: 'bg-primary/5',
  warn: 'bg-secondary/10',
  error: 'bg-destructive/10',
};

export type LogLevelFilter = 'all' | 'debug' | 'info' | 'warn' | 'error';
