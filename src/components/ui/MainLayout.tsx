import React from 'react';
import { useLocation } from 'react-router-dom';
import { useKeyboardStore } from '../../stores/keyboardStore';
import { useUiStore } from '../../stores/uiStore';
import { shouldShowBottomNav } from '../../constants/pageConfig';
import BottomNavigation from './BottomNavigation';

interface MainLayoutProps {
  children: React.ReactNode;
  contentClassName?: string;
}

/**
 * Main layout wrapper for the app.
 *
 * Handles:
 * - Bottom safe area inset (when keyboard is not visible)
 * - Flex column layout with scrollable content
 * - Optional bottom navigation bar (controlled by user preference)
 *
 * Note: The iOS keyboard workaround that shifts the entire app up is handled
 * by KeyboardAwareWrapper at a higher level (in App.tsx), not by this component.
 */
const MainLayout: React.FC<MainLayoutProps> = ({
  children,
  contentClassName = '',
}) => {
  const isKeyboardVisible = useKeyboardStore(s => s.isVisible);
  const showBottomNav = useUiStore.use.showBottomNav();
  const location = useLocation();

  const showNav =
    showBottomNav &&
    !isKeyboardVisible &&
    shouldShowBottomNav(location.pathname);

  const safeAreaClass = isKeyboardVisible || showNav ? '' : 'pb-safe-b';

  return (
    <div className="relative h-full flex flex-col">
      <main
        className={`flex-1 min-h-0 app-max-w ${safeAreaClass} ${contentClassName}`.trim()}
      >
        {children}
      </main>
      {showNav && <BottomNavigation />}
    </div>
  );
};

export default MainLayout;
