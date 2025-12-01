import { createTimestamp } from '../../utils/timeUtils';

export interface DebugLog {
  timestamp: string;
  message: string;
}

let debugLogs: DebugLog[] = [];
let logListeners: Array<() => void> = [];
let consoleForwardingEnabled = false;
let isAddingLog = false; // Guard to prevent infinite loops
const logLimit = 40;

export const addDebugLog = (message: string): void => {
  // Prevent re-entrant calls that could cause infinite loops
  if (isAddingLog) return;
  isAddingLog = true;

  try {
    const timestamp = createTimestamp();
    debugLogs.push({ timestamp, message });
    if (debugLogs.length > logLimit) {
      debugLogs = debugLogs.slice(-logLimit);
    }
    logListeners.forEach(listener => listener());
  } finally {
    isAddingLog = false;
  }
};

export const getDebugLogs = (): DebugLog[] => debugLogs;

export const addLogsListener = (listener: () => void): void => {
  logListeners.push(listener);
};

export const removeLogsListener = (listener: () => void): void => {
  logListeners = logListeners.filter(l => l !== listener);
};

export const clearDebugLogs = (): void => {
  debugLogs = [];
  logListeners.forEach(listener => listener());
};

/**
 * Opt-in helper to forward console logs into the in-memory debug log buffer.
 *
 * This keeps the original console behavior but also records messages so they
 * can be surfaced in a debug UI.
 *
 * Call once from app startup (e.g. in a top-level provider or main entry).
 */
export const enableConsoleDebugForwarding = (): void => {
  if (consoleForwardingEnabled) return;
  consoleForwardingEnabled = true;

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const originalInfo = console.info.bind(console);

  console.log = (...args: unknown[]) => {
    originalLog(...args);
    addDebugLog(`[log] ${args.map(String).join(' ')}`);
  };

  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    addDebugLog(`[warn] ${args.map(String).join(' ')}`);
  };

  console.error = (...args: unknown[]) => {
    originalError(...args);
    addDebugLog(`[error] ${args.map(String).join(' ')}`);
  };

  console.info = (...args: unknown[]) => {
    originalInfo(...args);
    addDebugLog(`[info] ${args.map(String).join(' ')}`);
  };
};
