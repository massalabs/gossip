// src/utils/logger.ts

import { useDebugLogs } from '../stores/useDebugLogs';

let patched = false;

export const enableDebugLogger = () => {
  if (patched) return;
  patched = true;

  const add = useDebugLogs.getState().add;

  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const originalDebug = console.debug.bind(console);

  console.log = (...args) => {
    originalLog(...args);
    add('info', args[0], args);
  };

  console.info = (...args) => {
    originalInfo(...args);
    add('info', args[0], args);
  };

  console.warn = (...args) => {
    originalWarn(...args);
    add('warn', args[0], args);
  };

  console.error = (...args) => {
    originalError(...args);
    add('error', args[0], args);
  };

  console.debug = (...args) => {
    originalDebug(...args);
    add('debug', args[0], args);
  };
};
