import React, { useState, useRef, useEffect } from 'react';
import { useDebugLogs } from '../../../stores/useDebugLogs';
import { useAppStore } from '../../../stores/appStore';
import toast from 'react-hot-toast';
import {
  ConsoleToggleButton,
  ConsoleHeader,
  ConsoleToolbar,
  LogList,
  ScrollLockIndicator,
  LogLevelFilter,
} from '.';
import { formatTime } from './utils';

export const DebugConsole: React.FC = () => {
  const logs = useDebugLogs(s => s.logs);
  const { clear, share } = useDebugLogs.getState();
  const showDebugConsole = useDebugLogs(s => s.showDebugConsole);
  const setShowDebugConsole = useDebugLogs(s => s.setShowDebugConsole);
  const logLimit = useDebugLogs(s => s.logLimit);
  const setLogLimit = useDebugLogs(s => s.setLogLimit);
  const showDebugOption = useAppStore(s => s.showDebugOption);
  const debugOverlayVisible = useAppStore(s => s.debugOverlayVisible);
  const [filter, setFilter] = useState<LogLevelFilter>('all');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(false);
  const [expandedLogs, setExpandedLogs] = useState<Set<number>>(new Set());
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
  }, [logs, autoScroll, showDebugConsole]);

  const copyAll = async () => {
    const text = filtered
      .map(l => {
        const baseLine = `${formatTime(l.ts)} [${l.level.toUpperCase()}] ${l.msg}`;
        const repeatCount = l.repeatCount || 1;
        return repeatCount > 1 ? `${baseLine} (×${repeatCount})` : baseLine;
      })
      .join('\n');
    await navigator.clipboard.writeText(text);
    toast.success('Copied all logs to clipboard!');
  };

  const copyLine = async (msg: string) => {
    await navigator.clipboard.writeText(msg);
    toast.success('Line copied to clipboard!');
  };

  const toggleLogData = (logId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedLogs(prev => {
      const next = new Set(prev);
      if (next.has(logId)) {
        next.delete(logId);
      } else {
        next.add(logId);
      }
      return next;
    });
  };

  const tryShare = async () => {
    try {
      await share();
    } catch {
      await copyAll();
    }
  };

  // Don't render anything if debug options are disabled
  if (!showDebugOption) {
    return null;
  }

  // Show the toggle button only if debugOverlayVisible is enabled
  if (!showDebugConsole) {
    if (!debugOverlayVisible) {
      return null;
    }
    return <ConsoleToggleButton onOpen={() => setShowDebugConsole(true)} />;
  }

  return (
    <div className="fixed inset-0 z-9999 flex flex-col bg-background/95 text-foreground font-sans text-xs">
      <ConsoleHeader
        logCount={logs.length}
        onClose={() => setShowDebugConsole(false)}
      />

      <ConsoleToolbar
        onCopyAll={copyAll}
        onShare={tryShare}
        onClear={clear}
        search={search}
        onSearchChange={setSearch}
        filter={filter}
        onFilterChange={setFilter}
        logLimit={logLimit}
        onLogLimitChange={setLogLimit}
        autoScroll={autoScroll}
        onAutoScrollChange={setAutoScroll}
      />

      <LogList
        logs={logs}
        filteredLogs={filtered}
        expandedLogs={expandedLogs}
        onToggleExpand={toggleLogData}
        onCopy={copyLine}
        scrollRef={scrollRef}
      />

      <ScrollLockIndicator
        isVisible={!autoScroll && filtered.length < logs.length}
        hiddenCount={logs.length - filtered.length}
      />
    </div>
  );
};
