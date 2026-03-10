import React, { useState, useEffect, useRef } from 'react';

interface AnimatedCounterProps {
  value: number;
  className?: string;
}

const AnimatedCounter: React.FC<AnimatedCounterProps> = ({
  value,
  className = '',
}) => {
  const [displayValue, setDisplayValue] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  const [direction, setDirection] = useState<'up' | 'down'>('down');
  const [isAnimating, setIsAnimating] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (value === displayValue) return;

    setDirection(value > displayValue ? 'down' : 'up');
    setPrevValue(displayValue);
    setIsAnimating(true);

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setDisplayValue(value);
      setIsAnimating(false);
    }, 200);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [value, displayValue]);

  return (
    <div className={`relative overflow-hidden h-7 min-w-[1ch] ${className}`}>
      {/* Old value — slides out */}
      <span
        className={`absolute inset-0 flex items-center text-lg font-semibold text-foreground tabular-nums transition-transform duration-200 ease-out ${
          isAnimating
            ? direction === 'down'
              ? '-translate-y-full'
              : 'translate-y-full'
            : 'translate-y-0'
        }`}
      >
        {isAnimating ? prevValue : displayValue}
      </span>
      {/* New value — slides in */}
      {isAnimating && (
        <span
          className={`absolute inset-0 flex items-center text-lg font-semibold text-foreground tabular-nums ${
            direction === 'down'
              ? 'animate-slide-in-from-bottom'
              : 'animate-slide-in-from-top'
          }`}
        >
          {value}
        </span>
      )}
    </div>
  );
};

export default AnimatedCounter;
