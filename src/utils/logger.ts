import { useDebugLogs } from '../stores/useDebugLogs';

let patched = false;
let isLogging = false;

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
    if (isLogging) return;
    try {
      isLogging = true;
      add('info', args[0], args);
    } finally {
      isLogging = false;
    }
  };

  console.info = (...args) => {
    originalInfo(...args);
    if (isLogging) return;
    try {
      isLogging = true;
      add('info', args[0], args);
    } finally {
      isLogging = false;
    }
  };

  console.warn = (...args) => {
    originalWarn(...args);
    if (isLogging) return;
    try {
      isLogging = true;
      add('warn', args[0], args);
    } finally {
      isLogging = false;
    }
  };

  console.error = (...args) => {
    originalError(...args);
    if (isLogging) return;
    try {
      isLogging = true;
      add('error', args[0], args);
    } finally {
      isLogging = false;
    }
  };

  console.debug = (...args) => {
    originalDebug(...args);
    if (isLogging) return;
    try {
      isLogging = true;
      add('debug', args[0], args);
    } finally {
      isLogging = false;
    }
  };
};
