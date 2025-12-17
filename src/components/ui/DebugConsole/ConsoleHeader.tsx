import React from 'react';

interface ConsoleHeaderProps {
  logCount: number;
  onClose: () => void;
}

export const ConsoleHeader: React.FC<ConsoleHeaderProps> = ({
  logCount,
  onClose,
}) => {
  return (
    <div className="bg-card px-4 py-3 flex items-center justify-between shrink-0 border-b border-border">
      <div>
        <h2 className="text-lg font-bold">Debug Console</h2>
        <div className="text-xs text-muted-foreground">
          {logCount} log{logCount !== 1 ? 's' : ''}
        </div>
      </div>
      <button
        onClick={onClose}
        className="w-8 h-8 rounded-full hover:bg-muted flex items-center justify-center text-xl font-light text-muted-foreground transition-colors"
        aria-label="Close"
      >
        ×
      </button>
    </div>
  );
};
