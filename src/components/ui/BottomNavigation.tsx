import React, { useEffect } from 'react';
import { useLocation, useNavigate, matchPath } from 'react-router-dom';
import { Settings as SettingsFeather } from 'react-feather';
import { Capacitor } from '@capacitor/core';
import NavButton from './NavButton';
import GossipIcon from './customIcons/gossip-icon';
import { ROUTES } from '../../constants/routes';
import { useUiStore } from '../../stores/uiStore';

type BottomNavigationTab = 'discussions' | 'settings';

const BottomNavigation: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const setBottomNavVisible = useUiStore(s => s.setBottomNavVisible);

  // Declare bottom navigation presence
  useEffect(() => {
    setBottomNavVisible(true);
    return () => {
      setBottomNavVisible(false);
    };
  }, [setBottomNavVisible]);

  const activeTab: BottomNavigationTab = matchPath(
    location.pathname,
    ROUTES.settings()
  )
    ? 'settings'
    : 'discussions';

  const navItems = [
    {
      id: 'discussions' as const,
      path: ROUTES.discussions(),
      title: 'Discussions',
      icon: <GossipIcon size={24} />,
    },
    {
      id: 'settings' as const,
      path: ROUTES.settings(),
      title: 'Settings',
      icon: <SettingsFeather />,
    },
  ];

  // Use the standard Capacitor pattern: var(--safe-area-inset-x, env(safe-area-inset-x, 0px))
  // - Android: Uses --safe-area-inset-bottom injected by SystemBars (clamped to max 16px to prevent excessive spacing)
  // - iOS: Falls back to env(safe-area-inset-bottom) which works natively
  // - Web: Falls back to 0px
  const isAndroid = Capacitor.getPlatform() === 'android';
  const safeAreaBottomHeight = isAndroid
    ? 'min(var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)), 16px)' // Android: clamp to max 16px
    : 'var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))'; // iOS: use env(), web: 0px

  return (
    <div
      className="bg-muted dark:bg-muted shadow-2xl z-50"
      style={{
        // Extend to bottom edge including safe area
        // Pattern from Capacitor docs: https://capacitorjs.com/docs/apis/system-bars
        height: `calc(var(--bottom-nav-height) + ${safeAreaBottomHeight})`,
      }}
    >
      <div className="mx-auto app-max-w flex items-center justify-center h-full">
        <div className="flex items-center justify-center gap-8">
          {navItems.map((item, index) => (
            <NavButton
              key={item.id}
              onClick={() => navigate(item.path)}
              isActive={activeTab === item.id}
              title={item.title}
              icon={item.icon}
              animationVariant={index === 0 ? 'default' : 'alt'}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default BottomNavigation;
