import React, { useEffect } from 'react';
import { useLocation, useNavigate, matchPath } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Settings as SettingsFeather } from 'react-feather';
import NavButton from './NavButton';
import GossipIcon from './customIcons/gossip-icon';
import { ROUTES } from '../../constants/routes';
import { useUiStore } from '../../stores/uiStore';
import { useKeyboardStore } from '../../stores/keyboardStore';

type BottomNavigationTab = 'discussions' | 'settings';

const BottomNavigation: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const setBottomNavVisible = useUiStore(s => s.setBottomNavVisible);
  const isKeyboardVisible = useKeyboardStore(s => s.isVisible);

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
      title: t('navigation.discussions'),
      icon: <GossipIcon size={24} />,
    },
    {
      id: 'settings' as const,
      path: ROUTES.settings(),
      title: t('navigation.settings'),
      icon: <SettingsFeather />,
    },
  ];

  // Hide bottom nav when keyboard is visible
  if (isKeyboardVisible) {
    return null;
  }

  return (
    <nav className="bg-muted pb-safe-b" aria-label={t('navigation.label')}>
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
    </nav>
  );
};
export default BottomNavigation;
