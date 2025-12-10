import React, { useRef } from 'react';
import { useHeaderScroll } from '../../hooks/useHeaderScroll';

interface ScrollableContentProps {
  children: React.ReactNode;
  className?: string;
  id?: string;
}

/**
 * Wrapper component for scrollable content that automatically detects scroll
 * and updates the header background state globally.
 * Use this to wrap any scrollable content area.
 */
const ScrollableContent: React.FC<ScrollableContentProps> = ({
  children,
  className = '',
  id,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  useHeaderScroll({ scrollContainerRef });

  return (
    <div ref={scrollContainerRef} id={id} className={className}>
      {children}
    </div>
  );
};

export default ScrollableContent;
