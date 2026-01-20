import React from 'react';
import {
  LOG_LIMIT_OPTIONS,
  LogLimit,
} from '../../../stores/useDebugLogs.types';
import { LogLevelFilter } from './constants';

interface ConsoleToolbarProps {
  onCopyAll: () => void;
  onShare: () => void;
  onClear: () => void;
  search: string;
  onSearchChange: (value: string) => void;
  filter: LogLevelFilter;
  onFilterChange: (value: LogLevelFilter) => void;
  logLimit: LogLimit;
  onLogLimitChange: (value: LogLimit) => void;
  autoScroll: boolean;
  onAutoScrollChange: (value: boolean) => void;
}

export const ConsoleToolbar: React.FC<ConsoleToolbarProps> = ({
  onCopyAll,
  onShare,
  onClear,
  search,
  onSearchChange,
  filter,
  onFilterChange,
  logLimit,
  onLogLimitChange,
  autoScroll,
  onAutoScrollChange,
}) => {
  return (
    <div className="bg-card px-3 py-2 flex flex-wrap gap-2 items-center text-xs border-b border-border">
      <button
        onClick={onCopyAll}
        className="px-3 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded transition-colors"
      >
        Copy All
      </button>
      <button
        onClick={onShare}
        className="px-3 py-1.5 bg-success hover:bg-success/90 text-success-foreground rounded transition-colors"
      >
        Share
      </button>
      <button
        onClick={onClear}
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
          onChange={e => onSearchChange(e.target.value)}
          className="bg-transparent outline-none py-1 w-32 text-foreground placeholder-muted-foreground"
          placeholder="search..."
        />
      </div>

      {/* Filter */}
      <select
        value={filter}
        onChange={e => onFilterChange(e.target.value as LogLevelFilter)}
        className="bg-muted text-foreground px-3 py-1.5 rounded border border-border"
      >
        <option value="all">All Levels</option>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
      </select>

      {/* Log limit */}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="whitespace-nowrap">Log limit</span>
        <select
          value={logLimit}
          onChange={e => {
            const value = parseInt(e.target.value, 10) as LogLimit;
            if (Number.isNaN(value)) return;
            onLogLimitChange(value);
          }}
          className="w-24 bg-muted text-foreground px-2 py-1 rounded border border-border outline-none"
        >
          {LOG_LIMIT_OPTIONS.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap text-muted-foreground">
        <input
          type="checkbox"
          checked={autoScroll}
          onChange={e => onAutoScrollChange(e.target.checked)}
          className="w-4 h-4 rounded accent-primary"
        />
        <span>Auto-scroll</span>
      </label>
    </div>
  );
};
