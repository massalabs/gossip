import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Preferences } from '@capacitor/preferences';
import { toast } from 'react-hot-toast';

const LOG_STORAGE_KEY = 'debug-logs';
const LOG_STORAGE_VERSION = 1;
const LOG_STORAGE_KEY_PREFIX = `${LOG_STORAGE_KEY}-v${LOG_STORAGE_VERSION}`;
export const LOG_LIMIT_OPTIONS = [20, 50, 100, 200, 500] as const;
export type LogLimit = (typeof LOG_LIMIT_OPTIONS)[number];
const DEFAULT_LOG_STORAGE_LIMIT: LogLimit = 200;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  msg: string;
  data?: unknown;
}

interface DebugStore {
  logs: LogEntry[];
  logLimit: LogLimit;
  add: (level: LogLevel, message: unknown, data?: unknown) => void;
  clear: () => void;
  share: () => Promise<void>;
  showDebugConsole: boolean;
  setShowDebugConsole: (show: boolean) => void;
  setLogLimit: (limit: LogLimit) => void;
}

let idCounter = Date.now();

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

        const entry: LogEntry = {
          id: ++idCounter,
          ts: new Date().toISOString(),
          level,
          msg,
          // For errors, capture a structured payload including stack + original args.
          data:
            firstError != null
              ? {
                  name: firstError.name,
                  message: firstError.message,
                  stack: firstError.stack,
                  args: argArray,
                }
              : (data ??
                (message instanceof Error ? message.stack : undefined)),
        };

        const currentLimit = get().logLimit || DEFAULT_LOG_STORAGE_LIMIT;

        set(state => {
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
        const text = logs
          .map(
            l =>
              `${l.ts.split('T')[1].slice(0, 12)} [${l.level.toUpperCase()}] ${l.msg}`
          )
          .join('\n');

        const copyToClipboard = async () => {
          if (!navigator.clipboard) {
            throw new Error('Clipboard API not available');
          }
          await navigator.clipboard.writeText(text);
          toast.success('Logs copied to clipboard!');
        };

        try {
          if (navigator.share) {
            await navigator.share({ title: 'Debug Logs', text });
            toast.success('Logs shared!');
          } else {
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
