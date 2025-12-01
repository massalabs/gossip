// MainLayout.tsx
import React from 'react';
import BottomNavigation from './BottomNavigation';
import { useNetworkStore } from '../../stores/networkStore';

const MainLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isOnline = useNetworkStore(s => s.isOnline);

  return (
    <div className="relative h-full flex flex-col">
      {!isOnline && (
        <div className="sticky top-0 bg-destructive text-xs text-center shadow-sm z-20 app-max-width px-3 py-1">
          <p>
            You're offline. Messages and updates will sync when you're back
            online.
          </p>
        </div>
      )}
      <div className="flex-1 overflow-y-auto min-h-0 pb-(--bottom-nav-height) app-max-width w-full">
        {children}
      </div>
      <BottomNavigation />
    </div>
  );
};

export default MainLayout;
