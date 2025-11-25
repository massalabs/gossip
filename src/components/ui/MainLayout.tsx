// MainLayout.tsx
import React from 'react';
import BottomNavigation from './BottomNavigation';

const MainLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <div className="relative h-full flex flex-col">
      <div className="flex-1 overflow-y-auto min-h-0 pb-(--bottom-nav-height) max-w-md mx-auto w-full">
        {children}
      </div>
      <BottomNavigation />
    </div>
  );
};

export default MainLayout;
