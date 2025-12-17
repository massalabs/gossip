import React from 'react';
import { formatDateSeparator } from '../../utils/timeUtils';

interface DateSeparatorProps {
  date: Date;
}

const DateSeparator: React.FC<DateSeparatorProps> = ({ date }) => {
  return (
    <div className="flex items-center justify-center py-3 px-4">
      <div className="px-3 py-1.5 rounded-full bg-muted/50 dark:bg-muted/30">
        <span className="text-xs font-medium text-muted-foreground">
          {formatDateSeparator(date)}
        </span>
      </div>
    </div>
  );
};

export default DateSeparator;
