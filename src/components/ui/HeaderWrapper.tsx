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

  const bgClass = headerIsScrolled ? 'bg-muted' : 'bg-card';

  return (
    <div
      className={`px-6 py-4 header-bg-transition ${bgClass} ${className}`}
      style={{
        boxShadow: headerIsScrolled
          ? '0 2px 4px -1px rgba(0, 0, 0, 0.06), 0 4px 6px -1px rgba(0, 0, 0, 0.1)'
          : 'none',
        transition:
          'background-color 200ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 200ms cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {children}
    </div>
  );
};

export default HeaderWrapper;
