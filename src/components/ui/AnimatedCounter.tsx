import React, { useEffect, useRef, useState } from 'react';

interface AnimatedCounterProps {
  value: number;
  className?: string;
}

const baseSpan =
  'absolute inset-0 flex items-center text-lg font-semibold text-foreground tabular-nums';

const AnimatedCounter: React.FC<AnimatedCounterProps> = ({
  value,
  className = '',
}) => {
  const [trackedValue, setTrackedValue] = useState(value);
  const [animPrev, setAnimPrev] = useState(value);
  const [direction, setDirection] = useState<'up' | 'down'>('down');
  const [isAnimating, setIsAnimating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (value === trackedValue) return;

    setDirection(value > trackedValue ? 'down' : 'up');
    setAnimPrev(trackedValue);
    setTrackedValue(value);
    setIsAnimating(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setIsAnimating(false), 220);
  }, [value, trackedValue]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Slide out: center → up (for 'down' direction) or center → down (for 'up' direction)
  // const slideOut =
  //   direction === 'down'
  //     ? 'translateY(0) -> translateY(-100%)'
  //     : 'translateY(0) -> translateY(100%)';
  // Slide in: bottom → center (for 'down') or top → center (for 'up')
  const slideInFrom =
    direction === 'down' ? 'translateY(100%)' : 'translateY(-100%)';

  return (
    <div className={`relative overflow-hidden h-7 min-w-[1ch] ${className}`}>
      {!isAnimating && <span className={baseSpan}>{value}</span>}
      {isAnimating && (
        <>
          {/* Old value slides out */}
          <span
            className={baseSpan}
            style={{
              animation: `counter-out 0.2s ease-out forwards`,
              // @ts-expect-error CSS custom property
              '--counter-end': direction === 'down' ? '-100%' : '100%',
            }}
          >
            {animPrev}
          </span>
          {/* New value slides in */}
          <span
            className={baseSpan}
            style={{
              animation: `counter-in 0.2s ease-out forwards`,
              // @ts-expect-error CSS custom property
              '--counter-start': slideInFrom,
            }}
          >
            {value}
          </span>
        </>
      )}
    </div>
  );
};

export default AnimatedCounter;
