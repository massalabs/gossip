import React, { useEffect } from 'react';
import { useUiStore } from '../../stores/uiStore';

interface HeaderWrapperProps {
  children: React.ReactNode;
  className?: string;
}

const HeaderWrapper: React.FC<HeaderWrapperProps> = ({
  children,
  className = '',
}) => {
  const headerIsScrolled = useUiStore(s => s.headerIsScrolled);
  const setHeaderVisible = useUiStore(s => s.setHeaderVisible);

  // Declare header presence
  useEffect(() => {
    setHeaderVisible(true);
    return () => {
      setHeaderVisible(false);
    };
  }, [setHeaderVisible]);

  const bgClass = headerIsScrolled ? 'bg-[var(--header-scrolled)]' : 'bg-card';

  return (
    <div className={`px-6 py-4 header-bg-transition ${bgClass} ${className}`}>
      {children}
    </div>
  );
};

export default HeaderWrapper;
