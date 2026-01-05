import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { toast } from 'react-hot-toast';
import {
  LOG_LIMIT_OPTIONS,
  type LogLimit,
  type LogLevel,
  type ErrorLogData,
  type LogData,
  type LogEntry,
} from './useDebugLogs.types';

const LOG_STORAGE_KEY = 'debug-logs';
const LOG_STORAGE_VERSION = 1;
const LOG_STORAGE_KEY_PREFIX = `${LOG_STORAGE_KEY}-v${LOG_STORAGE_VERSION}`;
const DEFAULT_LOG_STORAGE_LIMIT: LogLimit = 200;

interface DebugStore {
  logs: LogEntry[];
  logLimit: LogLimit;
  add: (level: LogLevel, message: unknown, data?: LogData) => void;
  clear: () => void;
  share: () => Promise<void>;
  showDebugConsole: boolean;
  setShowDebugConsole: (show: boolean) => void;
  setLogLimit: (limit: LogLimit) => void;
}

let idCounter = Date.now();

/**
 * Deep equality comparison for LogData.
 */
function isLogDataEqual(
  a: LogData | undefined,
  b: LogData | undefined
): boolean {
  // Both undefined/null
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;

  // Both strings
  if (typeof a === 'string' && typeof b === 'string') return a === b;

  // Both arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => {
      const bItem = b[index];
      // For arrays, do a simple comparison (can be extended if needed)
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof bItem === 'object' &&
        bItem !== null
      ) {
        return JSON.stringify(item) === JSON.stringify(bItem);
      }
      return item === bItem;
    });
  }

  // Both objects (including ErrorLogData)
  if (
    typeof a === 'object' &&
    a !== null &&
    typeof b === 'object' &&
    b !== null
  ) {
    // Check if both are ErrorLogData
    const aIsError = 'name' in a && 'message' in a && 'args' in a;
    const bIsError = 'name' in b && 'message' in b && 'args' in b;

    if (aIsError && bIsError) {
      const aError = a as ErrorLogData;
      const bError = b as ErrorLogData;
      return (
        aError.name === bError.name &&
        aError.message === bError.message &&
        aError.stack === bError.stack &&
        JSON.stringify(aError.args) === JSON.stringify(bError.args)
      );
    }

    // Generic object comparison
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;

    return aKeys.every(key => {
      const aVal = (a as Record<string, unknown>)[key];
      const bVal = (b as Record<string, unknown>)[key];
      // Recursive comparison for nested objects
      if (
        typeof aVal === 'object' &&
        aVal !== null &&
        typeof bVal === 'object' &&
        bVal !== null
      ) {
        return JSON.stringify(aVal) === JSON.stringify(bVal);
      }
      return aVal === bVal;
    });
  }

  // Type mismatch
  return false;
}

export const useDebugLogs = create<DebugStore>()(
  persist(
    (set, get) => ({
      logs: [],
      logLimit: DEFAULT_LOG_STORAGE_LIMIT,

      add: (level, message, data) => {
        // Normalize all arguments so we can extract meaningful error info.
        const argArray =
          Array.isArray(data) && (data as unknown[]).length > 0
            ? (data as unknown[])
            : typeof data !== 'undefined'
              ? [message, data]
              : [message];

        const firstError = argArray.find(v => v instanceof Error) as
          | Error
          | undefined;

        // Prefer the real error message/name when available.
        const msg =
          firstError != null
            ? `${firstError.name}: ${firstError.message}`
            : message instanceof Error
              ? `${message.name}: ${message.message}`
              : String(message);

        // For errors, capture a structured payload including stack + original args.
        const errorData: ErrorLogData | undefined =
          firstError != null
            ? {
                name: firstError.name,
                message: firstError.message,
                stack: firstError.stack,
                args: argArray,
              }
            : undefined;

        const entry: LogEntry = {
          id: ++idCounter,
          ts: new Date().toISOString(),
          level,
          msg,
          data:
            errorData ??
            data ??
            (message instanceof Error ? message.stack : undefined),
          repeatCount: 1,
        };

        const currentLimit = get().logLimit || DEFAULT_LOG_STORAGE_LIMIT;

        set(state => {
          // Check if the last log is identical to this one
          const lastLog = state.logs[state.logs.length - 1];
          const isDuplicate =
            lastLog &&
            lastLog.level === entry.level &&
            lastLog.msg === entry.msg &&
            isLogDataEqual(lastLog.data, entry.data);

          if (isDuplicate) {
            // Increment the counter of the last log instead of adding a new one
            const updatedLogs = [...state.logs];
            const lastIndex = updatedLogs.length - 1;
            updatedLogs[lastIndex] = {
              ...updatedLogs[lastIndex],
              repeatCount: (updatedLogs[lastIndex].repeatCount || 1) + 1,
            };
            return { logs: updatedLogs };
          }

          // Add new log entry
          const newLogs =
            state.logs.length >= currentLimit
              ? [...state.logs.slice(-currentLimit + 1), entry]
              : [...state.logs, entry];
          return { logs: newLogs };
        });
      },

      clear: () => set({ logs: [] }),

      share: async () => {
        const logs = get().logs;

        // Build detailed log content with data for better debugging
        const lines = logs.map(l => {
          const time = l.ts.split('T')[1].slice(0, 12);
          const level = l.level.toUpperCase().padEnd(5);
          const repeatSuffix =
            (l.repeatCount || 1) > 1 ? ` (×${l.repeatCount})` : '';
          let line = `${time} [${level}] ${l.msg}${repeatSuffix}`;

          // Include data if present
          if (l.data !== undefined) {
            try {
              const dataStr = JSON.stringify(l.data, null, 2);
              // Indent data lines for readability
              const indentedData = dataStr
                .split('\n')
                .map(dl => `    ${dl}`)
                .join('\n');
              line += `\n${indentedData}`;
            } catch {
              line += `\n    [Data could not be serialized]`;
            }
          }

          return line;
        });

        const text = lines.join('\n\n');

        // Generate filename with timestamp
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `gossip-debug-logs-${timestamp}.txt`;

        const copyToClipboard = async () => {
          if (!navigator.clipboard) {
            throw new Error('Clipboard API not available');
          }
          await navigator.clipboard.writeText(text);
          toast.success('Logs copied to clipboard!');
        };

        // Share using native Capacitor plugins on mobile
        const tryNativeShare = async (): Promise<boolean> => {
          if (!Capacitor.isNativePlatform()) {
            return false;
          }

          try {
            // Write the file to the cache directory
            // Note: We don't delete the file manually - it's in the Cache directory
            // so the OS will clean it up automatically when space is needed
            const result = await Filesystem.writeFile({
              path: filename,
              data: text,
              directory: Directory.Cache,
              encoding: Encoding.UTF8,
            });

            // Share the file using native share sheet
            await Share.share({
              title: 'Gossip Debug Logs',
              files: [result.uri],
              dialogTitle: 'Share Debug Logs',
            });

            return true;
          } catch (error) {
            // User cancelled - this is expected behavior
            if (
              error instanceof Error &&
              (error.message.includes('cancel') ||
                error.message.includes('User cancelled'))
            ) {
              return true; // Consider cancelled as "handled"
            }
            console.error('Native share failed:', error);
            return false;
          }
        };

        // Try to share as file using Web Share API (for web platforms)
        const tryWebShareAsFile = async (): Promise<boolean> => {
          try {
            type ShareData = {
              files?: File[];
              title?: string;
              text?: string;
            };
            const nav = navigator as Navigator & {
              canShare?: (data?: ShareData) => boolean;
              share?: (data: ShareData) => Promise<void>;
            };

            if (
              typeof nav.canShare !== 'function' ||
              typeof nav.share !== 'function'
            ) {
              return false;
            }

            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const shareFile = new File([blob], filename, {
              type: 'text/plain',
            });

            const canShareFiles = nav.canShare({ files: [shareFile] });
            if (!canShareFiles) {
              return false;
            }

            await nav.share({
              files: [shareFile],
              title: 'Gossip Debug Logs',
            });
            toast.success('Logs shared!');
            return true;
          } catch (error) {
            // User cancelled - this is expected behavior
            if (
              error instanceof Error &&
              (error.name === 'AbortError' || error.message.includes('cancel'))
            ) {
              return true; // Consider cancelled as "handled"
            }
            return false;
          }
        };

        try {
          // Try native share first (for mobile)
          let shared = await tryNativeShare();
          if (!shared) {
            // Try web share API
            shared = await tryWebShareAsFile();
          }
          if (!shared) {
            // Fallback to clipboard
            await copyToClipboard();
          }
        } catch {
          try {
            await copyToClipboard();
          } catch {
            toast.error('Failed to share logs');
          }
        }
      },
      showDebugConsole: false,
      setShowDebugConsole: (show: boolean) => set({ showDebugConsole: show }),
      setLogLimit: (limit: LogLimit) =>
        set(state => {
          const normalized: LogLimit = LOG_LIMIT_OPTIONS.includes(limit)
            ? limit
            : DEFAULT_LOG_STORAGE_LIMIT;
          const trimmedLogs =
            state.logs.length > normalized
              ? state.logs.slice(-normalized)
              : state.logs;

          return {
            logLimit: normalized,
            logs: trimmedLogs,
          };
        }),
    }),
    {
      name: LOG_STORAGE_KEY_PREFIX,
      storage: createJSONStorage(() => ({
        getItem: async (name: string) => {
          const { value } = await Preferences.get({ key: name });
          return value;
        },
        setItem: async (name: string, value: string) => {
          await Preferences.set({ key: name, value });
        },
        removeItem: async (name: string) => {
          await Preferences.remove({ key: name });
        },
      })),
      partialize: state => ({
        logs: state.logs,
        logLimit: state.logLimit,
      }),
    }
  )
);
