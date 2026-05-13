import {
  configureLogging,
  getLoggingConfig,
  logger,
  setLogSinks,
  type LogLevel,
  type LogSink,
} from '@massalabs/gossip-sdk/utils/logs.js';
import { useDebugLogs } from '../stores/useDebugLogs';

const isDebugLoggingEnabled =
  import.meta.env.DEV || import.meta.env.VITE_DEBUG_LOGS === 'true';

const browserConsoleSink: LogSink = (level, _message, args) => {
  if (level === 'debug') {
    console.debug(...args);
  } else if (level === 'info') {
    console.info(...args);
  } else if (level === 'warn') {
    console.warn(...args);
  } else {
    console.error(...args);
  }
};

const debugStoreSink: LogSink = (level, message, args) => {
  if (!getLoggingConfig().persist) return;
  useDebugLogs.getState().add(level, message, [...args]);
};

export function configureAppLogging(): void {
  configureLogging({
    enabled: isDebugLoggingEnabled,
    minLevel: 'debug',
    persist: isDebugLoggingEnabled,
  });

  setLogSinks(
    isDebugLoggingEnabled ? [browserConsoleSink, debugStoreSink] : []
  );
}

export { logger };
export type { LogLevel, LogSink };
