import React, { useEffect } from 'react';
import { useLocation, useNavigate, matchPath } from 'react-router-dom';
import { Settings as SettingsFeather } from 'react-feather';
import NavButton from './NavButton';
import GossipIcon from './customIcons/gossip-icon';
import { ROUTES } from '../../constants/routes';
import { useUiStore } from '../../stores/uiStore';
import { useKeyboardVisible } from '../../hooks/useKeyboardVisible';

type BottomNavigationTab = 'discussions' | 'settings';

const BottomNavigation: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const setBottomNavVisible = useUiStore(s => s.setBottomNavVisible);
  const { isKeyboardVisible } = useKeyboardVisible();

  useEffect(() => {
    setBottomNavVisible(true);
    return () => setBottomNavVisible(false);
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

  // Hide bottom nav when keyboard is visible
  if (isKeyboardVisible) {
    return null;
  }

  return (
    <div className="bg-muted pb-safe-b">
      <div className="mx-auto app-max-w flex items-center justify-center h-bottom-nav px-nav-padding">
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
