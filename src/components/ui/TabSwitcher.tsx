import React, { useState, useEffect } from 'react';

export interface TabOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

interface TabSwitcherProps<T extends string> {
  options: TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

function TabSwitcher<T extends string>({
  options,
  value,
  onChange,
  className = '',
}: TabSwitcherProps<T>) {
  const activeIndex = options.findIndex(opt => opt.value === value);
  const tabCount = options.length;
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    // Enable transitions after initial mount
    setIsMounted(true);
  }, []);

  // Calculate width and position for the active indicator
  // For 2 tabs: width is calc(50% - 0.75rem), position is either left-1.5 or left-[calc(50%+0.50rem)]
  const getIndicatorStyle = () => {
    if (tabCount === 2) {
      return {
        width: 'calc(50% - 0.75rem)',
        left: activeIndex === 0 ? '0.375rem' : 'calc(50% + 0.50rem)',
      };
    }
    // For more tabs, calculate dynamically
    const gap = 0.375; // 1.5rem / 4 = 0.375rem
    const tabWidth = `calc((100% - ${(tabCount - 1) * gap}rem) / ${tabCount})`;
    return {
      width: tabWidth,
      left: `calc(${activeIndex} * (${tabWidth} + ${gap}rem) + ${gap}rem)`,
    };
  };

  return (
    <div
      className={`relative w-full bg-muted rounded-3xl p-1.5 flex items-center gap-1.5 ${className}`}
    >
      {/* Active indicator */}
      <div
        className={`absolute top-1.5 bottom-1.5 rounded-3xl bg-primary shadow-sm transition-all duration-300 ease-out${!isMounted ? ' no-transition' : ''}`}
        style={getIndicatorStyle()}
        aria-hidden="true"
      />
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`relative z-10 flex-1 h-11 inline-flex items-center justify-center gap-2 text-sm font-semibold rounded-xl transition-all duration-200 ${
            value === option.value
              ? 'text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          aria-pressed={value === option.value}
        >
          {option.icon && <span className="w-4 h-4">{option.icon}</span>}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export default TabSwitcher;
