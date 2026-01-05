import React from 'react';
import { LogEntry } from '../../../stores/useDebugLogs.types';
import { ChevronRight } from 'react-feather';
import { levelColor, levelBg } from './constants';
import { formatTime, formatLogMessage } from './utils';

interface LogEntryItemProps {
  log: LogEntry;
  isExpanded: boolean;
  onToggleExpand: (logId: number, e: React.MouseEvent) => void;
  onCopy: (msg: string) => void;
}

export const LogEntryItem: React.FC<LogEntryItemProps> = ({
  log,
  isExpanded,
  onToggleExpand,
  onCopy,
}) => {
  const hasData = log.data !== undefined;
  const repeatCount = log.repeatCount || 1;

  return (
    <div
      onClick={() => onCopy(log.msg)}
      className={`px-4 py-2 border-b border-border/60 hover:bg-accent/10 cursor-pointer transition-colors ${levelBg[log.level]}`}
    >
      <div className="gap-4 items-start flex-col">
        <div className="flex items-center gap-2">
          {hasData && (
            <button
              onClick={e => onToggleExpand(log.id, e)}
              className="shrink-0 w-4 h-4 flex items-center justify-center hover:bg-muted/50 rounded transition-colors"
              aria-label={isExpanded ? 'Collapse data' : 'Expand data'}
            >
              <ChevronRight
                className={`w-3 h-3 text-muted-foreground transition-transform duration-200 ${
                  isExpanded ? 'rotate-90' : ''
                }`}
              />
            </button>
          )}
          <span className="text-muted-foreground select-none tabular-nums">
            {formatTime(log.ts)}
          </span>
          <span
            style={{ color: levelColor[log.level] }}
            className="select-none font-medium"
          >
            [{log.level.toUpperCase()}]
          </span>
          {repeatCount > 1 && (
            <span className="inline-flex items-center justify-center min-w-6 h-6 px-2 text-xs font-medium text-muted-foreground bg-muted rounded-full select-none border border-border">
              ×{repeatCount}
            </span>
          )}
        </div>
        <div>
          <span className="flex-1 text-foreground break-all">
            {formatLogMessage(log.msg)}
          </span>
          {hasData && isExpanded && (
            <pre className="mt-2 max-w-full whitespace-pre-wrap break-all text-xs bg-card p-3 rounded-lg overflow-x-auto border border-border text-foreground">
              {JSON.stringify(log.data, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};
