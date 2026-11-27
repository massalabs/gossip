import React, { useRef, useEffect, useState } from 'react';
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
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Map<DiscussionFilter, HTMLButtonElement>>(
    new Map()
  );
  const [pillStyle, setPillStyle] = useState<React.CSSProperties>({});
  const [ready, setReady] = useState(false);

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

  // Measure active button and position the pill
  useEffect(() => {
    const btn = buttonRefs.current.get(filter);
    if (!btn) return;

    setPillStyle({
      left: btn.offsetLeft,
      width: btn.offsetWidth,
    });

    // Enable transition after first measurement (avoid initial slide)
    if (!ready) requestAnimationFrame(() => setReady(true));
  }, [filter, ready, filterCounts]);

  return (
    <div className={className}>
      <div
        ref={containerRef}
        role="group"
        aria-label={t('filter_label')}
        className="relative flex items-center gap-2"
      >
        {/* Sliding pill */}
        <span
          className="absolute bg-accent-soft rounded-full"
          style={{
            ...pillStyle,
            height: '100%',
            top: 0,
            transition: ready
              ? 'left 0.25s cubic-bezier(0.4, 0, 0.2, 1), width 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
              : 'none',
          }}
        />

        {filterOptions.map(option => {
          const isActive = filter === option.value;
          return (
            <button
              key={option.value}
              ref={el => {
                if (el) buttonRefs.current.set(option.value, el);
              }}
              onClick={() => onFilterChange(option.value)}
              aria-pressed={isActive}
              className={`relative z-[1] px-4 py-2 rounded-full text-sm font-medium transition-colors duration-200 ${
                isActive
                  ? 'text-accent-soft-foreground'
                  : 'text-muted-foreground'
              }`}
            >
              {option.label}
              {option.count > 0 && (
                <span className="transition-opacity duration-150">
                  {' '}
                  {option.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default DiscussionFilterButtons;
