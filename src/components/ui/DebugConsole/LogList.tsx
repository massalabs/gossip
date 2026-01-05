import React from 'react';
import { LogEntry } from '../../../stores/useDebugLogs.types';
import { LogEntryItem } from './LogEntryItem';

interface LogListProps {
  logs: LogEntry[];
  filteredLogs: LogEntry[];
  expandedLogs: Set<number>;
  onToggleExpand: (logId: number, e: React.MouseEvent) => void;
  onCopy: (msg: string) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

export const LogList: React.FC<LogListProps> = ({
  logs,
  filteredLogs,
  expandedLogs,
  onToggleExpand,
  onCopy,
  scrollRef,
}) => {
  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto bg-background font-mono text-xs leading-tight"
    >
      {filteredLogs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {logs.length === 0 ? 'No logs yet' : 'No logs match your filter'}
        </div>
      ) : (
        filteredLogs.map(log => (
          <LogEntryItem
            key={log.id}
            log={log}
            isExpanded={expandedLogs.has(log.id)}
            onToggleExpand={onToggleExpand}
            onCopy={onCopy}
          />
        ))
      )}
    </div>
  );
};
