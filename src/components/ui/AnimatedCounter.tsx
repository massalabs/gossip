import React, { useEffect, useState } from 'react';

interface AnimatedCounterProps {
  value: number;
  className?: string;
}

const baseSpan =
  'absolute inset-0 flex items-center text-lg font-semibold text-foreground tabular-nums';

interface CounterStyle extends React.CSSProperties {
  '--counter-end'?: string;
  '--counter-start'?: string;
}

const AnimatedCounter: React.FC<AnimatedCounterProps> = ({
  value,
  className = '',
}) => {
  const [trackedValue, setTrackedValue] = useState(value);
  const [animPrev, setAnimPrev] = useState(value);
  const [direction, setDirection] = useState<'up' | 'down'>('down');
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (value === trackedValue) return;

    setDirection(value > trackedValue ? 'down' : 'up');
    setAnimPrev(trackedValue);
    setTrackedValue(value);
    setIsAnimating(true);
  }, [value, trackedValue]);

  useEffect(() => {
    if (!isAnimating) return;
    // Safety fallback: end animation state even if animation events are skipped.
    const fallback = setTimeout(() => setIsAnimating(false), 260);
    return () => clearTimeout(fallback);
  }, [isAnimating]);

  const oldValueStyle: CounterStyle = {
    animation: `counter-out 0.2s ease-out forwards`,
    '--counter-end': direction === 'down' ? '-100%' : '100%',
  };
  const newValueStyle: CounterStyle = {
    animation: `counter-in 0.2s ease-out forwards`,
    '--counter-start':
      direction === 'down' ? 'translateY(100%)' : 'translateY(-100%)',
  };

  return (
    <div className={`relative overflow-hidden h-7 min-w-[1ch] ${className}`}>
      {!isAnimating && <span className={baseSpan}>{value}</span>}
      {isAnimating && (
        <>
          {/* Old value slides out */}
          <span className={baseSpan} style={oldValueStyle}>
            {animPrev}
          </span>
          {/* New value slides in */}
          <span
            className={baseSpan}
            style={newValueStyle}
            onAnimationEnd={() => setIsAnimating(false)}
          >
            {value}
          </span>
        </>
      )}
    </div>
  );
};

export default AnimatedCounter;
