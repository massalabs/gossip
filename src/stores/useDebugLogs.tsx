// src/stores/useDebugLogs.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Preferences } from '@capacitor/preferences';
import { toast } from 'react-hot-toast';

const LOG_STORAGE_KEY = 'debug-logs';
const LOG_STORAGE_VERSION = 1;
const LOG_STORAGE_KEY_PREFIX = `${LOG_STORAGE_KEY}-v${LOG_STORAGE_VERSION}`;
const LOG_STORAGE_LIMIT = 200;
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
  add: (level: LogLevel, message: unknown, data?: unknown) => void;
  clear: () => void;
  share: () => Promise<void>;
  showDebugConsole: boolean;
  setShowDebugConsole: (show: boolean) => void;
}

let idCounter = Date.now();

export const useDebugLogs = create<DebugStore>()(
  persist(
    (set, get) => ({
      logs: [],

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

        set(state => ({
          logs: [...state.logs.slice(-LOG_STORAGE_LIMIT), entry],
        }));
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

        if (navigator.share) {
          await navigator.share({ title: 'Debug Logs', text });
        } else {
          await navigator.clipboard.writeText(text);
          toast.success('Logs copied to clipboard!');
        }
      },
      showDebugConsole: false,
      setShowDebugConsole: (show: boolean) => set({ showDebugConsole: show }),
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
    }
  )
);
