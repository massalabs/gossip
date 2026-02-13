import React from 'react';
import { useLocation } from 'react-router-dom';
import BottomNavigation from './BottomNavigation';
import { shouldShowBottomNav } from '../../constants/pageConfig';
import { useKeyboardVisible } from '../../hooks/useKeyboardVisible';

interface MainLayoutProps {
  children: React.ReactNode;
  /**
   * Additional className for the content wrapper
   */
  contentClassName?: string;
}

/**
 * Main layout wrapper for the app.
 *
 * Automatically handles:
 * - Bottom navigation visibility based on current route (via pageConfig)
 * - Safe area insets (top when no header, bottom when no nav)
 * - Flex column layout with scrollable content
 * - Adjusts bottom safe area padding based on keyboard visibility
 *
 * Note: The iOS keyboard workaround that shifts the entire app up is handled
 * by IOSKeyboardWrapper at a higher level (in App.tsx), not by this component.
 *
 * Safe area padding:
 * - Top (pt-safe-t): Applied by HeaderWrapper when present
 * - Bottom (pb-safe-b): Applied by BottomNavigation when present,
 *   otherwise applied here for pages without bottom nav (only when keyboard is not visible)
 *
 * Usage:
 * ```tsx
 * // Wrap the entire app or route content
 * <MainLayout>
 *   <YourRoutes />
 * </MainLayout>
 * ```
 *
 * Configure which routes show bottom nav in `src/constants/pageConfig.ts`
 */
const MainLayout: React.FC<MainLayoutProps> = ({
  children,
  contentClassName = '',
}) => {
  const location = useLocation();
  const showBottomNav = shouldShowBottomNav(location.pathname);
  const { isKeyboardVisible } = useKeyboardVisible();

  // Apply bottom safe area padding when there's no bottom nav AND keyboard is not visible
  const safeAreaClass = showBottomNav || isKeyboardVisible ? '' : 'pb-safe-b';

  return (
    <div className="relative h-full flex flex-col">
      <div
        className={`flex-1 min-h-0 app-max-w ${safeAreaClass} ${contentClassName}`.trim()}
      >
        {children}
      </div>
      {showBottomNav && <BottomNavigation />}
    </div>
  );
};

export default MainLayout;
