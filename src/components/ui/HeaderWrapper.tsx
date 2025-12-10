import React from 'react';
import { useAppStore } from '../../stores/appStore';

interface HeaderWrapperProps {
  children: React.ReactNode;
  className?: string;
}

const HeaderWrapper: React.FC<HeaderWrapperProps> = ({
  children,
  className = '',
}) => {
  const headerIsScrolled = useAppStore(s => s.headerIsScrolled);

  // Background colors:
  // - At top (scrollY === 0): bg-card (white in light, card in dark)
  // - When scrolled: bg-[var(--header-scrolled)] (lighter grey in light, muted in dark)
  const bgClass = headerIsScrolled ? 'bg-[var(--header-scrolled)]' : 'bg-card';

  return (
    <div className={`px-6 py-4 header-bg-transition ${bgClass} ${className}`}>
      {children}
    </div>
  );
};

export default HeaderWrapper;
