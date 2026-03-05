import React from 'react';
import { useKeyboardVisible } from '../../hooks/useKeyboardVisible';

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
 *
 * Note: The iOS keyboard workaround that shifts the entire app up is handled
 * by IOSKeyboardWrapper at a higher level (in App.tsx), not by this component.
 */
const MainLayout: React.FC<MainLayoutProps> = ({
  children,
  contentClassName = '',
}) => {
  const { isKeyboardVisible } = useKeyboardVisible();
  const safeAreaClass = isKeyboardVisible ? '' : 'pb-safe-b';

  return (
    <div className="relative h-full flex flex-col">
      <main
        className={`flex-1 min-h-0 app-max-w ${safeAreaClass} ${contentClassName}`.trim()}
      >
        {children}
      </main>
    </div>
  );
};

export default MainLayout;
