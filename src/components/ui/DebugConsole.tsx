// src/components/DebugConsole.tsx
import React, { useState, useRef, useEffect } from 'react';
import { useDebugLogs, LogEntry, LogLevel } from '../../stores/useDebugLogs';
import { useAppStore } from '../../stores/appStore';
import Button from './Button';
import toast from 'react-hot-toast';

const levelColor: Record<LogLevel, string> = {
  debug: 'var(--color-muted-foreground)',
  info: 'var(--color-primary)',
  warn: 'var(--color-secondary)',
  error: 'var(--color-destructive)',
};

const levelBg: Record<LogLevel, string> = {
  debug: 'bg-muted',
  info: 'bg-primary/5',
  warn: 'bg-secondary/10',
  error: 'bg-destructive/10',
};

type LogLevelFilter = 'all' | 'debug' | 'info' | 'warn' | 'error';

export const DebugConsole: React.FC = () => {
  const logs = useDebugLogs(s => s.logs);
  const { clear, share } = useDebugLogs.getState();
  const showDebugConsole = useDebugLogs(s => s.showDebugConsole);
  const setShowDebugConsole = useDebugLogs(s => s.setShowDebugConsole);
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const [filter, setFilter] = useState<LogLevelFilter>('all');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = logs.filter(log => {
    if (filter !== 'all' && log.level !== filter) return false;
    if (search && !log.msg.toLowerCase().includes(search.toLowerCase()))
      return false;
    return true;
  });

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const formatTime = (iso: string): string => {
    const d = new Date(iso);
    const hrs = d.getHours().toString().padStart(2, '0');
    const mins = d.getMinutes().toString().padStart(2, '0');
    const secs = d.getSeconds().toString().padStart(2, '0');
    const ms = d.getMilliseconds().toString().padStart(3, '0');
    return `${hrs}:${mins}:${secs}.${ms}`;
  };

  const copyAll = async () => {
    const text = filtered
      .map(l => `${formatTime(l.ts)} [${l.level.toUpperCase()}] ${l.msg}`)
      .join('\n');
    await navigator.clipboard.writeText(text);

    toast.success('Copied all logs to clipboard!');
  };

  const copyLine = async (msg: string) => {
    await navigator.clipboard.writeText(msg);
    toast.success('Line copied to clipboard!');
  };

  const tryShare = async () => {
    try {
      await share();
    } catch {
      await copyAll();
    }
  };

  const closeConsole = () => {
    setShowDebugConsole(false);
  };

  if (!showDebugOption) {
    return null;
  }

  if (!showDebugConsole) {
    // button to open the console
    return (
      <Button
        className="absolute bottom-2 left-4 z-9999"
        onClick={() => setShowDebugConsole(true)}
        variant="secondary"
      >
        Console
      </Button>
    );
  }

  return (
    <div className="fixed inset-0 z-9999 flex flex-col bg-background/95 text-foreground font-sans text-xs">
      {/* Header */}
      <div className="bg-card px-4 py-3 flex items-center justify-between shrink-0 border-b border-border">
        <div>
          <h2 className="text-lg font-bold">Debug Console</h2>
          <div className="text-xs text-muted-foreground">
            {logs.length} log{logs.length !== 1 ? 's' : ''}
          </div>
        </div>
        <button
          onClick={closeConsole}
          className="w-8 h-8 rounded-full hover:bg-muted flex items-center justify-center text-xl font-light text-muted-foreground transition-colors"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* Toolbar */}
      <div className="bg-card px-3 py-2 flex flex-wrap gap-2 items-center text-xs border-b border-border">
        <button
          onClick={copyAll}
          className="px-3 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded transition-colors"
        >
          Copy All
        </button>
        <button
          onClick={tryShare}
          className="px-3 py-1.5 bg-success hover:bg-success/90 text-success-foreground rounded transition-colors"
        >
          Share
        </button>
        <button
          onClick={clear}
          className="px-3 py-1.5 bg-destructive hover:bg-destructive/90 text-destructive-foreground rounded transition-colors"
        >
          Clear
        </button>

        <div className="flex-1 min-w-[100px]" />

        {/* Search */}
        <div className="bg-muted rounded flex items-center text-muted-foreground">
          <span className="px-2 select-none">Search</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-transparent outline-none py-1 w-32 text-foreground placeholder-muted-foreground"
            placeholder="search..."
          />
        </div>

        {/* Filter */}
        <select
          value={filter}
          onChange={e => setFilter(e.target.value as LogLevelFilter)}
          className="bg-muted text-foreground px-3 py-1.5 rounded border border-border"
        >
          <option value="all">All Levels</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>

        <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap text-muted-foreground">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={e => setAutoScroll(e.target.checked)}
            className="w-4 h-4 rounded accent-blue-500"
          />
          <span>Auto-scroll</span>
        </label>
      </div>

      {/* Log List */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-background font-mono text-xs leading-tight"
      >
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            {logs.length === 0 ? 'No logs yet' : 'No logs match your filter'}
          </div>
        ) : (
          filtered.map((log: LogEntry) => (
            <div
              key={log.id}
              onClick={() => copyLine(log.msg)}
              className={`px-4 py-2 border-b border-border/60 hover:bg-accent/10 cursor-pointer transition-colors ${levelBg[log.level]}`}
            >
              <div className="flex gap-4 items-start">
                <span className="text-muted-foreground select-none tabular-nums">
                  {formatTime(log.ts)}
                </span>
                <span
                  style={{ color: levelColor[log.level] }}
                  className="select-none font-medium"
                >
                  [{log.level.toUpperCase()}]
                </span>
                <span className="flex-1 text-foreground break-all">
                  {typeof log.msg === 'string'
                    ? log.msg
                    : JSON.stringify(log.msg, null, 2)}
                  {log.data !== undefined && (
                    <pre className="mt-2 text-xs bg-card p-3 rounded-lg overflow-x-auto border border-border text-foreground">
                      {JSON.stringify(log.data, null, 2)}
                    </pre>
                  )}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Scroll lock indicator */}
      {!autoScroll && filtered.length < logs.length && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 bg-card/95 text-foreground px-4 py-2 rounded-full text-xs shadow-md border border-border animate-pulse">
          Scroll locked · {logs.length - filtered.length} hidden
        </div>
      )}
    </div>
  );
};
