// MainLayout.tsx
import React from 'react';
import BottomNavigation from './BottomNavigation';

const MainLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <div className="relative h-full flex flex-col">
      <div className="flex-1 min-h-0 app-max-w">{children}</div>
      <BottomNavigation />
    </div>
  );
};

export default MainLayout;
