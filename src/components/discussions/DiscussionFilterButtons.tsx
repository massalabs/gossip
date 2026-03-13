import React from 'react';
import { useTranslation } from 'react-i18next';
import { DiscussionFilter } from '../../stores/discussionStore';

interface DiscussionFilterButtonsProps {
  filter: DiscussionFilter;
  onFilterChange: (filter: DiscussionFilter) => void;
  filterCounts: {
    all: number;
    unread: number;
    pending: number;
  };
  className?: string;
}

const DiscussionFilterButtons: React.FC<DiscussionFilterButtonsProps> = ({
  filter,
  onFilterChange,
  filterCounts,
  className = '',
}) => {
  const { t } = useTranslation('discussions');
  const filterOptions: Array<{
    value: DiscussionFilter;
    label: string;
    count: number;
  }> = [
    { value: 'all', label: t('filter.all'), count: filterCounts.all },
    { value: 'unread', label: t('filter.unread'), count: filterCounts.unread },
    {
      value: 'pending',
      label: t('filter.pending'),
      count: filterCounts.pending,
    },
  ];

  return (
    <div className={`px-2 mb-3 ${className}`}>
      <div
        role="group"
        aria-label="Filter discussions"
        className="flex items-center gap-2"
      >
        {filterOptions.map(option => (
          <button
            key={option.value}
            onClick={() => onFilterChange(option.value)}
            aria-pressed={filter === option.value}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 ${
              filter === option.value
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            {option.label}
            {option.count > 0 ? ` ${option.count}` : ''}
          </button>
        ))}
      </div>
    </div>
  );
};

export default DiscussionFilterButtons;
